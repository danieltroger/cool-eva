// @ts-check

import van from "../vendor/van-1.6.1.js";
import { WAYPOINT_HISTORY_NOTE, waypointListSummary, waypointRows } from "../lib/waypoint-list.js";

const { button, div } = van.tags;

/** @typedef {import("../../src/http/status.ts").StatusPayload} StatusPayload */
/** @typedef {import("../lib/waypoint-list.js").WaypointRow} WaypointRow */

// The places this ride kept, under the trip stats in the menu sheet. The tile above says
// where the LAST one was; this says what the whole boot has.
//
// Everything here comes from /status, which views/sheet.js refreshes whenever the sheet
// opens — see lib/waypoint-list.js for why the WebSocket cannot be the source, and for the
// one thing that is read off it.

/**
 * How many rows are drawn before the toggle.
 *
 * ⚠️ Not 50. The bike keeps up to MAX_EVENTS and this sheet is scrolled with a thumb on a
 * handlebar-mounted phone: fifty rows would be ~2 000 px between the trip stats and
 * "Save waypoint here", and the risk tiers further down the sheet are argued in style.css
 * on the premise that a thumb can reach them. Six is the same number the Faults tab shows
 * its stored codes at, through the same `.code-toggle`.
 */
const PREVIEW_LIMIT = 6;

const expanded = van.state(false);

/**
 * @param {import("../vendor/van-1.6.1.js").State<StatusPayload | null>} status
 *   the sheet's /status state, passed in rather than imported so this file does not reach
 *   back into the one that renders it — the same call views/trip-stats.js makes.
 */
export function WaypointList(status) {
  return div({ class: "waypoint-list" }, () => {
    // ⚠️ BOTH READ FIRST, before any branch. VanJS re-collects a binding's dependencies
    // from the reads its LAST run made, so a run that returns above one of these leaves
    // the list subscribed to the other alone and it stops updating — measured, and
    // written up in views/trip-stats.js §Waypoints.
    const payload = status.val;
    const showAll = expanded.val;
    const events = Array.isArray(payload?.waypointEvents) ? payload.waypointEvents : [];
    // Sliced BEFORE the rows are built, not after: the bike may serve fifty and this draws
    // six, and each row costs two bounds tests, a toLocaleTimeString and an age. The events
    // arrive oldest-first, so the newest are at the end; waypointRows() does the reversing.
    const shown = waypointRows(showAll ? events : events.slice(-PREVIEW_LIMIT));
    return div(
      ...shown.map(Row),
      // Mirrors views/faults.js: no toggle at all when there is nothing behind it, rather
      // than a "show all 2" that does nothing anyone can see.
      events.length <= PREVIEW_LIMIT
        ? null
        : button(
            {
              class: "code-toggle",
              onclick: () => {
                expanded.val = !expanded.val;
              },
            },
            showAll ? "show fewer" : `show all ${events.length}`
          ),
      div(
        { class: "waypoint-note" },
        payload === null
          ? "Asking the bike…"
          : waypointListSummary({
              events,
              savedTotal: payload.waypoints,
              refusedTotal: payload.waypointsRefused,
              rowsShown: shown.length,
            })
      ),
      div({ class: "waypoint-note" }, WAYPOINT_HISTORY_NOTE)
    );
  });
}

/**
 * Shuts the list back to its preview.
 *
 * Called from openSheet(), because every other thing this sheet expands or arms is reset
 * when it opens (`armed.val = ""`, the write fold) and a list left open by one tap would
 * otherwise put fifty rows above the Actions section on every later open — which is the
 * thing PREVIEW_LIMIT exists to prevent, arrived at by a different road.
 */
export function collapseWaypointList() {
  expanded.val = false;
}

/**
 * @param {WaypointRow} row
 */
function Row(row) {
  return div(
    { class: "waypoint-row" },
    div({ class: `waypoint-mark${row.outcome === "saved" ? "" : " refused"}` }, row.mark),
    div(
      { class: "waypoint-body" },
      div({ class: row.fault ? "waypoint-fault" : "" }, row.text),
      div({ class: "waypoint-when" }, row.when)
    )
  );
}
