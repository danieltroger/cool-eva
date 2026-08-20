// @ts-check

// Turning handlebar button bits into deliberate gestures.
//
// Pure, in the sense src/can/decode.ts is pure: every clock these recognisers reason
// about is passed in, so they read no clock, touch no DOM and hold no timers. That is
// what lets scripts/check-handlebar-gestures.ts replay press sequences through the very
// objects the phone runs. The impure half is ./handlebar-gestures.js.
//
// ⚠️ `nowMs` is the SERVER's clock — `serverTime` from ./store.js, the `ts` the Pi
// stamped on the message — and NOT `monotonicNow()`. That is the opposite of the rule
// the rest of this codebase follows for durations, and it is deliberate: these measure
// how long a button was down ON THE BIKE, and the phone's monotonic clock can only
// measure when two messages ARRIVED. On a stalling link the two differ, and a 140 ms
// tap would read as a 1.5 s hold. IMPLAUSIBLE_HOLD_MS covers the one thing a server
// clock can do that a monotonic one cannot, which is jump.
//
// That argument in full, and why no gesture here can degrade the button it listens to:
// docs/dashboard-decisions.md §"Handlebar gestures".

/**
 * Double-clicked to change tab: the cruise SET SPEED button (`0x400` b2 bit 2).
 *
 * ⚠️ Not `btn_cruise_enable`, which sits next to it and whose name reads just as
 * harmlessly. That one is cruise ON/OFF, and src/can/decode.ts records that BOTH of its
 * presses in the corpus armed cruise control 0.53 s later — contradicting the owner's
 * manual, which claims activation needs a 3-second hold. Setting a cruise speed, by
 * contrast, does nothing at all unless cruise is already armed.
 *
 * Declared here, in the module with no imports, so scripts/check-handlebar-gestures.ts
 * can assert what the gestures are bound to without pulling VanJS and the signal store
 * into a Node process that has no DOM.
 */
export const NEXT_TAB_BUTTON = "btn_cruise_set";

/** Held to save a waypoint: the turn-signal cancel switch, pushed in (`0x102` b0 bit 5). */
export const WAYPOINT_BUTTON = "btn_indicator_cancel";

/**
 * How long two presses of the same button may be apart and still count as one
 * double click, measured between their RISING edges.
 *
 * Bounded on both sides by measurement: above a gloved double tap (~500 ms) and below
 * the ~1 s ./press.js puts between two presses that were meant to be separate. 700 ms
 * sits between the two with ~200 ms of headroom either side.
 *
 * Rising edge to rising edge, not release to press, because a cruise-set press is not
 * short — the only one in the corpus was held 1.794 s — so measured that way a held
 * press can never pair with the press after it.
 * See docs/dashboard-decisions.md §"Handlebar gestures".
 */
export const DOUBLE_CLICK_WINDOW_MS = 700;

/**
 * How long `btn_indicator_cancel` must be held before it saves a waypoint.
 *
 * The corpus is the argument: a median handlebar press of 140 ms across 14 candump
 * captures, a longest ordinary press of 920 ms on any button, and 8/8 instructed MODE
 * presses at 120–260 ms. 1200 ms is ~8.5× a normal cancel tap and clears that 920 ms by
 * 280 ms, while staying short enough to hold through a corner without thinking about it.
 *
 * Not set higher because the cost of being wrong is asymmetric: a false positive is a
 * row in the log and a banner, a false negative is a stop you meant to remember and did
 * not. Neither touches the indicator, which cancelled 1.2 s earlier.
 * See docs/dashboard-decisions.md §"Handlebar gestures".
 */
export const LONG_PRESS_MS = 1200;

/**
 * An apparent hold longer than this is not a hold, and is abandoned without firing.
 *
 * The server clock these run on is the one ../../src/gps/clock.ts steps from satellite
 * time. A forward step during a press would otherwise land as "held for six hours" and
 * save a waypoint the rider never asked for, in the seconds after a cold boot — which
 * is exactly when they are least likely to be watching for it.
 *
 * 30 s separates the two cases cleanly and needs no maintenance. Above: the smallest
 * step the gate will ever make is DRIFT_THRESHOLD_SECONDS, 60 s, and a real one is
 * hours. Below: the slowest the phone can learn that a button is still down is the
 * 5 s WebSocket heartbeat, on a bus where nothing else is changing at all.
 */
