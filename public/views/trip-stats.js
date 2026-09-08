// @ts-check

import van from "../vendor/van-1.6.1.js";
import { chartTick, signalState, valueOf } from "../lib/store.js";
import { averageMovingSpeedKmh, distanceKm, movingTimeSeconds, topSpeed } from "../lib/trip.js";
import { clockTime, compass, duration } from "../lib/format.js";
import * as units from "../lib/units.js";

const { div } = van.tags;

// The menu sheet's "This session" grid — what this ride has done so far, and where the
// last waypoint was. Split out of views/sheet.js when that file passed the ~400 lines
// CLAUDE.md allows; it is also the sheet's one read-only section, next to a file that is
// otherwise controls.

/** @typedef {import("../../src/http/status.ts").StatusPayload} StatusPayload */

/**
 * ⚠️ The Waypoints tile asks /status whether ANY waypoint belongs to the running service,
 * and the store cannot answer that. apply() in lib/store.js merges each snapshot into what
 * it already holds and never drops a key the snapshot omits, so a service restart leaves
 * the previous boot's waypoint in the page looking current — and `waypoint_*` are
 * on-demand signals, absent from every snapshot until one is saved. /status carries the
 * count for THIS boot (waypointsSaved() in src/http/waypoint.ts) and the sheet refreshes
 * it whenever it opens, which is the only way this tile is ever looked at. A sheet left
 * open THROUGH a restart still shows the old one until it is reopened.
 *
 * @param {import("../vendor/van-1.6.1.js").State<StatusPayload | null>} status
 *   the sheet's /status state, refreshed each time the sheet opens. Passed in rather than
 *   imported so this file does not reach back into the one that renders it.
 */
export function TripStats(status) {
  return div(
    { class: "stats" },
    Stat("Distance", () => {
      chartTick.val;
      const travelledKm = distanceKm();
      return travelledKm == null ? "–" : `${units.distance(travelledKm).toFixed(1)} ${units.distanceUnit()}`;
    }),
    Stat("Moving", () => {
      chartTick.val;
      return duration(movingTimeSeconds());
    }),
    Stat("Average", () => {
      chartTick.val;
      const average = averageMovingSpeedKmh();
      return average == null ? "–" : `${units.speed(average).toFixed(0)} ${units.speedUnit()}`;
    }),
    Stat("Top", () => {
      chartTick.val;
      return `${units.speed(topSpeed()).toFixed(0)} ${units.speedUnit()}`;
    }),
    Stat("Altitude", () => {
      const metres = valueOf("gps_altitude_m");
      return metres == null ? "–" : `${Math.round(units.altitude(metres))} ${units.altitudeUnit()}`;
    }),
    Stat("Heading", () => compass(valueOf("gps_course_deg"))),
    // Where the last waypoint was and when, rather than a count. The count is still here
    // as the `#`, but on its own it was a claim about the ride that a restart made false:
    // waypoint_* live only in the server's liveState, so after a restart with none saved
    // the old tile said "0" for a ride that may have had a dozen. Now it says so.
    Stat(
      "Waypoints",
      () => {
        // Read before deciding, always. VanJS re-collects a binding's dependencies from
        // the reads its last run made, so a run that returns above these two leaves the
        // tile subscribed to `status` alone — measured against the vendored van: the
        // guarded shape runs once and never again while the guard holds, however often
        // the signals change, while this shape re-runs on each. It does recover when
        // /status next changes, which the save path now forces, but a tile that is only
        // correct because something else refreshes is a trap for the next editor.
        const latitude = valueOf("waypoint_lat");
        const longitude = valueOf("waypoint_lon");
        if (noneSinceRestart(status) || latitude == null || longitude == null) {
          return "–";
        }
        // Four decimals is 11 m, which is enough to know which lay-by; the ALL tab has
        // the full six if you are reading one out to somebody.
        return `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
      },
      () => {
        // signalState rather than valueOf: this line needs the reading's timestamp, which
        // valueOf drops. Read first, for the reason above.
        const saved = signalState("waypoint_seq").val;
        const countedThisBoot = status.val ? status.val.waypoints : null;
        if (saved && !noneSinceRestart(status)) {
          return `#${Math.round(saved.value)} · ${clockTime(saved.ts)}`;
        }
        // /status has counted one that the page has not been sent yet — the gap between
        // the endpoint's reply and the next WebSocket patch. Say the count and stop:
        // "none since restart" under a count of 1 is a tile arguing with itself.
        return countedThisBoot ? `#${countedThisBoot}` : "none since restart";
      }
    ),
    Stat("Satellites", () => {
      const satellites = valueOf("gps_satellites");
      return satellites == null ? "–" : String(Math.round(satellites));
    })
  );
}

/**
 * True when nothing in the page's `waypoint_*` signals belongs to the running service.
 *
 * Stated once because the tile's two lines have to agree: one showing a position while
 * the other says "none since restart" is exactly the incoherent tile the note above is
 * about. Fails OPEN — an unanswered /status shows what the store holds rather than
 * hiding it — because the sheet refreshes /status every time it opens, so the state
 * this guards against is short-lived and blanking the tile on a failed fetch would be
 * the more misleading of the two.
 * @param {import("../vendor/van-1.6.1.js").State<StatusPayload | null>} status
 */
function noneSinceRestart(status) {
  return status.val?.waypoints === 0;
}

/**
 * @param {string} label
 * @param {() => string} value
 * @param {() => string} [sub] a smaller second line, for a tile whose answer is two facts
 */
function Stat(label, value, sub) {
  return div(
    { class: "stat" },
    div({ class: "stat-label" }, label),
    div({ class: "stat-value" }, value),
    // van skips a null child (`child != _undefined` in van-1.6.1.js:90), so a tile
    // without a second line gets two divs exactly as it always did.
    sub ? div({ class: "stat-sub" }, sub) : null
  );
}
