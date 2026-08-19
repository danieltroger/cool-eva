// @ts-check

import van from "../vendor/van-1.6.1.js";
import { peek, signalState } from "./store.js";
import { monotonicNow } from "./clock.js";
import { DoubleClickDetector, LongPressDetector, NEXT_TAB_BUTTON, WAYPOINT_BUTTON } from "./gestures.js";
import { saveWaypoint } from "./waypoint.js";
import { showToast } from "./toast.js";

// Handlebar buttons as app controls: the impure half of ./gestures.js.
//
// This is what the dashboard has instead of a touchscreen while riding. The high-beam
// flash in app.js was the first of these and is still the only one that works with a
// full-face helmet and winter gloves without moving a hand; these two put the same
// idea on buttons the thumb already rests near.
//
//   • double-click `btn_cruise_set`      → next tab
//   • long-press `btn_indicator_cancel`  → save a waypoint, and say so
//
// ## Which bit, and why it is not the obvious one
//
// `btn_cruise_enable` is the wrong button and its name is the reason to check. It is
// the cruise ON/OFF switch, and `src/can/decode.ts` records that BOTH of its presses in
// the corpus armed cruise control 0.53 s later — it is not side-effect-free, and the
// owner's manual claim that activation needs a 3-second hold is contradicted by the bus
// (both presses were under a second). `btn_cruise_set` is the SET SPEED button next to
// it, and setting a cruise speed does nothing at all unless cruise is already armed.
//
// That leaves one honest caveat, which belongs to the button rather than to the
// gesture: double-tapping SET while cruise IS armed re-sets the cruise speed to the
// current speed. So does tapping it once, so nothing here made that worse — but a
// rider changing tabs while decelerating under cruise would be lowering the setpoint,
// and that is worth knowing rather than discovering.
//
// ## Why neither gesture can degrade the button it listens to
//
// It cannot, structurally. See the long argument at the top of ./gestures.js: the
// phone is a passive listener on a broadcast the bike sends *after* it has acted on
// the switch itself. Nothing here transmits, nothing here is consulted, and nothing
// here delays a press — the indicator has already cancelled and cruise has already
// been set by the time the frame carrying the bit is decoded, let alone by the time a
// gesture completes 1.2 s later.

/**
 * @typedef {object} HandlebarGestureActions
 * @property {() => void} onNextTab Move to the next tab. The one integration point:
 *   the shell owns which tab is showing, so this never touches that state directly.
 */

const doubleClick = new DoubleClickDetector();
const longPress = new LongPressDetector();

/** @type {ReturnType<typeof setTimeout> | undefined} */
let holdTimer;

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

  // Bound to the signals rather than to the 2 Hz chartTick, for the reason app.js
  // gives about the high-beam gesture: at a 500 ms tick the edges of a 140 ms press
  // are missed more often than not.
  van.derive(() => {
    signalState(NEXT_TAB_BUTTON).val;
    if (doubleClick.observe(peek(NEXT_TAB_BUTTON), monotonicNow())) {
      // No banner. The tab changing IS the feedback, and a banner on every switch
      // would be the thing you learn to ignore before the one that matters appears.
      actions.onNextTab();
    }
  });

  van.derive(() => {
    signalState(WAYPOINT_BUTTON).val;
    pumpLongPress();
  });
}

/**
 * Advances the hold, then arranges to be called again at the moment it would complete.
 *
 * The timer is not an optimisation, it is the only thing that can fire this gesture.
 * A held button produces exactly two messages — one per edge — so between them nothing
 * arrives to notice that 1.2 s has passed. Waiting for the release instead would mean
 * the rider only finds out whether they held it long enough *after* letting go, which
 * is the one thing a no-glance gesture cannot ask of them.
 */
function pumpLongPress() {
  // peek(), not valueOf(): the caller's derive has already subscribed to this signal,
  // and the timer path has no binding to subscribe from.
  if (longPress.observe(peek(WAYPOINT_BUTTON), monotonicNow())) {
    void saveWaypointAndReport();
  }
  clearTimeout(holdTimer);
  const deadline = longPress.deadlineMs();
  if (deadline === null) {
    return;
  }
  // Monotonic throughout: this process's wall clock is stepped from GPS, and a step
  // mid-hold would either fire the gesture instantly or never. ./clock.js has the case.
  holdTimer = setTimeout(pumpLongPress, Math.max(0, deadline - monotonicNow()));
}

/** Saves, then puts the server's own verdict on screen — worked or did not. */
async function saveWaypointAndReport() {
  const outcome = await saveWaypoint();
  showToast(outcome.message, outcome.saved ? "good" : "bad");
}
