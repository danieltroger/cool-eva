import { ageMs, latestValue, onChange, record, type LiveValue } from "../can/signals.ts";
import type { HoldGesture } from "../gestures/runner.ts";
import { monotonicNow } from "../monotonic.ts";
import { implausibleJumpKmh, isPositionOnEarth, type Fix } from "./fix-plausibility.ts";
import { systemClockTrust } from "./clock.ts";

// Stamping "I am here, now" into the ride log, for both things that ask: GET /waypoint
// (../http/waypoint.ts, which Siri and the dashboard button reach) and a long press of
// the indicator-cancel switch on the bars (../gestures/runner.ts).
//
// ⚠️ ONE PATH ON PURPOSE. The gates below decide whether a position may be believed, and
// two callers deciding that separately is how a banner ends up claiming a waypoint that
// is not in the log. The HTTP shell next door only formats what this returns.
//
// Nothing new goes on the wire for the save itself — a waypoint is three ordinary
// signals, so it travels the existing path and scripts/decrypt-log.ts needs no special
// case. Position is copied into those signals rather than left implicit in whatever
// gps_lat/gps_lon was logged nearby: those carry a ~3 m deadband, so at a standstill the
// last logged fix can be minutes old. docs/diagnostics-and-checks.md §9.5.

/** A fix older than this is not where you are any more. */
export const FIX_MAX_AGE_MS = 30_000;

/** Held to save a waypoint: the turn-signal cancel switch, pushed in (0x102 b0 bit 5). */
export const WAYPOINT_GESTURE_BUTTON = "btn_indicator_cancel";

/**
 * How long that switch must be held.
 *
 * ⚠️ 500 ms since 2026-09-09, down from 1000, because the rider was letting go too early:
 * holding this switch turns the HAZARD LIGHTS on, so a thumb that is unsure stops short.
 * The cost is asymmetric and that is the whole argument — a false fire is one row that can
 * be deleted, a missed hold is a place you cannot go back to — which is why this margin is
 * 1.5× where the fan's is 4.1×.
 *
 * It clears the longest press outside one afternoon's deliberate experiment (0.330 s,
 * across 770 of the archive's 779) by 1.5×, and over the whole archive fires on 4 presses
 * against 1000 ms's 3 — all four inside an 11-second span of that experiment. The beat
 * means the thumb is really down for 500-607 ms, still a second and a half short of the
 * earliest hazard activation ever recorded. Corpus and margins: docs/handlebar-gestures.md.
 */
export const WAYPOINT_HOLD_MS = 500;

/**
 * Why a waypoint was refused, as `waypoint_refusal` carries it.
 *
 * ⚠️ These exist because the recogniser moved to the Pi. While the phone made the
 * request it read the refusal off the reply and put a red banner up; a handlebar hold
 * asks nobody, so without a code on the wire a rider gets NOTHING when a save fails —
 * holds the button, sees no banner, and rides away from a place they meant to keep.
 * public/lib/announce.js turns each of these back into the sentence that used to come
 * from the reply. The words live there; the code is what a ride log can be read for.
 */
export const WAYPOINT_REFUSAL = {
  /** No GPS fix has ever been received. */
  NO_FIX: 1,
  /** Position present but never marked as seen — see the branch below; it cannot happen. */
  FIX_NEVER_SEEN: 2,
  /** There is a fix and it is older than FIX_MAX_AGE_MS. */
  FIX_STALE: 3,
  /** The Pi's clock has never been set from satellite time. */
  CLOCK_NEVER_SYNCED: 4,
  /** The clock has been set and now disagrees with GPS. */
  CLOCK_DISAGREES: 5,
  /** The fix is too far from the one before it to have been ridden to. */
  FIX_IMPLAUSIBLE: 6,
  /** The coordinates are not a position on Earth at all — only a decode failure does this. */
  FIX_NOT_ON_EARTH: 7,
} as const;

export type WaypointRefusal = (typeof WAYPOINT_REFUSAL)[keyof typeof WAYPOINT_REFUSAL];

