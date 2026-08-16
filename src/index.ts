import { createServer } from "http";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { handleDownloadEndpoint } from "./http/download.ts";
import { loadStaticFiles } from "./http/static.ts";
import { handleWaypointEndpoint } from "./http/waypoint.ts";
import { handleStatusEndpoint } from "./http/status.ts";
import { handleDtcTableEndpoint } from "./http/dtc-table.ts";
import { handleFaultInfokeysEndpoint } from "./http/fault-infokeys.ts";
import { handleStoredDtcsEndpoint } from "./http/stored-dtcs.ts";
import { handleVcuParamsEndpoint } from "./http/vcu-params.ts";
import { handleVcuBackupEndpoint } from "./http/vcu-backup.ts";
import { handleVcuReadEndpoint } from "./http/vcu-read.ts";
import { handleVcuProbeEndpoint } from "./http/vcu-probe.ts";
import { handleVcuWriteEndpoint } from "./http/vcu-write.ts";
import { createVcuReadRunner } from "./vcu/read-runner.ts";
import { createVcuWriteRunner } from "./vcu/write-runner.ts";
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

// Config (env overrides) — all of these are documented in the README's Configuration
// section, which is the copy a newcomer will actually find:
//   COOLANT_ENABLED=0 → skip the MAX31865 probes (a bike with no watercooling loop)
//   CAN_ENABLED=0 → skip CAN entirely (coolant only)
//   OBD_ENABLED=0 → passive/listen-only: decode broadcasts but don't TX OBD polls
//   ELOCK_ENABLED=0 → skip the one-shot keys-paired read from the E-LOCK ECU
//   BLE_ENABLED=0 → skip the Bluetooth link to the Connectivity Hub (torque/power,
//                   odometer, vehicle state; GPS also comes in over CAN 0x410)
//   BLE_MAC=…     → pin the hub's address (default: discover it by name)
//   GPS_TIME_SYNC=0 → never step the system clock from satellite time
//   RIDE_LOG_PUBKEY=… → X25519 public key enabling the write-only encrypted log
//   RIDE_LOG_DIR=…    → where the sealed .celog segments go
//   CUSTOM_BMS_CONFIG=1 → this pack has the custom LiBAL BMS config flashed, which lowers
//     the temperatures on 0x200 (by a config-dependent amount, not a constant) and moves
//     the true ones onto 0x660. Leave unset on a stock Energica. Only affects temperature
//     routing; every other decode is correct either way, and the frames override a wrong flag.
//   VCU_PARAM_DIR=… → where service mode leaves its parameter snapshots, which
//     /vcu-params and /vcu-backup.csv serve.
//   SERVICE_MODE_ENABLED=0 → the dashboard cannot start a parameter read. That read
//     is the one thing here that puts requests on the bike's bus on purpose, so it
//     has the same kind of off switch as every other subsystem that touches it.
//     Reading the last snapshot and exporting it are unaffected: neither goes near
//     the bike. Note this is the SECOND lock on that door — the first is
//     src/vcu/service-gate.ts, which will not let a read start unless the bike is
//     stationary and out of drive, and stops one that is running when it stops
//     being either.
//   SERVICE_WRITE_ENABLED=1 → the dashboard may CHANGE things on the bike: write one
//     of the five allowlisted calibration parameters, set the service point, sync the
//     bike's clock, or clear the stored trouble codes.
//     ⚠️ This is the only switch here that defaults to OFF, and the asymmetry is
//     deliberate. Every other subsystem's flag turns something off; this one turns
//     something on, so a Pi that has never been told about it cannot change a
//     motorcycle's calibration EEPROM. It is also SEPARATE from SERVICE_MODE_ENABLED:
//     reads and writes are not the same risk and must not share an off button.
//     Everything else still applies on top — the same safety gate, an allowlist of
//     five parameters with per-parameter ranges, a compare-and-swap against a fresh
//     read, a read-back after every write, and an audit journal in VCU_PARAM_DIR.
const CAN_ENABLED = process.env.CAN_ENABLED !== "0";
const OBD_ENABLED = process.env.OBD_ENABLED !== "0";
const ELOCK_ENABLED = process.env.ELOCK_ENABLED !== "0";
const BLE_ENABLED = process.env.BLE_ENABLED !== "0";
const BLE_MAC = process.env.BLE_MAC ?? "";
const RIDE_LOG_PUBKEY = process.env.RIDE_LOG_PUBKEY ?? join(ROOT, "ride-log-key.public.pem");
const RIDE_LOG_DIR = process.env.RIDE_LOG_DIR ?? join(ROOT, "ride-logs");
const CUSTOM_BMS_CONFIG = process.env.CUSTOM_BMS_CONFIG === "1";
const VCU_PARAM_DIR = process.env.VCU_PARAM_DIR ?? join(ROOT, "vcu-params");
const SERVICE_MODE_ENABLED = process.env.SERVICE_MODE_ENABLED !== "0";
// Opt IN, not opt out — see the note above. `=== "1"` rather than `!== "0"`.
const SERVICE_WRITE_ENABLED = process.env.SERVICE_WRITE_ENABLED === "1";

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

