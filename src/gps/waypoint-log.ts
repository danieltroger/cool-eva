import type { WaypointRefusal } from "./waypoint.ts";

// What the bike remembers about the waypoints of THIS BOOT, so the phone can list them.
//
// ⚠️ The gates next door decide; this only remembers. ../gps/waypoint.ts kept a pair of
// counters and threw the events themselves away, which is why the dashboard could only
// ever show the last position: a phone that was asleep in a pocket for the ride — and
// ../../public/lib/connection.js closes the socket whenever the page is hidden — gets one
// snapshot on waking, carrying the newest waypoint and nothing before it.
//
// Nothing here is persistence. There is no SQLite on this bike and the encrypted ride log
// is write-only by design, so a restart is the end of this list; `waypoint_seq` restarts
// with it (docs/waypoints.md). The phone says so rather than showing an empty list.

/**
 * One thing that happened when somebody asked for a waypoint.
 *
 * A discriminated union so each arm carries what that outcome can actually know: a
 * refusal has no position (that is what was refused), and a save needs no
 * `clockTrustworthy` because ../gps/waypoint.ts refuses to save at all unless
 * `systemClockTrust()` is `satellite-backed`.
 */
export type WaypointEvent =
  | { outcome: "saved"; sequence: number; latitudeDeg: number; longitudeDeg: number; at: number }
  | {
      outcome: "refused";
      refusal: WaypointRefusal;
      at: number;
      /**
       * Whether the Pi believed its own clock when `at` was stamped.
       *
       * ⚠️ `systemClockTrust()`'s answer, NOT `checkPiClock()`'s — the same field name as
       * ../vcu/write-audit.ts's journal carries, over a different rule that can disagree
       * with this one on the same bike. This one is the gate that decides whether a
       * `saved` arm may exist at all, which is what makes it the right question here.
       *
       * It is only ever false on a refusal, and the refusal CODE cannot stand in for it:
       * the gates fire in order, so a press at a cold boot with no fix answers `NO_FIX`
       * long before the clock gate is reached. Without this the phone would print a time
       * of day off a clock the Pi itself does not believe — #59 once put it in 2060.
       */
      clockTrustworthy: boolean;
    };

/**
 * How many events are kept. The whole archive holds 97 waypoints EVER, so a boot that
 * reaches this has been asked something unusual — and the counters in ../gps/waypoint.ts
 * keep reporting the true totals either way.
 */
export const MAX_EVENTS = 50;

export interface WaypointLog {
  events: WaypointEvent[];
  maxEvents: number;
}

/**
 * A log of its own, which is what scripts/check-waypoint-list.ts drives: state in a plain
 * object passed to the module-level functions below rather than closed over, the shape
 * ../../public/lib/connection.js uses and for the same reason — the eviction rule has to be
 * exercisable without satisfying seven gates fifty-three times.
 */
export function createWaypointLog(maxEvents: number = MAX_EVENTS): WaypointLog {
  return { events: [], maxEvents };
}

/** The bike's own log, which ../http/status.ts serves. */
export const waypointLog = createWaypointLog();

export function recordSavedWaypoint(
  log: WaypointLog,
  sequence: number,
  latitudeDeg: number,
  longitudeDeg: number,
  at: number
): void {
  append(log, { outcome: "saved", sequence, latitudeDeg, longitudeDeg, at });
}

export function recordRefusedWaypoint(
  log: WaypointLog,
  refusal: WaypointRefusal,
  at: number,
  clockTrustworthy: boolean
): void {
  append(log, { outcome: "refused", refusal, at, clockTrustworthy });
}

/** A copy of the ARRAY, so a caller cannot add to or reorder the bike's own log. */
export function waypointEventsOf(log: WaypointLog): WaypointEvent[] {
  return [...log.events];
}

/**
 * Appends, and evicts if that put the log over its cap.
 *
 * ⚠️ THE OLDEST REFUSAL GOES FIRST, and a save only when there is no refusal left to drop.
 * A rider holding the switch at a cold boot with no fix can produce refusals as fast as a
 * thumb moves, and an unconditional "drop the oldest" would then evict every saved
 * waypoint of the ride — the list failing at its one job while its counters stayed
 * correct. A save is a place you cannot go back to; a refusal is news.
 *
 * Eviction removes an element and so leaves the relative order of the rest: the array is in
 * FIRE order, nothing downstream sorts it, and `at` is wall clock on a Pi that steps its own
 * from GPS (../gps/clock.ts). The extreme where the rule's own wording inverts, and what the
 * phone says then: docs/waypoints.md §"What the list can and cannot be short of".
 */
function append(log: WaypointLog, event: WaypointEvent): void {
  log.events.push(event);
  if (log.events.length <= log.maxEvents) {
    return;
  }
  const oldestRefused = log.events.findIndex(candidate => candidate.outcome === "refused");
  log.events.splice(oldestRefused === -1 ? 0 : oldestRefused, 1);
}
