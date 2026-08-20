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
 * Whether the system clock has ever been shown to agree with a corroborated satellite
 * time — because the gate found it already in agreement, or because `date` actually
 * moved it there.
 *
 * Only those two events count. A `step: true` verdict on its own does NOT, because the
 * step can fail: not running as root is the routine case, and then the gate goes on
 * asking for a step forever while the clock stays exactly as wrong as it was.
 */
let clockConfirmed = false;

/**
 * Set when something has since contradicted that confirmation — corroborated readings
 * that disagree with the time we trusted, or a step this process could not carry out.
 * Cleared the moment the clock is confirmed again.
 */
let clockContested = false;

/** How much a caller may trust the system clock, and — when it may not — why. */
export type ClockTrust = "satellite-backed" | "never-synced" | "contested";

/**
 * Whether anything may stamp a record with the system clock and be believed later.
 * src/http/waypoint.ts refuses to save a waypoint unless this says "satellite-backed".
 *
 * ⚠️ Deliberately NOT derived from the `gps_epoch_s` signal, which is the obvious way
 * and is wrong: that signal is recorded RAW, refused frames included, so one corrupt
 * frame would make a good clock look 34 years out for as long as it sat in liveState.
 *
 * ⚠️ And there is deliberately NO STALENESS BOUND here. The first version reused
 * KNOWN_GOOD_MAX_AGE_MS, which looked like the obvious constant; it is about an
 * ANCHOR, where expiry means "re-derive from scratch" and costs seconds, whereas here
 * it would mean "refuse to record anything" until a fresh reading turns up. What
 * expires this is a CONTRADICTION, not silence. Why that matters at a 3-satellite
 * fix, and the review it came out of: docs/diagnostics-and-checks.md §8.5.
 */
export function systemClockTrust(): ClockTrust {
  if (!SYNC_ENABLED) {
    // GPS_TIME_SYNC=0 says something else owns the clock — NTP on a bench, or a replay
    // on a laptop. Claiming to know better than the operator who set that would refuse
    // every waypoint on a machine whose clock is fine.
    return "satellite-backed";
  }
  if (clockContested) {
    return "contested";
  }
  return clockConfirmed ? "satellite-backed" : "never-synced";
}

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
    if (verdict.reason === "in-agreement") {
      // The one verdict that confirms the clock without touching it: several readings
      // corroborated each other, and the system clock already matches them to within
      // DRIFT_THRESHOLD_SECONDS. See systemClockTrust().
      clockConfirmed = true;
      clockContested = false;
    }
    if (verdict.reason === "disagrees-with-known-good") {
      // Corroborated readings that contradict a time we already trusted. The gate keeps
      // refusing to act on them, which is right for the clock; but for anything about to
      // stamp a record, "two sources disagree about what time it is" is precisely the
      // state in which the stamp must not be believed.
      clockContested = true;
    }
    reportQuietly(verdict);
    return;
  }

  if (process.getuid?.() !== 0) {
    // The clock IS wrong — corroborated readings say so — and this process cannot fix
    // it. That is a contradiction that will stand for the whole session, so it must not
    // leave an earlier confirmation looking current.
    clockContested = true;
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
    // Marked only after `date` returned. Until it does, the clock is still whatever it
    // was, and a verdict asking for a step is evidence against it rather than for it.
    clockConfirmed = true;
    clockContested = false;
    console.warn(
      `clock: system time was ${verdict.offsetSeconds.toFixed(1)} s off GPS (${verdict.reason}) — stepped to ${target}`
    );
  } catch (error) {
    // Not silenced, but not once per frame either. A clock that stays wrong keeps
    // being corroborated, so the gate keeps asking — by design, that is how it
    // recovers from a bad step — and if `date` itself is what is broken, that would
    // be a warning at 3.6 Hz for as long as the bike is on.
    // Same reasoning as the not-root branch: the step was needed and did not happen.
    clockContested = true;
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
