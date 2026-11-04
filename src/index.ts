import { handleMutationGuard } from "./http/mutation-guard.ts";
import { isPlausible } from "../public/lib/bounds.js";
import { configureArchiveAccess } from "./storage/archive-access.ts";
import { validBleSecret } from "../public/lib/ble-secret.js";
import { startSettings } from "./settings/startup.ts";
import { createSettingsRestart } from "./settings/restart.ts";
import { handleRecordingFlushEndpoint } from "./http/recording-flush.ts";
import { handleSettingsEndpoint } from "./http/settings.ts";
import { scanHubCandidates } from "./settings/hub-discovery.ts";
import { sampleServiceGate, restartMotionBlockers } from "./vcu/service-gate.ts";
import { ageMs, latestValue } from "./can/signals.ts";
import { effectiveHubAddress } from "./settings/schema.ts";
import { monotonicNow, since } from "./monotonic.ts";
import type { DashboardSystemStatus } from "./ws.ts";
import { createServer } from "http";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { handleDownloadEndpoint } from "./http/download.ts";
import { loadStaticFiles } from "./http/static.ts";
import { handleWaypointEndpoint } from "./http/waypoint.ts";
import { handleStatusEndpoint } from "./http/status.ts";
import { handleCanRestartEndpoint } from "./http/can-restart.ts";
import { handleUpdateEndpoint } from "./http/update.ts";
import { handleReleaseHealth } from "./http/release-health.ts";
import { handleUpdateStatus } from "./http/bundle-update.ts";
import { createOsUpdateGate } from "./os-updates.ts";
import { busHeldBy } from "./vcu/bus-lease.ts";
import { handleOsUpdateReady } from "./http/os-update-ready.ts";
import { handleBundleStop } from "./http/bundle-stop.ts";
import { managedCodeRoot, readReleaseMetadata } from "./release/metadata.ts";
import { handleDtcTableEndpoint } from "./http/dtc-table.ts";
import { handleFaultInfokeysEndpoint } from "./http/fault-infokeys.ts";
import { handleStoredDtcsEndpoint } from "./http/stored-dtcs.ts";
import { handleVcuParamsEndpoint } from "./http/vcu-params.ts";
import { handleVcuBackupEndpoint } from "./http/vcu-backup.ts";
import { handleLifetimeReadEndpoint } from "./http/lifetime-read.ts";
import { handleLifetimeStatsEndpoint } from "./http/lifetime-stats.ts";
import { handleFreezeFramesEndpoint } from "./http/freeze-frames.ts";
import { handleFreezeFrameReadEndpoint } from "./http/freeze-frame-read.ts";
import { handleExpectedFaultsEndpoint } from "./http/expected-faults.ts";
import { handleVcuReadEndpoint } from "./http/vcu-read.ts";
import { handleVcuProbeEndpoint } from "./http/vcu-probe.ts";
import { handleVcuWriteEndpoint } from "./http/vcu-write.ts";
import { createVcuReadRunner } from "./vcu/read-runner.ts";
import { createVcuWriteRunner } from "./vcu/write-runner.ts";
import { readRunningVersion } from "./version.ts";
import { startChargeAckWatch } from "./charge/ack-watch.ts";
import { loadLatestSweep, loadLatestTableType } from "./vcu/snapshot-store.ts";
import {
  KNOWN_TABLE_TYPES,
  activeParameterTable,
  describeCatalogue,
  describeTableType,
  selectParameterTable,
} from "./vcu/param-table.ts";
import { handleFanEndpoint } from "./http/fan.ts";
import { handleChargeAutoEndpoint } from "./http/charge-auto.ts";
import { startChargeAutomatic } from "./charge/auto.ts";
import { defineSignals, record } from "./can/signals.ts";
import { SIGNALS } from "./can/registry.ts";
import { startCoolantSensors } from "./sensors/max31865.ts";
import { startFanControl } from "./fan/control.ts";
import { startFanAutomatic } from "./fan/auto.ts";
import { startFanCycleGesture } from "./fan/gesture-runner.ts";
import { startHoldGestures } from "./gestures/runner.ts";
import { startWaypointFixTracking, waypointHoldGesture } from "./gps/waypoint.ts";
import { bringUpCan, openChannel } from "./can/socket.ts";
import { startCanLinkMonitor } from "./can/link-status.ts";
import { startWifiMonitor } from "./wifi/status.ts";
import { WIFI_DIAG_DIRNAME } from "./wifi/dump.ts";
import { RECOVER_TRIGGER } from "./wifi/ladder.ts";
import { recoverWifi, wifiHoldGesture, type RecoverContext } from "./wifi/recover.ts";
import { decodeFrame, STREAM_IDS } from "./can/decode.ts";
import { frameArrival } from "./can/frame-arrival.ts";
import { configurePackTemperature, resolvePackTemperatures } from "./can/pack-temperature.ts";
import { holdObdPoller, initObd, isObdResponse, handleResponse, startObdPoller } from "./can/obd.ts";
import { ELOCK_RESP_ID, isElockResponse, handleElockResponse, readKeysPairedOnce } from "./can/elock.ts";
import { syncSystemClockFromGps, systemClockTrust } from "./gps/clock.ts";
import { GPS_CAN_ID } from "./can/gps.ts";
import { handleHubMirrorFrame } from "./can/hub-mirror.ts";
import { setupWs } from "./ws.ts";
import { closeEncryptedLog, flushEncryptedLog, initEncryptedLog } from "./storage/encrypted-log.ts";
import { startSealOnPark } from "./storage/seal-on-park.ts";
import { startBleClient, type BleClient } from "./ble/client.ts";
import { startBleServer, type BleServer } from "./ble-server/server.ts";
import type { RawChannel } from "socketcan";

