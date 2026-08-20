// @ts-check

import van from "../vendor/van-1.6.1.js";
import { groupOf, knownKeys, signalState } from "./store.js";
import { monotonicNow } from "./clock.js";
import { FLASHER_GAP_MS, FLASHER_KEYS } from "./flasher.js";

export { isFlasher } from "./flasher.js";

// Making a momentary button visible on a phone screen.
//
// The shortest measured press, 30 ms, is under two frames of a 60 Hz display, so each button gets
// three things the raw bit does not give you: a LATCH (lit for LATCH_MS after the bit
// drops), a COUNT and timestamp (which survive a missed flash — trust these over the
// light when the two disagree), and a HELD-SINCE stamp. Display state only, computed on
// the phone and never logged, the same rule derive.js follows.
//
// The tile does not classify signals as momentary or held; it READS THE CLOCK, because
// the measured durations cross over in both directions — the brake, the high beam and
// `btn_indicator_cancel` are each sometimes a tap and sometimes a hold. A key in
// FLASHER_KEYS is the one exception: its falling edge is not believed until the bit has
// stayed at 0 for FLASHER_GAP_MS, because the blinkers are lamp outputs of a 1.46 Hz
// relay rather than a finger. See ./flasher.js, and docs/dashboard-decisions.md
// §"Momentary buttons on a phone screen" for the corpus behind every number here.

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
 * Measured from the RELEASE, not the press: "ago" has to mean "since this last stopped
 * being true", or it disagrees with the hold line rendered directly above it. Null until
 * the first release, so a control still down for the first time has no "ago".
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
// obvious. VanJS gives a listener created at module scope `alwaysConnectedDom` and it
// lives for the life of the page; one created INSIDE a binding — which is what a
// `van.derive` in a tile factory would be — is pinned to that render's DOM node and
// dropped, silently, the next time it re-renders. The ALL grid re-renders on the first
// keystroke in its filter box, which is exactly what you do to watch these, so a
// per-tile derive would stop counting with every tile frozen at `idle` and the README's
// "trust the count over the light" advice quietly no longer true.
//
// The mechanism, line by line, and why it cannot be checked from Node:
// docs/dashboard-decisions.md §"ONE derive, at module scope". Same rule, same reason,
// for installHandlebarGestures().
van.derive(() => {
  for (const key of knownKeys.val) {
    if (groupOf(key) !== BUTTON_GROUP) {
      continue;
    }
    const reading = signalState(key).val;
    observe(key, reading ? reading.value : null);
  }
});
