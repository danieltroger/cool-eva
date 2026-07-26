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

let lastStepAtMs = 0;
let warnedNotRoot = false;

/**
 * Steps the system clock to GPS UTC when it has drifted more than a minute.
 * Never throws — a failure here must not take the telemetry link down.
 *
 * @returns the Pi's clock error in seconds (GPS minus system), for logging.
 */
export async function syncSystemClockFromGps(gpsEpochSeconds: number): Promise<number> {
  const offsetSeconds = gpsEpochSeconds - Date.now() / 1000;

  if (!SYNC_ENABLED || Math.abs(offsetSeconds) <= DRIFT_THRESHOLD_SECONDS) {
    return offsetSeconds;
  }
  if (Date.now() - lastStepAtMs < MIN_SECONDS_BETWEEN_STEPS * 1000) {
    return offsetSeconds;
  }
  if (process.getuid?.() !== 0) {
    if (!warnedNotRoot) {
      warnedNotRoot = true;
      console.warn(`clock: ${offsetSeconds.toFixed(1)} s off GPS but not running as root — cannot set the time`);
    }
    return offsetSeconds;
  }

  lastStepAtMs = Date.now();
  const target = new Date(gpsEpochSeconds * 1000).toISOString();
  try {
    // `date -u -s @<epoch>` rather than `timedatectl set-time`, which refuses
    // outright while NTP is enabled.
    await runCommand("date", ["-u", "-s", `@${Math.round(gpsEpochSeconds)}`]);
    console.warn(`clock: system time was ${offsetSeconds.toFixed(1)} s off GPS — stepped to ${target}`);
  } catch (error) {
    console.warn("clock: failed to set system time from GPS:", (error as Error).message);
  }
  return offsetSeconds;
}
