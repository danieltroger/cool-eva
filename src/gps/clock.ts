import { execFile } from "child_process";
import { promisify } from "util";

const runCommand = promisify(execFile);

// The Pi has no RTC. On a boot with no network its clock starts wherever the
// filesystem timestamp left it, so every row logged before the hotspot comes up
// is stamped years off. The bike's GPS is the only trustworthy time source out
// on the road, so once it disagrees badly enough we take its word for it.
const DRIFT_THRESHOLD_SECONDS = 60;

// Don't fight systemd-timesyncd: once the network is back it will discipline the
// clock properly, and a step every few seconds would thrash the DB timestamps.
const MIN_SECONDS_BETWEEN_STEPS = 300;

const SYNC_ENABLED = process.env.GPS_TIME_SYNC !== "0";

// Monotonic, NOT Date.now(): this function steps the very clock it would be
// measuring against. Stamping the wall clock here and then stepping backwards
// (the exact case this module exists for) leaves `now - lastStep` hugely
// negative, so the guard would suppress every later correction until real time
// caught up. performance.now() is unaffected by `date -s`.
let lastStepAt = 0;
let warnedNotRoot = false;

/**
 * Steps the system clock to GPS UTC when it has drifted more than a minute.
 * Never throws — a failure here must not take the telemetry link down.
 *
 * The drift itself is not logged as a signal: `gps_epoch_s` is recorded raw
 * against every row's own timestamp, so the error is recoverable from the data
 * without storing a derived copy of it.
 */
export async function syncSystemClockFromGps(gpsEpochSeconds: number): Promise<void> {
  const offsetSeconds = gpsEpochSeconds - Date.now() / 1000;

  if (!SYNC_ENABLED || Math.abs(offsetSeconds) <= DRIFT_THRESHOLD_SECONDS) {
    return;
  }
  if (performance.now() - lastStepAt < MIN_SECONDS_BETWEEN_STEPS * 1000) {
    return;
  }
  if (process.getuid?.() !== 0) {
    if (!warnedNotRoot) {
      warnedNotRoot = true;
      console.warn(`clock: ${offsetSeconds.toFixed(1)} s off GPS but not running as root — cannot set the time`);
    }
    return;
  }

  lastStepAt = performance.now();
  const target = new Date(gpsEpochSeconds * 1000).toISOString();
  try {
    // `date -u -s @<epoch>` rather than `timedatectl set-time`, which refuses
    // outright while NTP is enabled.
    await runCommand("date", ["-u", "-s", `@${Math.round(gpsEpochSeconds)}`]);
    console.warn(`clock: system time was ${offsetSeconds.toFixed(1)} s off GPS — stepped to ${target}`);
  } catch (error) {
    console.warn("clock: failed to set system time from GPS:", (error as Error).message);
  }
}