// --- Service mode: on-demand VCU parameter reads, started from the dashboard ---
// Built before the bus so the frame router below can hand it replies. It holds no
// bus resources, opens no socket of its own and starts nothing: it exists so that
// /vcu-read has somewhere to keep "is a sweep running" across requests, and so that
// the safety gate has one place to be asked from.
const vcuReadRunner = createVcuReadRunner({
  channel: () => channel ?? null,
  // A listen-only interface swallows every request silently, which looks exactly
  // like a switched-off bike. Refused up front instead.
  busIsActive: OBD_ENABLED,
  directory: VCU_PARAM_DIR,
});
console.log(
  SERVICE_MODE_ENABLED
    ? "service-mode: the dashboard may start an on-demand VCU parameter read while the bike is parked and out of drive (SERVICE_MODE_ENABLED=0 to forbid it)"
    : "service-mode: disabled (SERVICE_MODE_ENABLED=0) — the snapshot is still served and exported, but nothing here can ask the bike"
);

// The write half, with its own switch and its own runner. Built here for the same
// reason the read runner is: the frame router below has to be able to hand it
// replies, and it must exist before the bus does.
const vcuWriteRunner = createVcuWriteRunner({
  channel: () => channel ?? null,
  busIsActive: OBD_ENABLED,
  enabled: SERVICE_WRITE_ENABLED,
  directory: VCU_PARAM_DIR,
  // The SAME gate the read path uses, passed in rather than re-implemented. Two
  // opinions about whether a motorcycle is safe to touch is one opinion too many.
  gate: () => vcuReadRunner.gate(),
});
if (SERVICE_WRITE_ENABLED) {
  // Loud, and at WARN. A Pi in this state can change a motorcycle's calibration
  // EEPROM from a web page, and that should be visible in `journalctl` without
  // anyone going looking for it.
  console.warn(
    "service-write: ⚠️  ENABLED (SERVICE_WRITE_ENABLED=1) — the dashboard may write allowlisted VCU parameters, " +
      "set the service point, sync the bike's clock and clear stored DTCs. Every attempt is journalled to " +
      `${join(VCU_PARAM_DIR, "service-writes.jsonl")}. Unset the variable to forbid it.`
  );
} else {
  console.log(
    "service-write: disabled (default) — nothing here can change anything on the bike. SERVICE_WRITE_ENABLED=1 to allow it."
  );
}

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
        // Service mode's KWP replies land in this same 0x7E0–0x7EF range (the VCU
        // micros answer on 0x7E0 under EXTENDED addressing, so byte 0 is the
        // tester's own address 0xF1). Offered to the sweep first, and it consumes
        // only frames addressed to 0xF1 — which no OBD-II reply is, since byte 0
        // there is an ISO-TP length nibble — so this takes nothing away from the
        // poller. It is also a no-op unless a sweep is actually running.
        if (vcuReadRunner.handleCanFrame(msg.id, data)) {
          return;
        }
        // Same for a write in flight, and it needs the OBD range too: the KWP legs
        // answer on 0x7E0 and Mode 04 answers somewhere in 0x7E0–0x7EF. Only one of
        // the two runners can be busy at a time (src/vcu/bus-lease.ts), so this is
        // one extra null check per frame in the range and nothing at all otherwise.
        if (vcuWriteRunner.handleCanFrame(msg.id, data)) {
          return;
        }
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
const staticFiles = await loadStaticFiles(join(ROOT, "public"));
console.log(
  `http: serving ${staticFiles.count} static files (${(staticFiles.bytes / 1024).toFixed(1)} kB) from memory`
);

