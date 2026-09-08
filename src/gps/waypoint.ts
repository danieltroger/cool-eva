import { ageMs, latestValue, onChange, record, snapshot, type LiveValue } from "../can/signals.ts";
import type { HoldGesture } from "../gestures/runner.ts";
import { monotonicNow, since } from "../monotonic.ts";
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

/**
 * The planet. A decode failure can put a coordinate outside it; nothing else can.
 *
 * Exported because public/lib/bounds.js gates the same four signals for the dashboard and
 * cannot import this file — the dashboard has no build step. That agreement is asserted by
 * scripts/check-waypoint-endpoint.ts rather than left to trust.
 *
 * ⚠️ This refuses a NON-POSITION, and that is all — the 2026-08-09 waypoint sits 7 000 km
 * from where the bike stood and passes it, because 130.3 is a legal longitude. The gate
 * that refuses THAT one is the jump check below. docs/waypoints.md §"What each gate can
 * see" has both.
 */
export const LATITUDE_RANGE: [number, number] = [-90, 90];
export const LONGITUDE_RANGE: [number, number] = [-180, 180];

/**
 * Faster than this between two fixes and the newer one is a decode artefact, not a ride.
 *
 * ⚠️ NOT a guess at how fast the bike goes: it is `public/lib/bounds.js`'s own gate on
 * `gps_speed_kmh`, so the two cannot come to disagree about what a plausible speed is.
 * This bike's top speed is 270 km/h (docs/route-map.md), so 300 cannot reject a real
 * ride and does reject the failure this exists for — a waypoint saved on 2026-08-09 with
 * longitude 130.30 while the next `gps_lon` row read 13.04, some 8 000 km away.
 */
export const MAX_PLAUSIBLE_KMH = 300;

/**
 * Two fixes closer together than this are not judged on the distance between them.
 *
 * ⚠️ THE LESSON docs/route-map.md ALREADY PAID FOR: an implied-speed test is destroyed
 * by a short denominator — 7 m in 1 ms reads as 25 000 km/h, and a first attempt at
 * despiking the archive that way rejected 4 718 steps that were all timing artefact
 * rather than bad data. One second is the GPS cadence, so a real pair straddles it.
 */
export const MIN_FIX_INTERVAL_MS = 1_000;

/** Held to save a waypoint: the turn-signal cancel switch, pushed in (0x102 b0 bit 5). */
export const WAYPOINT_GESTURE_BUTTON = "btn_indicator_cancel";

/**
 * How long that switch must be held.
 *
 * ⚠️ 1000 ms, SHORTER than the fan gesture's 1200 ms on MODE ENTER, and the difference is
 * the bike's own doing: holding this switch turns the HAZARD LIGHTS on. The earliest
 * activation in the archive is 2.011 s after the press edge, so firing at 1000 ms leaves
 * a second for the thumb to come off before the bike does something the rider did not
 * ask for. It is also why the save fires AT the threshold rather than on the release.
 *
 * Above, it clears the longest ordinary press of this switch — 0.330 s across 775 of the
 * archive's 779, the other four being one afternoon's deliberate experiment — by 3.0×.
 * Both numbers, and why it must not be trimmed further: docs/handlebar-gestures.md.
 */
export const WAYPOINT_HOLD_MS = 1000;

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

/** The fix before the one a save would take, and when it arrived. See startWaypointFixTracking(). */
let precedingFix: { latitudeDeg: number; longitudeDeg: number; at: number } | null = null;
let latestFix: { latitudeDeg: number; longitudeDeg: number; at: number } | null = null;
let unsubscribeFixes: (() => void) | null = null;

/**
 * Starts remembering where the last fix was, which is what makes the plausibility gate
 * possible: `snapshot()` holds only the newest value, so nothing else on the Pi can say
 * whether it is a step away from the previous one or a continent.
 *
 * Called from src/index.ts and stopped with the rest, so nothing subscribes at import.
 */
export function startWaypointFixTracking(): { stop: () => void } {
  unsubscribeFixes = onChange(changed => onFixChanged(changed));
  return { stop: () => stopWaypointFixTracking() };
}

