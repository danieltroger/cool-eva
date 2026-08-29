import { createServer } from "http";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { handleDownloadEndpoint } from "./http/download.ts";
import { loadStaticFiles } from "./http/static.ts";
import { handleWaypointEndpoint } from "./http/waypoint.ts";
import { handleStatusEndpoint } from "./http/status.ts";
import { handleCanRestartEndpoint } from "./http/can-restart.ts";
import { handleUpdateEndpoint } from "./http/update.ts";
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
import { loadLatestSweep, loadLatestTableType } from "./vcu/snapshot-store.ts";
import {
  KNOWN_TABLE_TYPES,
  activeParameterTable,
  describeCatalogue,
  describeTableType,
  selectParameterTable,
} from "./vcu/param-table.ts";
import { handleFanEndpoint } from "./http/fan.ts";
import { defineSignals, record } from "./can/signals.ts";
import { SIGNALS } from "./can/registry.ts";
import { startCoolantSensors } from "./sensors/max31865.ts";
import { startFanControl } from "./fan/control.ts";
import { bringUpCan, openChannel } from "./can/socket.ts";
import { startCanLinkMonitor } from "./can/link-status.ts";
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
// Where the menu's "Update" button runs `git pull`: this checkout, wherever it is.
// ROOT is derived from the running file's own path, so it is the right directory
// whatever it is named — CLAUDE.md notes an existing Pi kept the pre-rename name.
const UPDATE_DIR = process.env.UPDATE_DIR ?? ROOT;

// Config (env overrides). README's Configuration section is the full table; this indexes it:
//   COOLANT_ENABLED=0 → skip the MAX31865 probes (a bike with no watercooling loop)
//   FAN_ENABLED=1 → ⚠️ OPT IN. Drive the IBT-2 cooling fan and route /fan (docs/fan-control.md)
//   CAN_ENABLED=0 → skip CAN entirely (coolant only)
//   OBD_ENABLED=0 → passive/listen-only: decode broadcasts but don't TX OBD polls
//   ELOCK_ENABLED=0 → skip the one-shot keys-paired read from the E-LOCK ECU
//   BLE_ENABLED=0 / BLE_MAC=… → skip the Connectivity Hub link, or pin its address
//   GPS_TIME_SYNC=0 → never step the system clock from satellite time
//   RIDE_LOG_PUBKEY=… / RIDE_LOG_DIR=… → the X25519 public key that enables the
//     write-only encrypted log, and where its sealed .celog segments go
//   CUSTOM_BMS_CONFIG=1 → only with the custom LiBAL BMS config flashed; moves the
//     true pack temperatures onto 0x660. Leave unset on a stock Energica.
//   VCU_PARAM_DIR=… → where service mode leaves its parameter snapshots
//   SERVICE_MODE_ENABLED=0 → no parameter read from the dashboard; the snapshot is still served
//   SERVICE_WRITE_ENABLED=1 → ⚠️ OPT IN, the other one. The dashboard may CHANGE the bike; see below.
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
// ⚠️ OPT IN, NOT OPT OUT — `=== "1"`, not `!== "0"`, and the asymmetry is deliberate:
// every flag above except FAN_ENABLED turns something off, these two turn something on,
// so a Pi nobody has told about it cannot change a motorcycle's EEPROM. Separate
// from SERVICE_MODE_ENABLED because reads and writes are not the same risk and must
// not share an off button. ⚠️ And it cannot satisfy src/vcu/table-gate.ts: a PARAMETER
// write stays refused until a sweep has read both TABLE_TYPE copies, which on this
// bike it never has. README, "Changing something on the bike".
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

// --- Cooling fan (IBT-2 half-bridge on hardware PWM) ---
// The other half of the watercooling loop, and the only thing here that drives a
// physical output on the Pi rather than reading one. It never throws — a fan that cannot
// be brought up becomes a `fault` string the endpoint reports — and it does nothing at
// all unless FAN_ENABLED=1. Phase 1 is manual duty from the dashboard; there is no
// temperature curve. docs/fan-control.md.
const fanController = await startFanControl();

// --- CAN: broadcast decode + OBD-II polling ---
let channel: RawChannel | undefined;
let stopObd: (() => void) | undefined;

