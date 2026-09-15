// @ts-check

import { isPlausible } from "./bounds.js";
import { ageInWords, clockTime } from "./format.js";
import { WAYPOINT_REFUSAL_TEXT, foldAnnouncement } from "./announce.js";

/** @typedef {import("../../src/gps/waypoint-log.ts").WaypointEvent} WaypointEvent */

// Turning the bike's own record of this boot's waypoints into rows, and deciding when to
// go and ask for it again. Pure: scripts/check-waypoint-list.ts drives THE WORDS THE PHONE
// USES rather than a replica of them.
//
// ⚠️ The rows come from /status, never from the `waypoint_*` signals. The store holds the
// latest value of each signal and nothing before it, and the socket is closed for every
// moment the page is hidden (./connection.js) — so a phone that spent the ride in a pocket
// knows about exactly one of the six waypoints saved on it. The signals' only job here is
// to notice that something happened, in shouldRefreshOnWaypoint() below.

/**
 * One line of the list.
 *
 * @typedef {object} WaypointRow
 * @property {"saved" | "refused" | "unknown"} outcome
 * @property {string} mark `#4`, or `refused` — the left-hand column
 * @property {string} text the position, or the sentence saying why there is none
 * @property {boolean} fault the position failed ./bounds.js and is shown as a fault
 * @property {string} when time of day and age, or "at an unknown time"
 */

/**
 * The served events as rows, newest first.
 *
 * ⚠️ REVERSED, never sorted. `at` is the Pi's wall clock and the Pi steps it from GPS
 * (src/gps/clock.ts), so events either side of a step are not in time order — but the
 * array is in FIRE order by construction (src/gps/waypoint-log.ts), which is the order a
 * rider means by "newest".
 *
 * ⚠️ Never throws, whatever the payload holds: VanJS catches a throw inside a binding and
 * keeps the DOM the last run returned, so the list would freeze rather than show an error.
 *
 * @param {WaypointEvent[] | undefined} events
 * @returns {WaypointRow[]}
 */
export function waypointRows(events) {
  if (!Array.isArray(events)) {
    return [];
  }
  return [...events].reverse().map(rowFor);
}

/**
 * What the list says about itself, under the rows.
 *
 * TWO truncations can be in play and they must not be conflated: the bike keeps
 * `MAX_EVENTS` (src/gps/waypoint-log.ts, evicting refusals before saves), and the view
 * shows a few of those with the rest behind a toggle. The counts are the true totals
 * either way, which is what lets this say what is missing instead of quietly being short.
 *
 * @param {object} counts
 * @param {WaypointEvent[] | undefined} counts.events what the bike served
 * @param {number} counts.savedTotal `waypoints` — saves this boot, uncapped
 * @param {number} counts.refusedTotal `waypointsRefused` — refusals this boot, uncapped
 * @param {number} counts.rowsShown how many rows are on screen right now
 */
export function waypointListSummary({ events, savedTotal, refusedTotal, rowsShown }) {
  if (!Number.isFinite(savedTotal) || !Number.isFinite(refusedTotal)) {
    // Said rather than rendered as "undefined saved": a payload missing its counts is the
    // phone and the Pi disagreeing about the shape, and the rows above may be short.
    return "The bike did not say how many waypoints it has.";
  }
  if (savedTotal === 0 && refusedTotal === 0) {
    return "No waypoints since the bike last started.";
  }
  const held = Array.isArray(events) ? events : [];
  const savedHeld = held.filter(event => event?.outcome === "saved").length;
  let sentence = `${savedTotal} saved · ${refusedTotal} refused since the bike last started`;
  if (rowsShown < held.length) {
    sentence += ` · showing the newest ${rowsShown}`;
  }
  // Which of the two truncations is speaking. The bike drops refusals first, so saves
  // going missing means it has dropped those too and the list is no longer the ride.
  if (savedHeld < savedTotal) {
    sentence += ` · the bike kept only the newest ${savedHeld} saves`;
  } else if (held.length < savedTotal + refusedTotal) {
    sentence += " · the bike dropped its oldest refusals";
  }
  return `${sentence}.`;
}

/** Said whatever the counts are, because an empty list is not evidence of an empty ride. */
export const WAYPOINT_HISTORY_NOTE =
  "The bike forgets these when it restarts — earlier rides are in the ride log, not here.";

/**
 * What the refresh remembers of BOTH counters. See foldAnnouncement() for `baselined`.
 * @typedef {{ value: number | null, baselined: boolean }} CounterMemory
 * @typedef {{ saved: CounterMemory, refused: CounterMemory }} WaypointMemory
 */

