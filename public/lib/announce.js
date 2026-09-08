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
 * Folds one reading into an announcement's memory, and says whether to raise a banner.
 *
 * Pure, and exported so scripts/check-hold-gestures.ts can drive it without a DOM.
 *
 * ⚠️ `baselined` is a SEPARATE flag, not "is the remembered value still null".
 * `waypoint_seq` is `onDemand` and absent from the store until the Pi saves something, so
 * a remembered null means "never arrived" — and treating the first arrival as the
 * baseline swallowed the banner for the FIRST waypoint of every boot.
 *
 * @template {number | string} T
 * @param {{ value: T | null, baselined: boolean }} state
 * @param {T | null} reading
 * @returns {{ state: { value: T | null, baselined: boolean }, announce: boolean }}
 */
export function foldAnnouncement(state, reading) {
  if (!state.baselined) {
    // Whatever the link just handed us is news from before we were listening.
    return { state: { value: reading, baselined: true }, announce: false };
  }
  if (reading === null || reading === state.value) {
    return { state, announce: false };
  }
  return { state: { value: reading, baselined: true }, announce: true };
}

/**
 * A fresh memory, for the first paint and for every reconnect.
 * @template {number | string} T
 * @returns {{ value: T | null, baselined: boolean }}
 */
function blank() {
  return { value: null, baselined: false };
}

/**
 * The fan's mode, as the Pi reports it.
 *
 * ⚠️ The memory is thrown away whenever the link is not live, so the snapshot that comes
 * back is adopted silently. ./connection.js closes the socket whenever the page is
 * hidden, so a phone taken out of a pocket reconnects to a full snapshot — and announcing
 * that would be announcing news from ten minutes ago as if it had just happened. Same
 * rule as "a hold we never saw begin is not a gesture".
 */
function announceFanState() {
  let memory = /** @type {{ value: string | null, baselined: boolean }} */ (blank());
  van.derive(() => {
    if (connection.val !== "live") {
      memory = blank();
      return;
    }
    const target = valueOf("fan_target_pct");
    const folded = foldAnnouncement(memory, fanAnnouncementKey(valueOf("fan_auto_mode"), target));
    memory = folded.state;
    if (folded.announce) {
      showToast(fanAnnouncementText(memory.value, target), "good");
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
  let saved = /** @type {{ value: number | null, baselined: boolean }} */ (blank());
  let refused = /** @type {{ value: number | null, baselined: boolean }} */ (blank());
  van.derive(() => {
    if (connection.val !== "live") {
      saved = blank();
      refused = blank();
      return;
    }
    const foldedSave = foldAnnouncement(saved, valueOf("waypoint_seq"));
    saved = foldedSave.state;
    if (foldedSave.announce) {
      showToast(`Waypoint ${Math.round(Number(saved.value))} saved.`, "good");
    }
    const foldedRefusal = foldAnnouncement(refused, valueOf("waypoint_refused_seq"));
    refused = foldedRefusal.state;
    if (foldedRefusal.announce) {
      const why = valueOf("waypoint_refusal");
      showToast(WAYPOINT_REFUSAL_TEXT[why ?? 0] ?? "Waypoint not saved.", "bad");
    }
  });
}