// Thin orchestrator: wire DB + coolant probes + CAN decode/OBD + HTTP/WS together.
// See obd-garage/INTEGRATION_PLAN.md.

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PORT = 80;
const CAN_IFACE = "can0";

// Missing bundle metadata must fail startup so the retained shell helper can roll back.
const bundleMetadata = await readReleaseMetadata(ROOT);
const settingsRuntime = await startSettings({
  codeDirectory: ROOT,
  workingDirectory: process.cwd(),
  environment: process.env,
});
configureArchiveAccess(settingsRuntime.paths);
const startup = settingsRuntime.active;
const UPDATE_DIR = ROOT;
const RIDE_LOG_DIR = startup.rideLogDirectory;
const CUSTOM_BMS_CONFIG = startup.customBmsConfigurationFlashed;
const VCU_PARAM_DIR = startup.vcuParameterDirectory;
const SERVICE_MODE_ENABLED = settingsRuntime.dataWritable;
const SERVICE_WRITE_ENABLED = settingsRuntime.dataWritable;
const CHARGE_AUTO_ENABLED = startup.automaticDcChargingEnabled;
const BLE_SECRET = startup.dashboardBluetoothSecret;
const WIFI_IFACE = "wlan0";
const WIFI_HOTSPOT_SSID = startup.phoneHotspotSsid;
const wifiContext: RecoverContext = {
  iface: WIFI_IFACE,
  hotspotSsid: WIFI_HOTSPOT_SSID,
  dumpDirectory: settingsRuntime.dataWritable ? settingsRuntime.wifiDiagnosticDirectory : null,
};
const bootSettings = settingsRuntime.store.read();
const BLE_MAC = bootSettings.kind === "ready" ? (effectiveHubAddress(bootSettings.document) ?? "") : "";
let activeHubAddress = BLE_MAC || null;
let canTrafficAt: number | null = null;
let canStartupError: string | null = null;
const canObservationStarted = monotonicNow();

// --- Which commit this is, said out loud before anything else ---
// A feature that silently does nothing and a feature deployed five days ago look identical
// from the garage. On 2026-09-07 they were the same thing. See src/version.ts.
const runningVersion = await readRunningVersion(UPDATE_DIR);
console.log(
  `cool-eva: running ${runningVersion.label}` +
    (runningVersion.trustworthy ? "" : " — ⚠️ COULD NOT VERIFY THIS AGAINST THE CHECKOUT")
);

