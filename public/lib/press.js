// @ts-check

import van from "../vendor/van-1.6.1.js";
import { groupOf, knownKeys, signalState } from "./store.js";
import { monotonicNow } from "./clock.js";
import { FLASHER_GAP_MS, FLASHER_KEYS } from "./flasher.js";

export { isFlasher } from "./flasher.js";

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
// So each button gets three things the raw value doesn't give you:
//
//   • a LATCH. The tile is lit while the bit is 1 and for LATCH_MS after it drops, so
//     the briefest tap is still a clearly visible flash.
//   • a COUNT and a timestamp. These are what survive if a flash is missed entirely —
//     a backgrounded tab, a dropped WebSocket frame, a press that lands during a
//     reconnect. Watching a number go 3 → 4 is a slower but strictly more reliable way
//     to identify a button than watching for a light, and it is the one to trust when
//     the two disagree.
//   • a HELD-SINCE stamp, for the group's other half.
//
// ## The group stopped being all momentary on 2026-08-19
//
// The owner asked for the indicators, the high beam and the brake in this section, and
// none of those three is a tap. "4 presses · 2 min ago" is a true sentence that answers
// the wrong question about a brake lever being squeezed RIGHT NOW.
//
// Every duration below is MEASURED, by replaying all 14 650 573 frames of 0x102 in the
// 248 captures in ~/Documents/cool-eva-archive and pairing each rising edge with the
// falling edge after it:
//
//   key                    applications   median ON   longest ON   under 1 s
//   front brake (b2 0x20)           491      2.24 s       47.2 s          —
//   high_beam  (b0 bit6)            180      0.27 s       67.9 s     163/180
//   btn_mode_enter                  142      0.14 s        0.3 s     142/142
//   btn_mode_left                   310      0.14 s        2.6 s     293/310
//   btn_mode_right                  525      0.13 s      191.2 s     484/525
//   btn_indicator_cancel            762      0.18 s        5.8 s     759/762
//
// Which is the whole argument against sorting these into "momentary" and "held" BY KEY.
// Every column of that table crosses over: the high beam is a 0.27 s flash-to-pass 163
// times out of 180 and a held state the other 17, and a `btn_` key nobody would call a
// held state has sat down for three minutes. A hand-written list would be wrong about
// both, in opposite directions, and would go quietly stale besides.
//
// The tile therefore does not classify signals; it READS THE CLOCK. Anything currently
// down for longer than HOLD_MS is described by how long it has been down, and everything
// else by its press count. Nothing to keep in sync, and the day the brake bit sticks on
// it says so instead of quietly adding a press.
//
// The case that settles it landed the same day, in ./handlebar-gestures.js: holding
// `btn_indicator_cancel` for LONG_PRESS_MS = 1200 ms now saves a waypoint. So a key
// whose name, prefix and 762 recorded presses all say "momentary" is deliberately held
// past a second as a designed input — and the tile says "held 1 s" while it happens,
// which is the useful thing to see while you are waiting for the toast. Any list of
// held-state keys written yesterday would have been wrong about it today.
//
// ## …except that a flasher is not a finger
//
// One thing the clock alone cannot fix, and it is the reason ./flasher.js exists. The
// two blinker keys are LAMP outputs, so a running indicator toggles them at 1.46 Hz —
// 1881 rising edges for 323 signalled turns — and no hold ever reaches HOLD_MS, so a
// turn would read "89 presses" and never "on". That file carries the measurement, the
// gap histogram behind FLASHER_GAP_MS, and the reason the set is closed to two keys.
//
// What this file does with it: for a key in FLASHER_KEYS, a falling edge is not believed
// until the bit has stayed at 0 for FLASHER_GAP_MS. Everything downstream — the count,
// `downSince`, the latch — then treats one indicator use as one event without knowing
// anything about flashers.

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
 * How long the bit has to stay down before the tile describes the hold rather than the
 * count.
 *
 * One second is where the corpus is thinnest: 1 678 of the 1 739 `btn_` presses ever
 * recorded are under it, against a front-brake application whose median is 2.24 s.
 * Nothing is MISLABELLED by landing on the wrong side — a button really held for a
 * second was really held for a second, and the tile then says so, which is the point.
 * The threshold only decides which of two true sentences is the more useful one.
 */
const HOLD_MS = 1000;

/**
 * @typedef {object} PressTracker
 * @property {import("../vendor/van-1.6.1.js").State<boolean>} lit Down, or released within the last LATCH_MS — plus FLASHER_GAP_MS again for a flasher key, whose release is itself deferred.
 * @property {import("../vendor/van-1.6.1.js").State<number>} count Rising edges seen since this page loaded.
 * @property {import("../vendor/van-1.6.1.js").State<number | null>} lastAt monotonicNow() of the last FALLING edge — see secondsSincePress for why it is that end.
 * @property {import("../vendor/van-1.6.1.js").State<number | null>} downSince monotonicNow() of the rising edge of the press still in progress, else null.
 */