function stopWaypointFixTracking(): void {
  if (unsubscribeFixes !== null) {
    unsubscribeFixes();
    unsubscribeFixes = null;
  }
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
  const signals = snapshot();
  const latitude = signals.gps_lat;
  const longitude = signals.gps_lon;
  const now = Date.now();

  if (!latitude || !longitude) {
    return refuse(WAYPOINT_REFUSAL.NO_FIX, "No GPS fix yet — waypoint not saved.", "no GPS fix has been received");
  }

  if (!isPositionOnEarth(latitude.value, longitude.value)) {
    // Cheapest and most fundamental of the refusals, so it goes first: a fix that is not a
    // position on Earth cannot be made into one by being fresh, and the sentence is more
    // use than "GPS fix is 3 seconds old" would have been.
    const where = `${latitude.value.toFixed(3)}, ${longitude.value.toFixed(3)}`;
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

  const jump = implausibleJump(latitude.value, longitude.value);
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
  record("waypoint_lat", latitude.value, now);
  record("waypoint_lon", longitude.value, now);
  console.log(`waypoint: #${waypointCount} at ${latitude.value.toFixed(5)}, ${longitude.value.toFixed(5)}`);
  return { saved: true, message: `Waypoint ${waypointCount} saved.`, sequence: waypointCount };
}

/**
 * The waypoint's entry in src/index.ts's gesture list.
 *
 * ⚠️ It reports `ok: true` for a refusal, and that is not a lie: the gesture did what it
 * is for — it asked, and the answer was recorded and is on its way to the phone as a red
 * banner. Reporting a refused save as a failed GESTURE would put a second, wronger
 * sentence in the journal beside the accurate one src/gps/waypoint.ts already wrote.
 */
export function waypointHoldGesture(): HoldGesture {
  return {
    button: WAYPOINT_GESTURE_BUTTON,
    holdMs: WAYPOINT_HOLD_MS,
    description: "save a waypoint here",
    perform: async () => {
      const outcome = saveWaypointNow();
      return { ok: true, message: outcome.message };
    },
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
/**
 * The speed this fix implies since the preceding one, when that is impossible — else null.
 *
 * ⚠️ Answers null, not a refusal, when there is nothing to compare against: one fix on
 * its own is not evidence of anything, and refusing the first waypoint of every boot
 * would break the case the feature is for. The residual gap is therefore a bad FIRST
 * fix, which nothing here can see; an absolute-region rule is the follow-up issue's.
 */
function implausibleJump(latitudeDeg: number, longitudeDeg: number): number | null {
  if (precedingFix === null) {
    return null;
  }
  const elapsedMs = since(precedingFix.at);
  if (elapsedMs < MIN_FIX_INTERVAL_MS) {
    return null;
  }
  const km = distanceKm(precedingFix.latitudeDeg, precedingFix.longitudeDeg, latitudeDeg, longitudeDeg);
  const impliedKmh = km / (elapsedMs / 3_600_000);
  return impliedKmh > MAX_PLAUSIBLE_KMH ? impliedKmh : null;
}

/** Great-circle kilometres between two fixes. Pure arithmetic; the mean Earth radius. */
function distanceKm(fromLatDeg: number, fromLonDeg: number, toLatDeg: number, toLonDeg: number): number {
  const radians = Math.PI / 180;
  const meanEarthRadiusKm = 6371;
  const halfLatDelta = ((toLatDeg - fromLatDeg) * radians) / 2;
  const halfLonDelta = ((toLonDeg - fromLonDeg) * radians) / 2;
  const chord =
    Math.sin(halfLatDelta) ** 2 +
    Math.cos(fromLatDeg * radians) * Math.cos(toLatDeg * radians) * Math.sin(halfLonDelta) ** 2;
  return 2 * meanEarthRadiusKm * Math.asin(Math.min(1, Math.sqrt(chord)));
}

/** Whether a pair of coordinates is a place at all. */
export function isPositionOnEarth(latitudeDeg: number, longitudeDeg: number): boolean {
  return (
    latitudeDeg >= LATITUDE_RANGE[0] &&
    latitudeDeg <= LATITUDE_RANGE[1] &&
    longitudeDeg >= LONGITUDE_RANGE[0] &&
    longitudeDeg <= LONGITUDE_RANGE[1]
  );
}

function refuse(refusal: WaypointRefusal, message: string, reason: string): WaypointOutcome {
  refusedCount += 1;
  record("waypoint_refused_seq", refusedCount);
  record("waypoint_refusal", refusal);
  console.warn(`waypoint: refused, ${reason}`);
  return { saved: false, message, refusal };
}