// --- Which of Energica's parameter tables is this bike running? ---
// Asked once at startup from the last sweep's snapshot, so a Pi that has already met
// this motorcycle names its parameters correctly from the first page load rather than
// from the next sweep. src/vcu/snapshot-store.ts re-asks at the end of every sweep.
//
// ⚠️ Nothing here permits anything. A bike whose table this software does not carry, or
// whose two micros have never both answered, still reads fine and still cannot be
// written to — src/vcu/table-gate.ts decides that separately and from the raw words the
// bike sent, not from what was selected here.
const startupTableReport = await loadLatestTableType(VCU_PARAM_DIR);
if (startupTableReport === null) {
  console.log(
    `vcu-table: no parameter snapshot in ${VCU_PARAM_DIR}, so parameters are named from ` +
      `${describeTableType(activeParameterTable().tableType)} until a sweep says otherwise. ` +
      `${KNOWN_TABLE_TYPES.length} tables carried.`
  );
} else {
  // ⚠️ EVERY finding, not only the ones with a catalogue attached. `unusable` — a micro
  // that answered with a record the width column forbids — used to fall through to "no
  // snapshot names a parameter table", which is untrue and drops the one line saying the
  // record framing of that whole sweep is in question. The page has always treated it as
  // alarming and the gate gives it its own state; the boot journal was the only surface
  // still quiet about it.
  if (!startupTableReport.confirmed) {
    for (const line of startupTableReport.lines) {
      console.warn(`vcu-table: ${line}`);
    }
  }
  // ⚠️ Branching on the report's own findings rather than on whether selection failed.
  // `tableType` is null in both these cases — it only ever holds a table the catalogue
  // resolved — so `selectParameterTable` could never have reported the problem, and a
  // branch keyed on that would have been unreachable while the newcomer bike it exists
  // for fell through to "no snapshot names a parameter table". Which is untrue and
  // useless: the bike named one, twice.
  //
  // The whole catalogue, once, and ONLY here. This is the moment an owner needs it:
  // every name on their page is another table's, and the useful question is which of
  // ours is nearest theirs (a neighbouring revision usually differs at a handful of ids;
  // the other side of the RegenFade split differs at 25). 28 lines at every boot would
  // be noise; 28 lines when the tool has just said it cannot describe your motorcycle is
  // the answer.
  if (startupTableReport.mismatched || startupTableReport.split) {
    console.warn("vcu-table: the tables this build carries, for comparison —");
    for (const line of describeCatalogue()) {
      console.warn(`  ${line}`);
    }
  }
  if (startupTableReport.tableType === null) {
    console.log(
      `vcu-table: nothing in ${VCU_PARAM_DIR} names one parameter table this software carries, so parameters are ` +
        `named from ${describeTableType(activeParameterTable().tableType)} until a sweep says otherwise. ` +
        `${KNOWN_TABLE_TYPES.length} tables carried.`
    );
  } else {
    selectParameterTable(startupTableReport.tableType);
  }
}

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
  // ⚠️ The last sweep's snapshot, which the write half asks two things of.
  //
  // Which of Energica's parameter tables this bike runs: a parameter is written BY INDEX
  // and an index only means a parameter relative to a table, so a write is refused unless
  // both micros named a table this software carries — see src/vcu/table-gate.ts.
  //
  // And what the bike holds for each writable parameter, so a sweep that has just read
  // all 277 of them does not leave the write form saying "not read yet" and asking for
  // one of them again.
  //
  // Read per attempt rather than at startup, so a sweep that runs while the sheet is
  // open opens the gate and fills in the values without restarting the service.
  latestSweep: () => loadLatestSweep(VCU_PARAM_DIR),
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

// Polled regardless of CAN_ENABLED: the dashboard's CAN dot should show the interface's
// real state, and a bike running coolant-only still answers `ip link` (as down, or with
// no such device — both surface as red).
const canLinkMonitor = startCanLinkMonitor(CAN_IFACE);

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
    handleWaypointEndpoint(res, req.headers.accept);
    return;
  }
  if (url.pathname === "/status") {
    await handleStatusEndpoint(res, RIDE_LOG_DIR, rideLogEnabled);
    return;
  }
  // Re-up can0 after the link has dropped — the "CAN bus restart" recovery button on
  // the menu sheet. Reconfigures the Pi's own interface; never touches the bike's bus.
  if (url.pathname === "/can-restart") {
    await handleCanRestartEndpoint(req, res, CAN_IFACE);
    return;
  }
  // `git pull` the checkout on the Pi — the menu's "Update" button — then restart the
  // service so the new code takes effect.
  if (url.pathname === "/update") {
    await handleUpdateEndpoint(req, res, UPDATE_DIR);
    return;
  }
  // Manual duty for the cooling fan. The Pi's own GPIO and PWM; it cannot reach the
  // bike's bus. Routed only when FAN_ENABLED=1, so a Pi with no fan 404s here instead of
  // offering a control that could never work.
  if (fanController.configured && url.pathname === "/fan") {
    await handleFanEndpoint(req, res, url, { controller: fanController });
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

// Bind the IPv4 wildcard explicitly. With the host omitted, Node binds the IPv6
// wildcard `::`, and on the Pi that listens on tcp6 only (netstat shows `:::80`, no
// `0.0.0.0:80`) — so the phone, which reaches the bike by its IPv4 wifi address, gets
// no route in. IPv4 is the whole reachability story here (garage wifi, Grafana), so
// bind it directly rather than relying on dual-stack, which is what left it tcp6-only.
server.listen(PORT, "0.0.0.0", () => {
  console.log(`HTTP + WebSocket server on http://0.0.0.0:${PORT}`);
});

// --- Graceful shutdown ---
let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\nShutting down…");
  stopObd?.();
  canLinkMonitor.stop();
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
  //
  // ⚠️ BEFORE the fan, irreversible data first. There is no TimeoutStopSec in the unit,
  // so systemd's 90 s default is what a wedged sysfs write or a hung `pinctrl` costs —
  // and it would cost it out of this call's budget. A lost ride-log segment is
  // unrecoverable; a fan left spinning has the config.txt `gpio=` lines and a five-second
  // `Restart=on-failure` behind it.
  await closeEncryptedLog();
  // Awaited, and before the process goes: this is the only output this service drives.
  // Deploy is `git pull` + `systemctl restart`, so leaving a fan spinning behind a dead
  // process is a routine path rather than a rare one. A SIGKILL skips this — but the unit
  // restarts in five seconds and openFanPwm() drops the enables first thing, with the
  // config.txt `gpio=17,op,dl` lines as the backstop if it never comes back.
  await fanController.stop();
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
