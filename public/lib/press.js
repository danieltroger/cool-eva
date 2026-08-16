// @ts-check

import van from "../vendor/van-1.6.1.js";
import { groupOf, knownKeys, signalState } from "./store.js";
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
// A tile that rendered the raw 1 would flicker for a frame and be gone before the eye
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

/** The registry group whose signals get this treatment. Set in src/can/registry.ts. */
export const BUTTON_GROUP = "buttons";

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

/** @type {Map<string, number | null>} */
const previousValues = new Map();

/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const releaseTimers = new Map();

/**
 * Display state for one button, created on first use.
 *
 * A plain accessor: it creates the states and nothing else. The edge detection that
 * fills them lives in the single module-scope derive at the bottom of this file, and
 * that separation is load-bearing rather than tidiness — see the comment there.
 * @param {string} key
 * @returns {PressTracker}
 */
export function pressTracker(key) {
  let tracker = trackers.get(key);
  if (!tracker) {
    tracker = {
      lit: van.state(false),
      count: van.state(0),
      lastAt: van.state(/** @type {number | null} */ (null)),
    };
    trackers.set(key, tracker);
  }
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

/**
 * Fold one new reading of one button into its tracker.
 * @param {string} key
 * @param {number | null} current
 */
function observe(key, current) {
  if (current === null) {
    return;
  }
  const tracker = pressTracker(key);
  const previous = previousValues.get(key) ?? null;
  previousValues.set(key, current);
  // rawVal on both writes below: reading `.val` of a state this same derive assigns to
  // would make the derive depend on itself, and VanJS would then re-run it until its
  // 100-iteration ceiling stopped it. See store.js's peek() for the same point.
  if (current === 1 && previous !== 1) {
    tracker.count.val = tracker.count.rawVal + 1;
    // Monotonic: "pressed 4 s ago" is a duration, and the Pi steps its own wall clock
    // on the first GPS fix. clock.js has the full argument.
    tracker.lastAt.val = monotonicNow();
  }
  const pending = releaseTimers.get(key);
  if (current === 1) {
    if (pending !== undefined) {
      clearTimeout(pending);
      releaseTimers.delete(key);
    }
    tracker.lit.val = true;
  } else if (previous === 1) {
    releaseTimers.set(
      key,
      setTimeout(() => {
        releaseTimers.delete(key);
        tracker.lit.val = false;
      }, LATCH_MS)
    );
  }
}

// ONE derive, at module scope, watching every button — not one per tile.
//
// ⚠️ This placement is the whole reason the feature keeps working, and it is not
// obvious. VanJS decides a listener's lifetime from where it was created:
//
//   listener._dom = dom ?? curNewDerives?.push(listener) ?? alwaysConnectedDom
//                                                        (van-1.6.1.js:78)
//
// At module scope `curNewDerives` is undefined, so the listener gets
// `alwaysConnectedDom` and lives for the life of the page. Created *inside* a binding
// — which is what a `van.derive` in a tile factory would be, since views/all.js builds
// its grid in a function child — it is pushed onto `curNewDerives` and then pinned to
// that render's DOM node (`for (let l of curNewDerives) l._dom = newDom`, line 71).
// The next time the grid re-renders, `dom.replaceWith(newDom)` disconnects that node
// and `keepConnected()` drops the listener permanently.
//
// The ALL grid re-renders on any of: typing in the filter box (which is exactly what
// you do to watch these — filter to `btn`), any new key arriving, or switching tabs
// away and back. So a per-tile derive would stop counting on the first keystroke, in
// total silence, and every tile would sit at `idle` with a frozen count — with the
// README's "trust the count over the light" advice quietly no longer true. This is the
// fourth way the feature could switch itself off without failing anything, and unlike
// the other three it cannot be checked from Node, so it is written down here instead.
//
// Reading `signalState(key).val` below subscribes THIS derive to each button. That
// costs nothing elsewhere: the grid keeps binding per tile, so a 0x400 frame still
// touches only the one tile whose key it carries.
//
// Coalescing is not a risk. VanJS flushes with queueMicrotask, and the rise and fall
// of a press arrive in different WebSocket messages — different macrotasks — so a
// press can never be folded into a single re-run and lost.
van.derive(() => {
  for (const key of knownKeys.val) {
    if (groupOf(key) !== BUTTON_GROUP) {
      continue;
    }
    const reading = signalState(key).val;
    observe(key, reading ? reading.value : null);
  }
});