/** @type {Map<string, PressTracker>} */
const trackers = new Map();

/** @type {Map<string, number | null>} */
const previousValues = new Map();

/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const releaseTimers = new Map();

/**
 * Falling edges seen but not yet believed, for the flasher keys only.
 *
 * A key is in here for at most FLASHER_GAP_MS. If the bit comes back inside that window
 * the timer is cancelled and the activation simply continues — no count, no new
 * downSince — which is what makes one signalled turn one event instead of ninety.
 * @type {Map<string, ReturnType<typeof setTimeout>>}
 */
const fallTimers = new Map();

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
      downSince: van.state(/** @type {number | null} */ (null)),
    };
    trackers.set(key, tracker);
  }
  return tracker;
}

/**
 * How long ago this button was last pressed, in seconds, or null if not this session.
 *
 * Measured from the RELEASE, not the press, and that end is deliberate. For the 140 ms
 * taps this file was written for the two are the same number; for a 47 s brake hold they
 * are not, and stamping the rising edge would have the tile read "1 press · 49 s ago"
 * two seconds after the lever came back. "Ago" has to mean "since this last stopped
 * being true", or it disagrees with the hold line rendered directly above it.
 *
 * Returns null until the first release, so a control that is still down for the very
 * first time has no "ago" — which is correct, and the tile is showing the hold anyway.
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
 * How long this signal has been continuously down, in seconds — or null unless it is
 * down *and* has been for longer than HOLD_MS, which is the case the caller wants to
 * describe differently.
 *
 * Sampled rather than reactive, exactly like secondsSincePress: while a brake is held
 * the bike sends nothing (the signals carry no deadband, so log-on-change means one row
 * at each edge and none in between), so a caller wanting this to count up has to be
 * paced by chartTick.
 * @param {string} key
 * @returns {number | null}
 */
export function secondsHeld(key) {
  const since = pressTracker(key).downSince.rawVal;
  if (since === null) {
    return null;
  }
  const held = monotonicNow() - since;
  return held < HOLD_MS ? null : held / 1000;
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

  if (current === 1) {
    const deferred = fallTimers.get(key);
    if (deferred !== undefined) {
      // A flasher's off phase, not a release. Drop the pending fall and let the
      // activation already in progress carry on: no new count, downSince untouched, so
      // the tile keeps counting up through the dark half of every blink.
      clearTimeout(deferred);
      fallTimers.delete(key);
    } else if (previous !== 1) {
      // rawVal on the count below: reading `.val` of a state this same derive assigns
      // to would make the derive depend on itself, and VanJS would then re-run it until
      // its 100-iteration ceiling stopped it. See store.js's peek() for the same point.
      tracker.count.val = tracker.count.rawVal + 1;
      // Monotonic: "released 4 s ago" and "held for 4 s" are both durations, and the Pi
      // steps its own wall clock on the first GPS fix. clock.js has the full argument.
      tracker.downSince.val = monotonicNow();
    }
    const pending = releaseTimers.get(key);
    if (pending !== undefined) {
      clearTimeout(pending);
      releaseTimers.delete(key);
    }
    tracker.lit.val = true;
    return;
  }

  // A 0. Only the 1 → 0 transition is an event; repeated zeros are the resting state.
  if (previous !== 1) {
    return;
  }
  // `at` is captured HERE, not inside the timer. For a flasher the edge really happened
  // now; the 700 ms is how long it takes to be sure of it, and charging that delay to
  // the rider would make every finished indicator read 0.7 s staler than it is.
  const at = monotonicNow();
  if (FLASHER_KEYS.has(key)) {
    fallTimers.set(
      key,
      setTimeout(() => {
        fallTimers.delete(key);
        release(key, tracker, at);
      }, FLASHER_GAP_MS)
    );
    return;
  }
  release(key, tracker, at);
}

/**
 * The falling edge, once it is believed.
 * @param {string} key
 * @param {PressTracker} tracker
 * @param {number} at monotonicNow() of the edge itself, which for a flasher is earlier than now.
 */
function release(key, tracker, at) {
  tracker.lastAt.val = at;
  // Cleared here, on the real falling edge, NOT when the LATCH_MS timer below expires.
  // `lit` is a display effect and deliberately outlives the press; this is the fact, and
  // the tile decides which of the two to believe.
  tracker.downSince.val = null;
  releaseTimers.set(
    key,
    setTimeout(() => {
      releaseTimers.delete(key);
      tracker.lit.val = false;
    }, LATCH_MS)
  );
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
