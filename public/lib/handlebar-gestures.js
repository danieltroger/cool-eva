// @ts-check

import van from "../vendor/van-1.6.1.js";
import { serverTime, signalState } from "./store.js";
import { DoubleClickDetector, LongPressDetector, NEXT_TAB_BUTTON, WAYPOINT_BUTTON } from "./gestures.js";
import { saveWaypoint } from "./waypoint.js";
import { showToast } from "./toast.js";

// Handlebar buttons as app controls: the impure half of ./gestures.js.
//
//   • double-click `btn_cruise_set`      → next tab
//   • long-press `btn_indicator_cancel`  → save a waypoint, and say so
//
// ⚠️ `btn_cruise_set` is the SET SPEED button, NOT `btn_cruise_enable` next to it —
// that one is cruise ON/OFF, and both of its presses in the corpus armed cruise control
// 0.53 s later. The one honest caveat belongs to the button rather than the gesture:
// with cruise armed, tapping SET re-sets the setpoint to the current speed, so changing
// tabs while decelerating under cruise would lower it.
//
// Neither gesture can degrade the button it listens to, structurally — the phone is a
// passive listener on a broadcast the bike sends after it has already acted. That
// argument, and the measurements behind the thresholds: docs/dashboard-decisions.md
// §"Handlebar gestures".

/**
 * @typedef {object} HandlebarGestureActions
 * @property {() => void} onNextTab Move to the next tab. The one integration point:
 *   the shell owns which tab is showing, so this never touches that state directly.
 */

const doubleClick = new DoubleClickDetector();
const longPress = new LongPressDetector();

let installed = false;

/**
 * Starts watching the two buttons.
 *
 * ⚠️ Call this at module top level, the way app.js calls connect() — never from inside
 * a view or a binding. The derives below decide their own lifetime from where they are
 * created: at top level VanJS gives them `alwaysConnectedDom` and they live as long as
 * the page, but created inside a binding they are pinned to that render's DOM node and
 * are dropped, silently, the next time it re-renders. ./press.js §"ONE derive" has the
 * full mechanism; the symptom would be gestures that quietly stop working after the
 * first tab switch.
 *
 * @param {HandlebarGestureActions} actions
 */
export function installHandlebarGestures(actions) {
  if (installed) {
    // Not fatal, but it would double every gesture, so it must not pass unremarked.
    console.warn("gestures: installHandlebarGestures() called twice — ignoring the second");
    return;
  }
  installed = true;

  // Bound to the signal rather than to the 2 Hz chartTick, for the reason app.js gives
  // about the high-beam gesture: at a 500 ms tick the edges of a 140 ms press are
  // missed more often than not.
  van.derive(() => {
    const reading = signalState(NEXT_TAB_BUTTON).val;
    // reading.ts, not serverTime: the press is timed by when the Pi recorded the bit
    // changing, which is what makes the gap between two taps immune to however long
    // the link took to deliver them.
    if (reading && doubleClick.observe(reading.value, reading.ts)) {
      // No banner. The tab changing IS the feedback, and a banner on every switch
      // would be the thing you learn to ignore before the one that matters appears.
      actions.onNextTab();
    }
  });

  // ⚠️ This one subscribes to `serverTime` as well, which paces it at the WebSocket's
  // full rate — normally the thing ./store.js warns against, and here the entire point.
  //
  // A held button sends nothing. Patches carry only what CHANGED, so between the two
  // edges of a 1.2 s hold the button's own signal is untouched and a derive watching
  // only that signal would next wake on the 5 s heartbeat. `serverTime` moves on every
  // message — ~5 Hz even parked, measured over the 90 s capture in obd-garage/captures
  // — so this is what lets the detector see that time has passed on the BIKE while the
  // button stayed down.
  //
  // The cost is a handful of comparisons per message, which is nothing next to the
  // per-signal bindings the same messages already drive.
  van.derive(() => {
    const serverNow = serverTime.val;
    const reading = signalState(WAYPOINT_BUTTON).val;
    if (reading && longPress.observe(reading.value, serverNow)) {
      void saveWaypointAndReport();
    }
  });
}

/** Saves, then puts the server's own verdict on screen — worked or did not. */
async function saveWaypointAndReport() {
  const outcome = await saveWaypoint();
  showToast(outcome.message, outcome.saved ? "good" : "bad");
}
