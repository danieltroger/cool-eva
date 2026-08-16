// @ts-check

import van from "../vendor/van-1.6.1.js";
import { signalState } from "./store.js";
import { monotonicNow } from "./clock.js";

// Making a momentary button visible on a phone screen.
//
// The handlebar buttons are momentary and short: measured across 14 candump captures
// the median press is ~140 ms and the shortest is 30 ms. The logging path handles that
// fine — 0x102 arrives every 10 ms, the signals carry no deadband, so both edges of
// even the shortest press are decoded and sealed. Nothing here changes that, and
// nothing here is logged: this is display state only, computed on the phone, the same
// rule derive.js follows.
//
// What log-on-change cannot fix is that 30 ms is one or two frames of a 60 Hz display.
// A tile that renders the raw 1 would flicker for a frame and be gone before the eye
// registered it, which would make the buttons group useless for the one job it exists
// to do — press a button on the bars and see which key moved.
//
// So each button gets two things the raw value doesn't give you:
//
//   • a LATCH. The tile is lit while the bit is 1 and for LATCH_MS after it drops, so
//     the briefest tap is still a clearly visible flash.
//   • a COUNT and a timestamp. These are what survive if a flash is missed entirely —
//     a backgrounded tab, a dropped WebSocket frame, a press that lands during a
//     reconnect. Watching a number go 3 → 4 is a slower but strictly more reliable way
//     to identify a button than watching for a light, and it is the one to trust when
//     the two disagree.

/**
 * How long a press stays lit after the bit drops.
 *
 * 600 ms is comfortably above the ~200 ms it takes to notice a change and well under
 * the ~1 s gap between deliberate presses of the same button, so two taps still read
 * as two.
 */
const LATCH_MS = 600;

/**
 * @typedef {object} PressTracker
 * @property {import("../vendor/van-1.6.1.js").State<boolean>} lit Held down, or released within the last LATCH_MS.
 * @property {import("../vendor/van-1.6.1.js").State<number>} count Rising edges seen since this page loaded.
 * @property {import("../vendor/van-1.6.1.js").State<number | null>} lastAt monotonicNow() of the last rising edge.
 */

/** @type {Map<string, PressTracker>} */
const trackers = new Map();

/**
 * Edge-tracking state for one button signal, created on first use.
 *
 * Each tracker subscribes to exactly one signal, which is what keeps the buttons
 * section as cheap as the rest of the ALL view: a 0x400 frame touches the one tile
 * whose key it carries and nothing else.
 * @param {string} key
 * @returns {PressTracker}
 */
export function pressTracker(key) {
  const existing = trackers.get(key);
  if (existing) {
    return existing;
  }
  const tracker = {
    lit: van.state(false),
    count: van.state(0),
    lastAt: van.state(/** @type {number | null} */ (null)),
  };
  trackers.set(key, tracker);

  let previous = /** @type {number | null} */ (null);
  // ReturnType rather than `number`: this is browser code, but tsconfig.json pulls in
  // @types/node for src/, and there setTimeout returns a Timeout object. The handle is
  // only ever passed back to clearTimeout, so whichever it is at runtime is right.
  let releaseTimer = /** @type {ReturnType<typeof setTimeout> | null} */ (null);

  van.derive(() => {
    const reading = signalState(key).val;
    const current = reading ? reading.value : null;
    if (current === null) {
      return;
    }
    // rawVal on both writes below: reading `.val` of a state this same derive assigns
    // to would make the derive depend on itself, and VanJS would then re-run it until
    // its 100-iteration ceiling stopped it. See store.js's peek() for the same point.
    if (current === 1 && previous !== 1) {
      tracker.count.val = tracker.count.rawVal + 1;
      // Monotonic: "pressed 4 s ago" is a duration, and the Pi steps its own wall
      // clock on the first GPS fix. clock.js has the full argument.
      tracker.lastAt.val = monotonicNow();
    }
    if (current === 1) {
      if (releaseTimer !== null) {
        clearTimeout(releaseTimer);
        releaseTimer = null;
      }
      tracker.lit.val = true;
    } else if (previous === 1) {
      releaseTimer = setTimeout(() => {
        releaseTimer = null;
        tracker.lit.val = false;
      }, LATCH_MS);
    }
    previous = current;
  });

  return tracker;
}

/**
 * How long ago this button was last pressed, in seconds, or null if not this session.
 *
 * Sampled rather than reactive — nothing pushes a message when a second passes, so a
 * caller wanting this to count up has to be paced by something else (chartTick, as the
 * button tiles are).
 * @param {string} key
 * @returns {number | null}
 */
export function secondsSincePress(key) {
  const at = pressTracker(key).lastAt.rawVal;
  return at === null ? null : (monotonicNow() - at) / 1000;
}
