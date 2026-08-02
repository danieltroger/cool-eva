import { createServer } from "http";
import { readFile } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { handleDownloadEndpoint } from "./http/download.ts";
import { defineSignals, record } from "./can/signals.ts";
import { SIGNALS } from "./can/registry.ts";
import { startCoolantSensors } from "./sensors/max31865.ts";
import { bringUpCan, openChannel } from "./can/socket.ts";
import { decodeFrame, STREAM_IDS } from "./can/decode.ts";
import { configurePackTemperature, resolvePackTemperatures } from "./can/pack-temperature.ts";
import { initObd, isObdResponse, handleResponse, startObdPoller } from "./can/obd.ts";
import { ELOCK_RESP_ID, isElockResponse, handleElockResponse, readKeysPairedOnce } from "./can/elock.ts";
import { syncSystemClockFromGps } from "./gps/clock.ts";
import { GPS_CAN_ID } from "./can/gps.ts";
import { handleHubMirrorFrame } from "./can/hub-mirror.ts";
import { setupWs } from "./ws.ts";
import { closeEncryptedLog, flushEncryptedLog, initEncryptedLog } from "./storage/encrypted-log.ts";
import { startBleClient, type BleClient } from "./ble/client.ts";
import type { RawChannel } from "socketcan";

// Thin orchestrator: wire DB + coolant probes + CAN decode/OBD + HTTP/WS together.
// See obd-garage/INTEGRATION_PLAN.md.

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PORT = 80;
const CAN_IFACE = "can0";

// Config (env overrides):
//   CAN_ENABLED=0 → skip CAN entirely (coolant only)
//   OBD_ENABLED=0 → passive/listen-only: decode broadcasts but don't TX OBD polls
//   ELOCK_ENABLED=0 → skip the one-shot keys-paired read from the E-LOCK ECU
//   BLE_ENABLED=0 → skip the Bluetooth link to the Connectivity Hub (torque/power,
//                   odometer, vehicle state; GPS also comes in over CAN 0x410)
//   BLE_MAC=…     → pin the hub's address (default: discover it by name)
//   GPS_TIME_SYNC=0 → never step the system clock from satellite time
//   RIDE_LOG_PUBKEY=… → X25519 public key enabling the write-only encrypted log
//   RIDE_LOG_DIR=…    → where the sealed .celog segments go
//   CUSTOM_BMS_CONFIG=1 → this pack has the custom LiBAL BMS config flashed, which
//     shifts the temperatures on 0x200 down 15 °C and moves the true ones onto 0x660.
//     Leave unset on a stock Energica. Only affects temperature routing; every other
//     decode is correct either way, and the frames themselves override a wrong flag.
const CAN_ENABLED = process.env.CAN_ENABLED !== "0";
const OBD_ENABLED = process.env.OBD_ENABLED !== "0";
const ELOCK_ENABLED = process.env.ELOCK_ENABLED !== "0";
const BLE_ENABLED = process.env.BLE_ENABLED !== "0";
const BLE_MAC = process.env.BLE_MAC ?? "";
const RIDE_LOG_PUBKEY = process.env.RIDE_LOG_PUBKEY ?? join(ROOT, "ride-log-key.public.pem");
const RIDE_LOG_DIR = process.env.RIDE_LOG_DIR ?? join(ROOT, "ride-logs");
const CUSTOM_BMS_CONFIG = process.env.CUSTOM_BMS_CONFIG === "1";

// --- Signal registry ---
defineSignals(SIGNALS);
configurePackTemperature(CUSTOM_BMS_CONFIG);
console.log(
  CUSTOM_BMS_CONFIG
    ? "bms: custom config expected — true pack temps from 0x660, 0x200 logged as batt_temp_*_vcu"
    : "bms: stock config assumed — pack temps from 0x200 once no 0x660 has been seen (set CUSTOM_BMS_CONFIG=1 if flashed)"
);

// --- Storage: the encrypted ride log is the ONLY persistence ---
// There is no plaintext database any more: a stolen SD card must not give up
// route history or the key-fob ID. If no public key is present nothing is
// persisted at all, so say so loudly rather than silently logging into a void.
let rideLogEnabled = false;
try {
  rideLogEnabled = await initEncryptedLog({ publicKeyPath: RIDE_LOG_PUBKEY, directory: RIDE_LOG_DIR });
} catch (err) {
  console.error("ride-log: init failed:", err);
}
if (!rideLogEnabled) {
  console.warn("=".repeat(72));
  console.warn("ride-log: NO PUBLIC KEY — nothing is being persisted. The live dashboard");
  console.warn(`still works, but every reading is discarded. Put the key at ${RIDE_LOG_PUBKEY}`);
  console.warn("(generate it on the laptop: node scripts/generate-log-key.ts) and restart.");
  console.warn("=".repeat(72));
}

// --- Coolant probes (MAX31865) ---
try {
  await startCoolantSensors();
} catch (err) {
  console.error("coolant: init failed — continuing without coolant probes:", err);
}

// --- CAN: broadcast decode + OBD-II polling ---
let channel: RawChannel | undefined;
let stopObd: (() => void) | undefined;