export interface WaypointOutcome {
  /** Whether a waypoint is now in the log. The banner's colour, and the only claim that matters. */
  saved: boolean;
  /** The sentence Siri is read out loud, and the dashboard shows verbatim. */
  message: string;
  /** Which waypoint it was, this boot. Absent when nothing was saved. */
  sequence?: number;
  /** Which gate refused. Absent when one was saved. */
  refusal?: WaypointRefusal;
}

let waypointCount = 0;
let refusedCount = 0;

/** The fix before the one a save would take, and the one it would take. */
let precedingFix: Fix | null = null;
let latestFix: Fix | null = null;

/**
 * Starts remembering where the last fix was, which is what makes the plausibility gate
 * possible: `snapshot()` holds only the newest value, so nothing else on the Pi can say
 * whether it is a step away from the previous one or a continent.
 *
 * Called from src/index.ts and stopped with the rest, so nothing subscribes at import.
 */
export function startWaypointFixTracking(): { stop: () => void } {
  return { stop: onChange(onFixChanged) };
}

/** Shifts the newest fix back one slot and takes the new one. */
function onFixChanged(changed: Record<string, LiveValue>): void {
  if (!("gps_lat" in changed) && !("gps_lon" in changed)) {
    return;
  }
  const latitudeDeg = latestValue("gps_lat");
  const longitudeDeg = latestValue("gps_lon");
  if (latitudeDeg === null || longitudeDeg === null) {
    return;
  }
  if (!Number.isFinite(latitudeDeg) || !Number.isFinite(longitudeDeg)) {
    return;
  }
  precedingFix = latestFix;
  latestFix = { latitudeDeg, longitudeDeg, at: monotonicNow() };
}

/**
 * Saves a waypoint here, now — or says which gate refused it, and records that too.
 *
 * The three gates are unchanged from when this lived in the endpoint: a fix must exist,
 * be fresh, and be stamped with a time the Pi has earned the right to claim.
 */
