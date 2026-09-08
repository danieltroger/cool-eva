// Whether a GPS fix is somewhere the bike could actually have got to.
//
// Pure arithmetic — two fixes and an interval in, an answer out, no signal lookups and no
// clock — so scripts/check-hold-gestures.ts drives every branch as a table with no timers.
// ./waypoint.ts is the half that remembers where the last fix was.
//
// TWO gates, and they see different things. The RANGE gate refuses a coordinate that is
// not a place at all, which only a decode failure produces (#167). The JUMP gate refuses
// one that is a legal place the bike cannot have got to: the 2026-08-09 waypoint carried
// longitude 130.30 while the next `gps_lon` row read 13.04, some 8 000 km away, and 130.3
// is a perfectly legal longitude — so nothing but its distance from the fix before it can
// catch that one (#165). docs/waypoints.md §"What each gate can see".

/** A position and when it arrived, on the monotonic clock. */
export interface Fix {
  latitudeDeg: number;
  longitudeDeg: number;
  /** monotonicNow() as the fix was recorded. */
  at: number;
}

/**
 * The planet. A decode failure can put a coordinate outside it; nothing else can.
 *
 * Exported because public/lib/bounds.js gates the same four signals for the dashboard and
 * cannot import this file — the dashboard has no build step. That agreement is asserted by
 * scripts/check-waypoint-endpoint.ts rather than left to trust.
 *
 * ⚠️ This refuses a NON-POSITION, and that is all — the 2026-08-09 waypoint sits 7 000 km
 * from where the bike stood and passes it, because 130.3 is a legal longitude. The gate
 * that refuses THAT one is implausibleJumpKmh() below, which is why the two live in one
 * file now. docs/waypoints.md §"What each gate can see".
 */
export const LATITUDE_RANGE: [number, number] = [-90, 90];
export const LONGITUDE_RANGE: [number, number] = [-180, 180];

/** Whether a pair of coordinates is a place at all. */
export function isPositionOnEarth(latitudeDeg: number, longitudeDeg: number): boolean {
  return (
    latitudeDeg >= LATITUDE_RANGE[0] &&
    latitudeDeg <= LATITUDE_RANGE[1] &&
    longitudeDeg >= LONGITUDE_RANGE[0] &&
    longitudeDeg <= LONGITUDE_RANGE[1]
  );
}

/**
 * Faster than this between two fixes and the newer one is a decode artefact, not a ride.
 *
 * ⚠️ NOT a guess at how fast the bike goes: it is public/lib/bounds.js's own gate on
 * `gps_speed_kmh`, so the two cannot come to disagree about what a plausible speed is.
 * This bike's top speed is 270 km/h (docs/route-map.md), so 300 cannot reject a real ride.
 */
export const MAX_PLAUSIBLE_KMH = 300;

/**
 * Two fixes closer together than this are not judged on the distance between them.
 *
 * ⚠️ THE LESSON docs/route-map.md ALREADY PAID FOR: an implied-speed test is destroyed by
 * a short denominator — 7 m in 1 ms reads as 25 000 km/h, and a first attempt at despiking
 * the archive that way rejected 4 718 steps that were all timing artefact rather than bad
 * data. One second is the GPS cadence, so a real pair straddles it.
 */
export const MIN_FIX_INTERVAL_MS = 1_000;

/**
 * The speed one fix implies since the one before it, when that speed is impossible —
 * otherwise null.
 *
 * ⚠️ Answers null, not a refusal, when there is nothing to compare against: one fix on its
 * own is not evidence of anything, and refusing the first waypoint of every boot would
 * break the case the feature is for. The residual gap is a bad FIRST fix, which nothing
 * here can see; an absolute-region rule is the follow-up issue's.
 *
 * ⚠️ One spike costs TWO refusals — itself, and the good fix after it, which is measured
 * against the spike. That is the right side to fail on: both are loud, and the one after
 * next is judged against a good pair again.
 */
export function implausibleJumpKmh(previous: Fix | null, next: Fix): number | null {
  if (previous === null) {
    return null;
  }
  const elapsedMs = next.at - previous.at;
  if (elapsedMs < MIN_FIX_INTERVAL_MS) {
    return null;
  }
  const km = distanceKm(previous, next);
  const impliedKmh = km / (elapsedMs / 3_600_000);
  return impliedKmh > MAX_PLAUSIBLE_KMH ? impliedKmh : null;
}

/** Great-circle kilometres between two fixes, on the mean Earth radius. */
export function distanceKm(from: Fix, to: Fix): number {
  const radians = Math.PI / 180;
  const meanEarthRadiusKm = 6371;
  const halfLatDelta = ((to.latitudeDeg - from.latitudeDeg) * radians) / 2;
  const halfLonDelta = ((to.longitudeDeg - from.longitudeDeg) * radians) / 2;
  const chord =
    Math.sin(halfLatDelta) ** 2 +
    Math.cos(from.latitudeDeg * radians) * Math.cos(to.latitudeDeg * radians) * Math.sin(halfLonDelta) ** 2;
  return 2 * meanEarthRadiusKm * Math.asin(Math.min(1, Math.sqrt(chord)));
}
