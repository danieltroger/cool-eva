// @ts-check

import van from "../vendor/van-1.6.1.js";
import { connection, valueOf } from "./store.js";
import { fanAnnouncementKey, fanAnnouncementText } from "./fan-display.js";
import { showToast } from "./toast.js";

// Banners for things the BIKE did, which nothing on this screen asked for.
//
// Since the handlebar gestures moved to the Pi (src/gestures/runner.ts) the phone is no
// longer the thing that recognises a hold — it is a listener that finds out afterwards,
// exactly as it finds out about anything else on the bus. So the banner is raised off the
// live signals rather than off a reply to a request this page made.
//
// ⚠️ It does NOT try to tell a gesture from a tap on this phone's own controls, and that
// is a decision rather than an omission: the WebSocket patch normally arrives BEFORE the
// HTTP reply that would register "this was me", so suppression would have to be a time
// window — and a window that misfires swallows the banner for a real gesture, which is
// the one failure the banner exists to prevent. A redundant banner is the cheaper wrong.
// docs/dashboard-decisions.md §"The toast banner".

/**
 * One sentence per WAYPOINT_REFUSAL in src/gps/waypoint.ts, keyed by its code.
 *
 * These used to reach the rider as the reply to the phone's own request. A hold on the
 * bars asks nobody, so the Pi records the code and this is where it becomes English.
 * scripts/check-hold-gestures.ts asserts every code has a sentence.
 * @type {Record<number, string>}
 */
export const WAYPOINT_REFUSAL_TEXT = {
  1: "No GPS fix yet — waypoint not saved.",
  2: "GPS position arrived but was never timestamped — waypoint not saved.",
  3: "GPS fix is too old — waypoint not saved.",
  4: "Bike's clock has not synced to GPS yet — waypoint not saved.",
  5: "Bike's clock disagrees with GPS — waypoint not saved.",
  6: "GPS fix jumped somewhere the bike cannot have ridden — waypoint not saved.",
  7: "GPS fix is not a real position — waypoint not saved.",
};

/**
 * Starts the two watchers.
 *
 * ⚠️ Call at module top level, the way app.js calls connect() — never from inside a view
 * or a binding. A derive created inside a binding is pinned to that render's DOM node and
 * dropped, silently, at the next re-render, and the symptom would be banners that stop
 * appearing after the first tab switch. ./press.js §"ONE derive" has the mechanism.
 */
export function installAnnouncements() {
  announceFanState();
  announceWaypoints();
}

/**
 * The fan's mode, as the Pi reports it.
 *
 * ⚠️ The first reading is adopted SILENTLY, and so is the first after the link comes back.
 * ./connection.js closes the socket whenever the page is hidden, so a phone taken out of a
 * pocket reconnects to a full snapshot — and announcing that would be announcing news
 * from ten minutes ago as if it had just happened. Same rule as "a hold we never saw
 * begin is not a gesture".
 */
function announceFanState() {
  /** @type {string | null} */
  let announced = null;
  van.derive(() => {
    if (connection.val !== "live") {
      announced = null;
      return;
    }
    const target = valueOf("fan_target_pct");
    const key = fanAnnouncementKey(valueOf("fan_auto_mode"), target);
    if (key === null || key === announced) {
      return;
    }
    const first = announced === null;
    announced = key;
    if (!first) {
      showToast(fanAnnouncementText(key, target), "good");
    }
  });
}

/**
 * Waypoints saved and waypoints refused, off their two counters.
 *
 * ⚠️ Counters and not values, because `record()` seals a row only when the value MOVES:
 * two identical refusals in a row would otherwise be one banner, and the second hold at
 * the same spot with the same stale fix would look like it had worked.
 */
function announceWaypoints() {
  /** @type {number | null} */
  let saved = null;
  /** @type {number | null} */
  let refused = null;
  van.derive(() => {
    if (connection.val !== "live") {
      saved = null;
      refused = null;
      return;
    }
    const savedNow = valueOf("waypoint_seq");
    const refusedNow = valueOf("waypoint_refused_seq");
    if (savedNow !== null && savedNow !== saved) {
      const first = saved === null;
      saved = savedNow;
      if (!first) {
        showToast(`Waypoint ${Math.round(savedNow)} saved.`, "good");
      }
    }
    if (refusedNow !== null && refusedNow !== refused) {
      const first = refused === null;
      refused = refusedNow;
      const why = valueOf("waypoint_refusal");
      if (!first) {
        showToast(WAYPOINT_REFUSAL_TEXT[why ?? 0] ?? "Waypoint not saved.", "bad");
      }
    }
  });
}
