import { execFile } from "child_process";
import { promisify } from "util";
import { monotonicNow, since } from "../monotonic.ts";
import { GpsClockGate } from "./clock-gate.ts";
import type { ClockStepVerdict } from "./clock-gate.ts";

const runCommand = promisify(execFile);

// The Pi has no RTC. On a boot with no network its clock starts wherever the
// filesystem timestamp left it, so every row logged before the hotspot comes up
// is stamped years off. The bike's GPS is the only trustworthy time source out
// on the road, so once enough of its frames agree we take their word for it.
//
// This file is only the I/O half: read the two clocks, hand them to the gate,
// run `date` if it says so, and say out loud what happened. Every rule about
// WHETHER to step lives in ./clock-gate.ts, with no clock reads and no child
// processes, so it can be replayed against real captured sequences on a laptop.

const SYNC_ENABLED = process.env.GPS_TIME_SYNC !== "0";

/**
 * One gate for the process, deliberately shared by both transports. CAN 0x410 and
 * BLE carry the same hub records, so a fix that arrived twice is two readings that
 * agree — which is exactly what corroboration is looking for, and it halves the
 * time a cold boot spends waiting for a full window.
 */
const gate = new GpsClockGate();

let warnedNotRoot = false;
let failedSteps = 0;
let lastQuietReason: string | undefined;
let lastQuietReasonAt = monotonicNow();

/**
 * Steps the system clock to GPS UTC when several satellite readings agree that it
 * has drifted. Never throws — a failure here must not take the telemetry link down.
 *
 * The drift itself is not logged as a signal: `gps_epoch_s` is recorded raw
 * against every row's own timestamp, so the error is recoverable from the data
 * without storing a derived copy of it. That is also why a frame the gate refuses
 * still reaches the log — see the note on #decodeUtc in ./decode.ts.
 */
export async function syncSystemClockFromGps(gpsEpochSeconds: number): Promise<void> {
  if (!SYNC_ENABLED) {
    return;
  }

  // Date.now() for the comparison and monotonicNow() for the elapsed time, which is
  // the split ../monotonic.ts describes: the wall clock is what we are measuring and
  // about to move, so it can only be sampled, never differenced.
  const verdict = gate.offer(gpsEpochSeconds, Date.now() / 1000, monotonicNow());
  if (!verdict.step) {
    reportQuietly(verdict);
    return;
  }

  if (process.getuid?.() !== 0) {
    if (!warnedNotRoot) {
      warnedNotRoot = true;
      console.warn(
        `clock: ${verdict.offsetSeconds.toFixed(1)} s off GPS (${verdict.reason}) but not running as root — cannot set the time`
      );
    }
    return;
  }

  const target = new Date(verdict.epochSeconds * 1000).toISOString();
  try {
    // `date -u -s @<epoch>` rather than `timedatectl set-time`, which refuses
    // outright while NTP is enabled.
    await runCommand("date", ["-u", "-s", `@${Math.round(verdict.epochSeconds)}`]);
    console.warn(
      `clock: system time was ${verdict.offsetSeconds.toFixed(1)} s off GPS (${verdict.reason}) — stepped to ${target}`
    );
  } catch (error) {
    // Not silenced, but not once per frame either. A clock that stays wrong keeps
    // being corroborated, so the gate keeps asking — by design, that is how it
    // recovers from a bad step — and if `date` itself is what is broken, that would
    // be a warning at 3.6 Hz for as long as the bike is on.
    failedSteps += 1;
    if (failedSteps === 1 || failedSteps % 100 === 0) {
      console.warn(`clock: failed to set system time from GPS (attempt ${failedSteps}):`, (error as Error).message);
    }
  }
}

/** Reasons that mean the clock may never sync at all, not just "not yet". */
const ALARMING: ReadonlySet<string> = new Set([
  "not-a-time",
  "before-floor",
  "inconsistent-readings",
  "disagrees-with-known-good",
]);

/**
 * How long the same non-step reason may go unmentioned. Every state below except
 * "in-agreement" is one the clock can be stuck in forever, so a reason that stops
 * changing must not stop being said — it would be indistinguishable from the startup
 * transient that prints the identical line.
 */
const REPEAT_REASON_AFTER_MS = 300_000;

/**
 * Says why no step happened, without saying it 3.6 times a second.
 *
 * Only a CHANGE of reason is printed, plus a repeat every REPEAT_REASON_AFTER_MS so a
 * stuck state cannot masquerade as a transient one. The reasons that mean something is
 * actually wrong — a frame below the floor, a window contradicting itself, corroborated
 * readings that contradict a time we already trusted — are warnings; the two normal
 * states are logs.
 *
 * `awaiting-corroboration` in particular is a state the gate can never leave on its own
 * if the transports drift more than CONSISTENCY_TOLERANCE_SECONDS apart, and the clock
 * then simply never syncs. Never silent: a gate quietly refusing every frame is exactly
 * the failure that would otherwise look like a healthy clock.
 */
function reportQuietly(verdict: Extract<ClockStepVerdict, { step: false }>): void {
  // Keyed on the reason, not the whole line: the detail carries a live offset that
  // changes every frame, so including it would defeat the deduplication entirely.
  const changed = verdict.reason !== lastQuietReason;
  if (!changed && since(lastQuietReasonAt) < REPEAT_REASON_AFTER_MS) {
    return;
  }
  lastQuietReason = verdict.reason;
  lastQuietReasonAt = monotonicNow();
  const stillFor = changed ? "" : ` (unchanged for ${REPEAT_REASON_AFTER_MS / 60_000} min)`;
  const line = `clock: ${verdict.reason} — ${verdict.detail}${stillFor}`;
  if (ALARMING.has(verdict.reason)) {
    console.warn(line);
    return;
  }
  console.log(line);
}