export const IMPLAUSIBLE_HOLD_MS = 30_000;

/**
 * Recognises two quick presses of one button.
 *
 * Fires on the second rising edge, so the gesture completes while the thumb is still
 * down and the tab has already changed when it lifts.
 */
export class DoubleClickDetector {
  #windowMs;
  /** @type {number | null} */
  #previousValue = null;
  /** @type {number | null} */
  #lastRiseAt = null;

  /** @param {number} [windowMs] */
  constructor(windowMs = DOUBLE_CLICK_WINDOW_MS) {
    this.#windowMs = windowMs;
  }

  /**
   * Folds in one reading of the button.
   *
   * @param {number | null} value the button bit, or null if the signal has never arrived
   * @param {number} nowMs the SERVER's clock for this reading — see the note at the top
   *   of this file for why it is not monotonicNow()
   * @returns {boolean} true exactly once, on the rising edge that completes a pair
   */
  observe(value, nowMs) {
    if (value === null) {
      // Never seen: says nothing about the button, and must not be read as a release.
      return false;
    }
    const previous = this.#previousValue;
    this.#previousValue = value;
    // A real observed 0→1, never "the first reading happened to be 1". Loading the
    // page mid-press is not a press we watched, and app.js's high-beam gesture draws
    // the line in the same place.
    if (!(previous === 0 && value === 1)) {
      return false;
    }
    const sinceLastRise = this.#lastRiseAt === null ? null : nowMs - this.#lastRiseAt;
    if (sinceLastRise !== null && sinceLastRise >= 0 && sinceLastRise <= this.#windowMs) {
      // Cleared rather than replaced, so three quick taps are one switch and a fresh
      // start — not two switches, which would make a fumbled double tap overshoot.
      this.#lastRiseAt = null;
      return true;
    }
    this.#lastRiseAt = nowMs;
    return false;
  }
}

/**
 * Recognises one button held past a threshold.
 *
 * Fires as soon as the evidence arrives that the button WAS down for long enough —
 * usually while it still is, since patches run at ~5 Hz even on a parked bike, but on a
 * quiet bus the evidence can arrive with the RELEASE instead. That is the same rule and
 * not a special case: fire when the server's own timeline shows the threshold passed.
 *
 * ⚠️ There is deliberately no timer here. An earlier version fired on a local
 * setTimeout at the threshold, which measured the gap between two messages ARRIVING and
 * so counted a stalled link as a hold. See the note at the top of this file.
 */
export class LongPressDetector {
  #holdMs;
  /** @type {number | null} */
  #previousValue = null;
  /** @type {number | null} */
  #pressedAt = null;
  #fired = false;

  /** @param {number} [holdMs] */
  constructor(holdMs = LONG_PRESS_MS) {
    this.#holdMs = holdMs;
  }

  /**
   * Folds in one reading of the button. Called on every message, not only on the
   * edges — an unchanged `1` with a newer timestamp is what proves the button is
   * still down.
   *
   * @param {number | null} value the button bit, or null if the signal has never arrived
   * @param {number} nowMs the SERVER's clock as of the newest message
   * @returns {boolean} true exactly once per press, when the hold is shown to have
   *   passed the threshold
   */
  observe(value, nowMs) {
    if (value === null) {
      return false;
    }
    const previous = this.#previousValue;
    this.#previousValue = value;

    if (this.#pressedAt !== null && !this.#fired) {
      const heldFor = nowMs - this.#pressedAt;
      if (heldFor < 0 || heldFor > IMPLAUSIBLE_HOLD_MS) {
        // The clock moved, not the thumb. Abandon this press rather than guess at it;
        // a fresh 0→1 starts a new one.
        this.#pressedAt = null;
      } else if (heldFor >= this.#holdMs) {
        this.#fired = true;
        if (value !== 1) {
          // Learned from the release. Clear the press here, because the reset below
          // is skipped by the early return.
          this.#pressedAt = null;
        }
        return true;
      }
    }

    if (value !== 1) {
      this.#pressedAt = null;
      this.#fired = false;
      return false;
    }
    if (previous === 0) {
      this.#pressedAt = nowMs;
      this.#fired = false;
    }
    // Anything else is a hold still in progress, or one that has already fired and is
    // latched so a long hold saves one waypoint however long it lasts.
    return false;
  }
}