export function saveWaypointNow(): WaypointOutcome {
  const latitude = latestValue("gps_lat");
  const longitude = latestValue("gps_lon");
  const now = Date.now();

  if (latitude === null || longitude === null) {
    return refuse(WAYPOINT_REFUSAL.NO_FIX, "No GPS fix yet — waypoint not saved.", "no GPS fix has been received");
  }

  if (!isPositionOnEarth(latitude, longitude)) {
    // Cheapest and most fundamental of the refusals, so it goes first: a fix that is not a
    // position on Earth cannot be made into one by being fresh, and the sentence is more
    // use than "GPS fix is 3 seconds old" would have been.
    const where = `${latitude.toFixed(3)}, ${longitude.toFixed(3)}`;
    return refuse(
      WAYPOINT_REFUSAL.FIX_NOT_ON_EARTH,
      `GPS fix is not a real position (${where}) — waypoint not saved.`,
      `fix is not a position on Earth (${where})`
    );
  }

  // Monotonic age, not `now - latitude.ts`. The Pi has no RTC, so the first GPS fix of a
  // no-network boot steps the wall clock by however wrong it was — and this is reached
  // exactly then, on a bike that has just been switched on with a fresh fix. Against wall
  // time that fix reads as hours old and every waypoint is refused for the whole ride.
  const latitudeAge = ageMs("gps_lat");
  const longitudeAge = ageMs("gps_lon");
  if (latitudeAge === null || longitudeAge === null) {
    // Cannot happen while record() writes liveState and the monotonic mark together,
    // which is exactly why it must not be papered over with a sentinel: an Infinity here
    // would have Siri announce "GPS fix is Infinity seconds old".
    return refuse(
      WAYPOINT_REFUSAL.FIX_NEVER_SEEN,
      "No GPS fix yet — waypoint not saved.",
      "GPS signals present but never marked as seen"
    );
  }
  const fixAgeMs = Math.max(latitudeAge, longitudeAge);
  if (fixAgeMs > FIX_MAX_AGE_MS) {
    const seconds = Math.round(fixAgeMs / 1000);
    return refuse(
      WAYPOINT_REFUSAL.FIX_STALE,
      `GPS fix is ${seconds} seconds old — waypoint not saved.`,
      `fix is ${seconds} s old`
    );
  }

  // ⚠️ The TRACKED fix, not the live values above. The two differ by at most the 3 m
  // deadband on gps_lat/gps_lon, which is nothing against a gate about 8 000 km — and
  // this one carries the instant the fix arrived, which the live value does not.
  const jump = latestFix === null ? null : implausibleJumpKmh(precedingFix, latestFix);
  if (jump !== null) {
    return refuse(
      WAYPOINT_REFUSAL.FIX_IMPLAUSIBLE,
      "GPS fix jumped somewhere the bike cannot have ridden — waypoint not saved.",
      `fix implies ${Math.round(jump)} km/h since the previous one`
    );
  }

  // A waypoint is a place AND a time, and the time is the half this bike is bad at. The
  // Pi has no RTC, so before the first GPS sync the clock is wherever the filesystem left
  // it — and #59 documents a corrupt hub frame that once put it in 2060 and stamped
  // 49 772 rows with it. A position saved against either is worse than no waypoint: it is
  // a waypoint that will be believed.
  //
  // The two refusals are worded apart because the rider's options are not the same. "Not
  // yet" is waited out; "disagrees" will not fix itself and wants the journal.
  const trust = systemClockTrust();
  if (trust !== "satellite-backed") {
    return trust === "never-synced"
      ? refuse(
          WAYPOINT_REFUSAL.CLOCK_NEVER_SYNCED,
          "Bike's clock has not synced to GPS yet — waypoint not saved.",
          "system clock is never-synced"
        )
      : refuse(
          WAYPOINT_REFUSAL.CLOCK_DISAGREES,
          "Bike's clock disagrees with GPS — waypoint not saved.",
          `system clock is ${trust}`
        );
  }

  waypointCount += 1;
  // Sequence first: a reader scanning the log in order sees the marker before the
  // coordinates it labels, and the count is what the dashboard watches to notice that a
  // waypoint was saved by something other than its own button.
  record("waypoint_seq", waypointCount, now);
  record("waypoint_lat", latitude, now);
  record("waypoint_lon", longitude, now);
  console.log(`waypoint: #${waypointCount} at ${latitude.toFixed(5)}, ${longitude.toFixed(5)}`);
  return { saved: true, message: `Waypoint ${waypointCount} saved.`, sequence: waypointCount };
}

/**
 * The waypoint's entry in src/index.ts's gesture list.
 *
 * ⚠️ A refusal is not a failed gesture: the hold did what it is for — it asked, and the
 * answer is recorded and on its way to the phone as a red banner. The sentence it returns
 * is saveWaypointNow()'s own, so the journal says which gate refused.
 */
export function waypointHoldGesture(): HoldGesture {
  return {
    button: WAYPOINT_GESTURE_BUTTON,
    holdMs: WAYPOINT_HOLD_MS,
    description: "save a waypoint here",
    perform: async () => saveWaypointNow().message,
  };
}

/** How many waypoints this boot — for /status. */
export function waypointsSaved(): number {
  return waypointCount;
}

/**
 * Records a refusal and returns it.
 *
 * ⚠️ A COUNTER AS WELL AS A CODE, and the counter first. record() seals a row only when
 * the value differs from the last logged one, so two identical refusals in a row would
 * write nothing the second time and raise no change event — the trap
 * docs/can-decode-findings.md §"…re-selecting the value you already had" documents. The
 * rider holding the button again at the same spot with the same stale fix would get
 * silence and read it as success.
 */
function refuse(refusal: WaypointRefusal, message: string, reason: string): WaypointOutcome {
  refusedCount += 1;
  record("waypoint_refused_seq", refusedCount);
  record("waypoint_refusal", refusal);
  console.warn(`waypoint: refused, ${reason}`);
  return { saved: false, message, refusal };
}