const server = createServer(async (req, res) => {
  // Query strings are for the endpoints below; the static map is keyed by path.
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname === "/dl") {
    // Seal first: you park, pull out the phone and hit /dl, and the tail of the
    // ride you actually want is still sitting in the buffer unsealed.
    await flushEncryptedLog();
    await handleDownloadEndpoint(res, RIDE_LOG_DIR);
    return;
  }
  if (url.pathname === "/waypoint") {
    handleWaypointEndpoint(res);
    return;
  }
  if (url.pathname === "/status") {
    await handleStatusEndpoint(res, RIDE_LOG_DIR, rideLogEnabled);
    return;
  }
  if (url.pathname === "/dtc-table") {
    handleDtcTableEndpoint(req, res);
    return;
  }
  // Energica's per-fault telemetry shortlists — static data, no bus, no bike.
  if (url.pathname === "/fault-infokeys") {
    handleFaultInfokeysEndpoint(req, res);
    return;
  }
  // The codes the bike currently has stored, as last read by the OBD poller. Serves
  // a snapshot and never touches the bus, so refreshing the page cannot start a
  // multiframe transfer.
  if (url.pathname === "/stored-dtcs") {
    handleStoredDtcsEndpoint(res);
    return;
  }
  // The VCU's calibration parameters, as service mode last read them. Serves the
  // snapshot from disk and never touches the bus, so refreshing the page cannot make
  // the bike answer anything.
  if (url.pathname === "/vcu-params") {
    await handleVcuParamsEndpoint(res, VCU_PARAM_DIR);
    return;
  }
  // Service mode. The ONE endpoint here that causes traffic on the bike's bus, and
  // the only path in this repo from an HTTP request to a CAN frame. Read-only —
  // src/vcu/param-codec.ts's request union cannot express a write — and gated on the
  // bike being stationary and out of drive, checked before the read starts and again
  // before every frame it sends. See src/vcu/service-gate.ts.
  if (url.pathname === "/vcu-read") {
    await handleVcuReadEndpoint(req, res, {
      runner: vcuReadRunner,
      directory: VCU_PARAM_DIR,
      enabled: SERVICE_MODE_ENABLED,
    });
    return;
  }
  // One identifier off one ECU, on demand — the replacement for the deleted script's
  // `--index N`, and the only way to reach bank 2 (live data) at all. Same header,
  // same gate and same single-flight as /vcu-read.
  if (url.pathname === "/vcu-probe") {
    await handleVcuProbeEndpoint(req, res, url, { runner: vcuReadRunner, enabled: SERVICE_MODE_ENABLED });
    return;
  }
  // ⚠️ The one endpoint here that CHANGES anything on the bike. Off unless
  // SERVICE_WRITE_ENABLED=1, behind the same safety gate as the reads, behind an
  // allowlist of five parameters with per-parameter ranges, and journalled. Its own
  // header value, so a caller built for the read endpoints cannot reach it.
  if (url.pathname === "/vcu-write") {
    await handleVcuWriteEndpoint(req, res, url, { runner: vcuWriteRunner });
    return;
  }
  // The same snapshot /vcu-params serves, in another owner's energica_tool.py
  // backup format. Serves what is on disk; never touches the bus.
  if (url.pathname === "/vcu-backup.csv") {
    await handleVcuBackupEndpoint(res, VCU_PARAM_DIR);
    return;
  }
  if (staticFiles.serve(url.pathname, res)) {
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("not found\n");
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
  // A sweep in flight is stopped rather than left to be killed with the process:
  // aborting settles the request in flight, stops the client transmitting, and
  // leaves every row it had already appended to `sweep.partial.jsonl`, so the next
  // run resumes from there. Deploy is `git pull` + `systemctl restart`, so this is
  // not a rare path.
  //
  // Awaited, like closeEncryptedLog below and for the same reason: process.exit()
  // is a few lines away and the sweep still has its archive to write.
  // Aborted rather than awaited: a write is a few hundred milliseconds of exchanges
  // and holds no file handle and no partial state of its own — unlike a sweep, which
  // has an archive to write. Its audit record is appended by the action itself, and
  // an action stopped mid-flight has already recorded whatever it got to.
  vcuWriteRunner.stop();
  await vcuReadRunner.stop();
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