if (CAN_ENABLED) {
  try {
    await bringUpCan(CAN_IFACE, OBD_ENABLED); // ACTIVE only when we intend to TX OBD reads
    channel = openChannel(CAN_IFACE);

    try {
      channel.setRxFilters([
        ...STREAM_IDS.map(id => ({ id, mask: 0x7ff })),
        { id: 0x7e0, mask: 0x7f0 }, // OBD responses 0x7E0–0x7EF
        { id: ELOCK_RESP_ID, mask: 0x7ff }, // E-LOCK diagnostic reply (one-shot read at startup)
      ]);
    } catch (err) {
      console.warn("can: setRxFilters failed, accepting all frames:", err);
    }

    channel.addListener("onMessage", msg => {
      const data = msg.data;
      if (isObdResponse(msg.id)) {
        handleResponse(msg.id, data);
        return;
      }
      if (isElockResponse(msg.id)) {
        handleElockResponse(data);
        return;
      }
      // 0x410 is the hub's whole message stream on one id, so it has two readers and
      // must NOT return here: the diagnostics list is picked off below, and the frame
      // then carries on to decodeFrame, which is where the GPS multiplex (~1.8 Hz) is
      // decoded. Returning early would silently take CAN GPS out.
      if (msg.id === GPS_CAN_ID) {
        handleHubMirrorFrame(data);
      }
      // resolvePackTemperatures decides whether 0x200's temperature bytes are the true
      // pack temperature or the VCU-shifted view — it depends on which BMS config is
      // on the bus, which no single frame can tell you. Until it can tell, it emits
      // nothing under batt_temp_lo/batt_temp_hi rather than guess.
      for (const { key, value } of resolvePackTemperatures(msg.id, data, decodeFrame(msg.id, data))) {
        record(key, value);
        // Satellite UTC arrives on CAN 0x410 as well as over BLE, and the Pi has no
        // RTC — so stepping the clock must not depend on the Bluetooth link being
        // up. The step itself is guarded (drift threshold, one step per 5 min), so
        // both transports calling it at ~2 Hz is harmless.
        //
        // This does widen what can move the clock: over BLE the frames came from a
        // session the hub had authorised, whereas anything on can0 with id 0x410
        // reaches here unauthenticated, and the clock stamps rows in an append-only
        // log we can't correct in place. The guards in gps/decode.ts are what stands
        // in for the authentication — fix != 0, >= 4 satellites, every field range
        // checked and a Date.UTC round trip — and injecting on the VDB bus is a
        // level of access with far better targets than our timestamps.
        if (key === "gps_epoch_s") {
          void syncSystemClockFromGps(value);
        }
      }
    });
    channel.start();
    console.log("can: channel started, decoding broadcasts");

    if (OBD_ENABLED) {
      initObd(channel);
      stopObd = startObdPoller(500);
      console.log("obd: polling @2Hz (speed/rpm/temps/load/distance)");

      // One-shot keys-paired read from the E-LOCK ECU. Needs the ACTIVE bus that
      // OBD_ENABLED brings up; fire-and-forget so it can't delay startup.
      if (ELOCK_ENABLED) {
        void readKeysPairedOnce(channel);
      } else {
        console.log("elock: disabled (ELOCK_ENABLED=0)");
      }
    } else {
      console.log("obd: disabled (OBD_ENABLED=0) — passive decode only");
    }
  } catch (err) {
    console.error("can: init failed — continuing with coolant only:", err);
  }
} else {
  console.log("can: disabled (CAN_ENABLED=0)");
}

// --- Bluetooth: Connectivity Hub (torque/power, odometer, vehicle state, GPS) ---
let bleClient: BleClient | undefined;

if (BLE_ENABLED) {
  bleClient = startBleClient({
    macAddress: BLE_MAC,
    onValues: values => {
      for (const { key, value } of values) {
        record(key, value);
      }
    },
  });
  console.log(`ble: connecting to Connectivity Hub ${BLE_MAC || "(discovering by name)"}`);
} else {
  console.log("ble: disabled (BLE_ENABLED=0)");
}

// --- HTTP + WebSocket server ---
const indexHtml = await readFile(join(ROOT, "public", "index.html"), "utf-8");

const server = createServer(async (req, res) => {
  if (req.url === "/dl") {
    // Seal first: you park, pull out the phone and hit /dl, and the tail of the
    // ride you actually want is still sitting in the buffer unsealed.
    await flushEncryptedLog();
    await handleDownloadEndpoint(res, RIDE_LOG_DIR);
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(indexHtml);
});

const ws = setupWs(server);

server.listen(PORT, () => {
  console.log(`HTTP + WebSocket server on http://0.0.0.0:${PORT}`);
});

// --- Graceful shutdown ---
let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\nShutting down…");
  stopObd?.();
  void bleClient?.stop();
  // Awaited, not fire-and-forget: sealing the last segment is async, and
  // process.exit() below would otherwise kill it and lose the final buffer.
  await closeEncryptedLog();
  try {
    channel?.stop();
  } catch (err) {
    console.log("can: channel stop failed during shutdown:", err);
  }
  ws.stop();
  server.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