/** A memory that has heard nothing yet. @returns {WaypointMemory} */
export function blankWaypointMemory() {
  return { saved: { value: null, baselined: false }, refused: { value: null, baselined: false } };
}

/**
 * Whether the list should be fetched again.
 *
 * ⚠️ BOTH COUNTERS, as ./announce.js folds them: a refusal moves only its own — `refuse()`
 * in src/gps/waypoint.ts never touches `waypoint_seq` — and "did my press land?" is the
 * question this list is for.
 *
 * ⚠️ It folds on the VALUE rather than on the re-run, and it does NOT re-baseline on a
 * dropped link where the banner does. Both mechanisms, and what each costs if reversed:
 * docs/dashboard-decisions.md §"The waypoint list".
 *
 * @param {WaypointMemory} memory
 * @param {{ saved: number | null, refused: number | null }} counters `waypoint_seq`, `waypoint_refused_seq`
 * @param {boolean} sheetIsOpen sampled, never subscribed — see ./store.js §peek
 * @returns {{ memory: WaypointMemory, refresh: boolean }}
 */
export function shouldRefreshOnWaypoint(memory, counters, sheetIsOpen) {
  const saved = foldAnnouncement(memory.saved, counters.saved);
  const refused = foldAnnouncement(memory.refused, counters.refused);
  return {
    // Advanced whether or not anything is fetched, so a press made with the sheet shut is
    // remembered rather than re-announcing itself the moment it opens — which openSheet()
    // has already refreshed for.
    memory: { saved: saved.state, refused: refused.state },
    refresh: (saved.announce || refused.announce) && sheetIsOpen,
  };
}

/**
 * @param {WaypointEvent} event
 * @returns {WaypointRow}
 */
function rowFor(event) {
  if (event?.outcome === "saved") {
    return savedRow(event.sequence, event.latitudeDeg, event.longitudeDeg, event.at);
  }
  if (event?.outcome === "refused") {
    return refusedRow(event.refusal, event.at, event.clockTrustworthy);
  }
  // Shown rather than dropped: a record this dashboard cannot read is a disagreement
  // between the phone and the Pi, and hiding it would leave the count saying one thing
  // and the list another with nothing to point at.
  return {
    outcome: "unknown",
    mark: "?",
    text: "The bike sent a record this dashboard cannot read.",
    fault: true,
    when: ageInWords(null),
  };
}

/**
 * ⚠️ Gated here rather than trusted. ./store.js runs isPlausible() over everything that
 * arrives on the WebSocket, and these rows do not arrive on the WebSocket — they come over
 * HTTP and reach the screen without passing it. Nothing the Pi can currently serve fails
 * (src/gps/fix-plausibility.ts refuses the same ranges before a waypoint is ever saved), so
 * this is the gate for the day the payload changes, and the value is SHOWN as a fault
 * rather than dropped or clamped, per CLAUDE.md.
 *
 * @param {number} sequence
 * @param {number} latitudeDeg
 * @param {number} longitudeDeg
 * @param {number} at
 * @returns {WaypointRow}
 */
function savedRow(sequence, latitudeDeg, longitudeDeg, at) {
  const where = `${degrees(latitudeDeg)}, ${degrees(longitudeDeg)}`;
  const believable =
    isPlausible("waypoint_lat", latitudeDeg, "°", "waypoint") &&
    isPlausible("waypoint_lon", longitudeDeg, "°", "waypoint");
  return {
    outcome: "saved",
    mark: `#${sequence}`,
    text: believable ? where : `${where} — not a position on Earth`,
    fault: !believable,
    when: `${clockTime(at)} · ${ageInWords(at)}`,
  };
}

/**
 * @param {number} refusal
 * @param {number} at
 * @param {boolean} clockTrustworthy
 * @returns {WaypointRow}
 */
function refusedRow(refusal, at, clockTrustworthy) {
  return {
    outcome: "refused",
    mark: "refused",
    // The same map the banner is worded from, imported rather than copied: a row and the
    // toast that appeared when it happened must not be able to say different things.
    text: WAYPOINT_REFUSAL_TEXT[refusal] ?? "Waypoint not saved.",
    fault: false,
    // ⚠️ No time of day when the Pi did not believe its own clock — src/gps/waypoint-log.ts
    // §clockTrustworthy. ageInWords(null) is where "at an unknown time" already lives, so
    // the two cannot drift apart.
    when: clockTrustworthy ? `${clockTime(at)} · ${ageInWords(at)}` : ageInWords(null),
  };
}

/**
 * Six decimals, which is 11 cm and what the ALL tab already shows a position at — this is
 * the screen you read one out from. The tile above shows four, for a glance.
 * @param {number} value
 */
function degrees(value) {
  return Number.isFinite(value) ? value.toFixed(6) : String(value);
}