// --- Signal registry ---
defineSignals(SIGNALS);
// Collects the acknowledgement signals from the first frame, so a command sent seconds after boot
// still has a lookback to judge against.
startChargeAckWatch();
configurePackTemperature(CUSTOM_BMS_CONFIG);
console.log(
  CUSTOM_BMS_CONFIG
    ? "bms: custom config expected — true pack temps from 0x660, 0x200 logged as batt_temp_*_vcu"
    : "bms: stock config assumed — change the BMS answer in Settings → Bike setup if needed"
);

// --- Storage: the encrypted ride log is the ONLY persistence ---
// There is no plaintext database any more: a stolen SD card must not give up
// route history or the key-fob ID. If no public key is present nothing is
// persisted at all, so say so loudly rather than silently logging into a void.
let rideLogEnabled = false;
try {
  rideLogEnabled = await initEncryptedLog({
    ...(startup.rideLogPublicKeyPem ? { publicKeyPem: startup.rideLogPublicKeyPem } : {}),
    directory: RIDE_LOG_DIR,
    clockTrust: systemClockTrust,
  });
} catch (err) {
  console.error("ride-log: init failed:", err);
}
// Parking is the only warning this bus gives before the power goes, and it is worth
// 10-442 s. ./storage/seal-on-park.ts, docs/power-cuts.md §7.
const stopSealOnPark = startSealOnPark();
if (!rideLogEnabled) {
  console.warn("=".repeat(72));
  console.warn("ride-log: NO PUBLIC KEY — nothing is being persisted. The live dashboard");
  console.warn("still works. Choose a public key under Settings → Ride recording.");
  console.warn("(generate it on the laptop: node scripts/generate-log-key.ts) and restart.");
  console.warn("=".repeat(72));
}

// --- Coolant probes (MAX31865) ---
try {
  await startCoolantSensors(startup.coolantProbesEnabled);
} catch (err) {
  console.error("coolant: init failed — continuing without coolant probes:", err);
}

// --- Cooling fan (IBT-2 half-bridge on hardware PWM) ---
// The other half of the watercooling loop, and the only thing here that drives a
// physical output on the Pi rather than reading one. It never throws — a fan that cannot
// be brought up becomes a `fault` string the endpoint reports — and it does nothing at
// all unless FAN_ENABLED=1. The loop starts in AUTOMATIC and follows the pack
// temperature; the slider takes it over until the bike is switched off, which is what
// not persisting the mode already means on a Pi with no standby power.
// docs/fan-control.md.
const fanController = await startFanControl({ enabled: startup.radiatorFanEnabled });
const fanAutomatic = startFanAutomatic(fanController);

// --- Handlebar gestures, recognised here rather than on the phone ---
// A long press of MODE ENTER steps the fan round its three states; a long press of the
// indicator-cancel switch saves a waypoint. Both used to be the dashboard's job, and the
// dashboard closes its socket whenever the page is hidden — so a phone in a pocket, which
// is every gesture worth making, recognised nothing. docs/handlebar-gestures.md.
//
// The fan's entry is only registered when there IS a fan: the same `configured` flag the
// /fan route is behind, so a Pi with no fan wired up watches one button instead of two.
const waypointFixes = startWaypointFixTracking();
const fanCycle = fanController.configured ? startFanCycleGesture(fanAutomatic) : null;
// ⚠️ The wifi hold is only offered when the poller is running: without it
// `wifi_link_state` is never recorded, and the gesture reads that signal to decide
// whether the link is up and therefore whether to touch it at all.
const holdGestures = [
  ...(fanCycle === null ? [] : [fanCycle.gesture]),
  waypointHoldGesture(),
  wifiHoldGesture(wifiContext),
];
const handlebarGestures = startHoldGestures(holdGestures);

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
  busIsActive: true,
  directory: VCU_PARAM_DIR,
});
console.log("service-mode: dashboard reads use the motorcycle's existing stationary checks");

// The write half, with its own switch and its own runner. Built here for the same
// reason the read runner is: the frame router below has to be able to hand it
// replies, and it must exist before the bus does.
const vcuWriteRunner = createVcuWriteRunner({
  channel: () => channel ?? null,
  busIsActive: true,
  enabled: SERVICE_WRITE_ENABLED,
  directory: VCU_PARAM_DIR,
  // The SAME gate the read path uses, passed in rather than re-implemented. Two
  // opinions about whether a motorcycle is safe to touch is one opinion too many.
  gate: () => vcuReadRunner.gate(),
  // ⚠️ The REAL poller hold, injected rather than imported by the runner so a check can drive
  // a clear with a fake one. Only clear-dtcs uses it: it is the one action that reads the bike
  // back on the same bus, and the always-on poller's own 0x7DF traffic would otherwise make the
  // VCU abandon the mode-03 transfer it does that with.
  holdPoller: holdObdPoller,
  // ⚠️ Every charge current about to reach the bus, hand-set or automatic, and told BEFORE the
  // frames go out — the bike answers our own commit within milliseconds, so a controller told
  // afterwards reads its own command as the rider. A hand-set one still stands it down.
  onChargeCurrentOutgoing: (amps, origin) => chargeAutomatic.noteChargeCurrentOutgoing(amps, origin),
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
console.warn(
  "service-write: reachable devices may request motorcycle changes. Existing gates and audit history apply. See Settings → Who can control my bike?"
);

try {
  await bringUpCan(CAN_IFACE, true); // ACTIVE only when we intend to TX OBD reads
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
    if (data.length === 8 && (STREAM_IDS.includes(msg.id) || isObdResponse(msg.id) || isElockResponse(msg.id))) {
      canTrafficAt = monotonicNow();
    }
    if (isObdResponse(msg.id)) {
      // ⚠️ The KERNEL's arrival stamp, taken before any of our code ran. It is the
      // only way to see how late this dispatch was, which is the question
      // docs/lifetime-battery-statistics.md exists to answer — a timestamp taken
      // inside the handler starts after libuv already delayed it.
      const arrival = frameArrival(msg);
      // Service mode's KWP replies land in this same 0x7E0–0x7EF range (the VCU
      // micros answer on 0x7E0 under EXTENDED addressing, so byte 0 is the
      // tester's own address 0xF1). Offered to the sweep first, and it consumes
      // only frames addressed to 0xF1 — which no OBD-II reply is, since byte 0
      // there is an ISO-TP length nibble — so this takes nothing away from the
      // poller. It is also a no-op unless a sweep is actually running.
      if (vcuReadRunner.handleCanFrame(msg.id, data, arrival)) {
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
    // 0x410 is a whole message stream on one id, so it has three readers and must NOT
    // return here: the diagnostics list is picked off below, and the frame then carries
    // on to decodeFrame, which is where the GPS multiplex (~1.8 Hz) and sub-type 3's
    // drive triple are decoded. Returning early would silently take CAN GPS out.
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

  initObd(channel);
  stopObd = startObdPoller(500);
  console.log("obd: polling @2Hz (speed/rpm/temps/load/distance)");
  void readKeysPairedOnce(channel);
} catch (error) {
  canStartupError = error instanceof Error ? error.message : "CAN adapter could not start";
  console.error("can: adapter/interface unavailable — dashboard remains available:", error);
}

// Polled regardless of CAN_ENABLED: the dashboard's CAN dot should show the interface's
// real state, and a bike running coolant-only still answers `ip link` (as down, or with
// no such device — both surface as red).
const canLinkMonitor = startCanLinkMonitor(CAN_IFACE);

// Polled for the same reason can0 is, and for one this project paid for on 2026-09-19:
// the Pi can only be asked what its wifi is doing while its wifi is working. Started
// HERE rather than at module scope in src/wifi/status.ts, exactly as the line above is,
// so importing that module in a check on a laptop does not shell out to an nmcli that
// is not there. docs/wifi.md.
const wifiMonitor = startWifiMonitor(WIFI_IFACE, WIFI_HOTSPOT_SSID, () => {
  // Deliberately not awaited by the poll — see startWifiMonitor. The rejection arm is
  // here because an escaped one ends the process and takes the CAN logging with it.
  // ⚠️ The outcome is NOT captured here. runLadder owns it and publishes it; a
  // refused-because-running call answers NONE, and writing that over a live outcome
  // would make the signal disagree with the counter beside it.
  void recoverWifi(wifiContext, RECOVER_TRIGGER.WATCHDOG).catch(error =>
    console.warn("wifi-recover: the watchdog ladder threw:", error)
  );
});

// --- Bluetooth: Connectivity Hub (torque/power, odometer, vehicle state, GPS) ---
let bleClient: BleClient | undefined;

if (BLE_MAC || startup.discoverHubOnce) {
  bleClient = startBleClient({
    macAddress: BLE_MAC,
    onState: state => {
      settingsRuntime.readiness.hub = state;
    },
    onConnected: address => {
      activeHubAddress = address;
      void settingsRuntime.store.learnHub(address).catch(error => {
        settingsRuntime.fault = "Connected to the motorcycle, but its address could not be saved.";
        console.warn("settings: hub address save failed", error);
      });
    },
    onValues: values => {
      for (const { key, value } of values) {
        record(key, value);
      }
    },
  });
  console.log(`ble: connecting to Connectivity Hub ${BLE_MAC || "(discovering by name)"}`);
} else {
  console.log("ble: choose the motorcycle under Settings → Connections");
}

const settingsRestart = createSettingsRestart({
  store: settingsRuntime.store,
  motionBlockers: () =>
    restartMotionBlockers(sampleServiceGate(key => ({ value: latestValue(key), ageMs: ageMs(key) }))),
});
const osUpdateGate = createOsUpdateGate(
  key => ({ value: latestValue(key), ageMs: ageMs(key) }),
  () => busHeldBy() !== null
);
const settingsHttp = {
  runtime: settingsRuntime,
  restart: settingsRestart,
  codeDirectory: managedCodeRoot(ROOT, bundleMetadata),
  version: runningVersion.label,
  readVersion: async () => (await readRunningVersion(UPDATE_DIR)).label,
  scanHubs: () => scanHubCandidates(() => settingsRuntime.readiness.hub === "Connecting"),
  drainBluetooth: async () => {
    await bleServer?.drain();
  },
  activeHubAddress: () => activeHubAddress,
  readiness: () => {
    settingsRuntime.readiness.coolant = !startup.coolantProbesEnabled
      ? "Off"
      : ["coolant_in", "coolant_out"].every(
            key =>
              ageMs(key) !== null &&
              (ageMs(key) ?? Infinity) < 15_000 &&
              isPlausible(key, latestValue(key) ?? NaN, "°C", "coolant")
          )
        ? "Reading"
        : "Unavailable — check both hose probes and wiring";
    settingsRuntime.readiness.fan = startup.radiatorFanEnabled
      ? (fanController.fault ?? "Driver ready — rotation is not measured")
      : "Off";
    settingsRuntime.readiness.recording = !settingsRuntime.dataWritable
      ? "Paused — repair data locations before retrying settings"
      : rideLogEnabled
        ? "Recording"
        : "Unavailable — choose a public key or repair the settings fault";
    settingsRuntime.readiness.bluetooth = !BLE_SECRET
      ? "Off"
      : !validBleSecret(BLE_SECRET)
        ? "Unavailable — this key needs regenerating in Settings → Connections"
        : bleServer?.ready()
          ? "Bluetooth ready"
          : "Unavailable — Bluetooth registration has not completed";
    settingsRuntime.readiness.can = systemStatus().can.message;
    return settingsRuntime.readiness;
  },
};

function systemStatus(): DashboardSystemStatus {
  const link = latestValue("can_link");
  const heardBike = canTrafficAt !== null && since(canTrafficAt) < 15_000;
  const state =
    canStartupError || link === 0
      ? "down"
      : link === 1 && heardBike
        ? "up"
        : since(canObservationStarted) < 15_000
          ? "unknown"
          : "down";
  return {
    settingsFault:
      settingsRuntime.fault ?? (settingsRestart.status().state === "failed" ? settingsRestart.status().message : null),
    can: {
      state,
      message: canStartupError
        ? "CAN adapter/interface could not start. Check the USB adapter and wiring."
        : heardBike && link === 1
          ? "Receiving motorcycle traffic"
          : "No recent recognised motorcycle traffic. The bike may be asleep; check the adapter and wiring if it is awake.",
    },
  };
}

// --- HTTP + WebSocket server ---
const staticFiles = await loadStaticFiles(join(ROOT, "public"));
console.log(
  `http: serving ${staticFiles.count} static files (${(staticFiles.bytes / 1024).toFixed(1)} kB) from memory`
);

const server = createServer(async (req, res) => {
  // Query strings are for the endpoints below; the static map is keyed by path.
  const url = new URL(req.url ?? "/", "http://localhost");
  if (shuttingDown) {
    res.writeHead(503);
    res.end("Restarting. Reconnect shortly.");
    return;
  }
  if (url.pathname === "/settings" || url.pathname.startsWith("/settings/")) {
    await handleSettingsEndpoint(req, res, url.pathname, settingsHttp);
    return;
  }
  if (handleMutationGuard(req, res, url.pathname)) return;

  if (url.pathname === "/recording/flush") {
    await handleRecordingFlushEndpoint(req, res);
    return;
  }
  if (url.pathname === "/dl") {
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
  // Bundle jobs survive this app's stop; both deployment modes reserve the same settings/bus state.
  if (url.pathname === "/update") {
    await handleUpdateEndpoint(req, res, UPDATE_DIR, settingsHttp);
    return;
  }
  if (url.pathname === "/release-health") {
    await handleReleaseHealth(res, ROOT);
    return;
  }
  if (url.pathname === "/os-update-ready") {
    handleOsUpdateReady(req, res, osUpdateGate);
    return;
  }
  if (url.pathname === "/update/reserve-stop") {
    await handleBundleStop(req, res, settingsHttp);
    return;
  }
  if (url.pathname === "/update-status") {
    await handleUpdateStatus(res);
    return;
  }
  // Duty and mode for the cooling fan. The Pi's own GPIO and PWM; it cannot reach the
  // bike's bus. Routed only when FAN_ENABLED=1, so a Pi with no fan 404s here instead of
  // offering a control that could never work.
  if (fanController.configured && url.pathname === "/fan") {
    await handleFanEndpoint(req, res, url, { controller: fanController, automatic: fanAutomatic });
    return;
  }
  // The automatic DC charge-current controller's on/off switch. Never commands a current itself —
  // everything that reaches the bus goes through /vcu-write. docs/charge-auto.md.
  if (url.pathname === "/charge-auto") {
    await handleChargeAutoEndpoint(req, res, url, chargeAutomatic);
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
  // The bike's lifetime battery statistics as last read. A file, not a bus read —
  // see the header of ./http/lifetime-stats.ts for why that is not a temporary state
  // of affairs but the shape of the thing.
  if (url.pathname === "/lifetime-stats") {
    await handleLifetimeStatsEndpoint(res, VCU_PARAM_DIR);
    return;
  }
  // …and the read that fills it, which DOES put frames on the bus. Its own path rather
  // than a POST on the reader above, so that handler can keep taking no `req` at all —
  // the same split as /vcu-params and /vcu-read.
  if (url.pathname === "/lifetime-read") {
    await handleLifetimeReadEndpoint(req, res, {
      runner: vcuReadRunner,
      directory: VCU_PARAM_DIR,
      enabled: SERVICE_MODE_ENABLED,
    });
    return;
  }
  // What the VCU recorded when each stored code set, as last read. A file, not a bus
  // read — the same reader/writer split /lifetime-stats makes, and this handler takes no
  // `req` for the same reason.
  if (url.pathname === "/freeze-frames") {
    await handleFreezeFramesEndpoint(res, VCU_PARAM_DIR);
    return;
  }
  // …and the read that fills it, which DOES put frames on the bus: the 0x18 list, then
  // 0x17 per component, bounded by its own deadline inside the poller hold.
  if (url.pathname === "/freeze-frame-read") {
    await handleFreezeFrameReadEndpoint(req, res, {
      runner: vcuReadRunner,
      directory: VCU_PARAM_DIR,
      enabled: SERVICE_MODE_ENABLED,
    });
    return;
  }
  // Which codes this bike is expected to have. A file and a rendering preference — no bus,
  // no gate; an expected code is still read, still counted and still shown.
  if (url.pathname === "/expected-faults") {
    await handleExpectedFaultsEndpoint(req, res, url, VCU_PARAM_DIR);
    return;
  }
  // Service mode. One of the endpoints that can put a frame on the bike's bus — the
  // list is in docs/diagnostics-and-checks.md §7, kept in one place because a COUNT
  // stated in four files rots the moment a fifth endpoint lands, and this one had.
  // Read-only —
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

const ws = setupWs(server, undefined, systemStatus);

// Bind the IPv4 wildcard explicitly. With the host omitted, Node binds the IPv6
// wildcard `::`, and on the Pi that listens on tcp6 only (netstat shows `:::80`, no
// `0.0.0.0:80`) — so the phone, which reaches the bike by its IPv4 wifi address, gets
// no route in. IPv4 is the whole reachability story here (garage wifi, Grafana), so
// bind it directly rather than relying on dual-stack, which is what left it tcp6-only.
server.listen(PORT, "0.0.0.0", () => {
  console.log(`HTTP + WebSocket server on http://0.0.0.0:${PORT}`);
});

// --- The same dashboard over BLE (docs/ble-server.md) ---
// A tunnel into the server above, so it can only start once that one is listening. A
// failure here is logged and survived: the wifi dashboard and the ride log must not go
// down because bluetoothd refused an advertisement.
let bleServer: BleServer | null = null;
if (BLE_SECRET) {
  server.once("listening", () => {
    startBleServer({ secret: BLE_SECRET, httpPort: PORT, system: systemStatus }).then(
      started => {
        bleServer = started;
        console.log("ble-server: serving the dashboard over BLE");
      },
      error => {
        console.warn(`ble-server: could not start, the dashboard stays wifi-only: ${(error as Error).message}`);
      }
    );
  });
} else {
  console.log("ble-server: off — configure Dashboard Bluetooth under Settings → Connections");
}

// --- Automatic DC charge current (docs/charge-auto.md) ---
// ⚠️ It commands through the write runner's own `charge-current` action, so it inherits every lock
// that door has — and is INERT unless SERVICE_WRITE_ENABLED is also 1. One transmit path.
//
// ⚠️ CONSTRUCTED AFTER THE CHANNEL, AND THE ORDERING IS LOAD-BEARING. Its SOC ring may only hold
// crossing instants, and a process's first-ever reading is not one. What keeps that reading out is
// the serial per-file `await loadStaticFiles(…)` above, which every logged boot spends longer in
// than the bus takes to deliver a `soc`. Making that read concurrent, or moving this call above it,
// hands the controller a sample it cannot stand behind; it says so in the journal when that
// happens. The measurement is in docs/dc-taper.md.
const chargeAutomatic = startChargeAutomatic(
  {
    commandChargeCurrent: async amps => {
      const answer = await vcuWriteRunner.perform({ kind: "charge-current", amps, origin: "automatic" });
      return answer.ok
        ? { succeeded: answer.result.succeeded, message: answer.result.message }
        : { succeeded: false, message: answer.reason };
    },
  },
  { enabled: CHARGE_AUTO_ENABLED }
);
console.log(
  CHARGE_AUTO_ENABLED
    ? "charge-auto: automatic current reduction is allowed; change permission in Settings → Charging"
    : "charge-auto: automatic current reduction is not allowed in startup settings"
);

// --- Graceful shutdown ---
let shuttingDown = false;
async function shutdown(): Promise<void> {
  osUpdateGate.close();
  if (shuttingDown) return;
  shuttingDown = true;
  settingsRestart.consume();
  console.log("\nShutting down…");
  stopObd?.();
  canLinkMonitor.stop();
  wifiMonitor?.stop();
  void bleClient?.stop();
  void bleServer?.stop();
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
  // Before closeEncryptedLog, so a park landing mid-shutdown cannot start a seal against a
  // log that is already being closed.
  stopSealOnPark();
  await closeEncryptedLog();
  // ⚠️ Everything that can command the fan stops BEFORE the bridge is idled — the
  // gestures, then the curve. A hold or a tick landing after the bridge has been idled
  // would re-command a duty into a process that is about to exit, and the enables would
  // then be left HIGH for the five seconds until systemd restarts it.
  handlebarGestures.stop();
  fanCycle?.stop();
  waypointFixes.stop();
  fanAutomatic.stop();
  chargeAutomatic.stop();
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
  await settingsRuntime.store.settled();
  await settingsRuntime.lock.release();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
