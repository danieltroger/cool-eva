// @ts-check

// Turning handlebar button bits into deliberate gestures, for the one gesture that is
// still the phone's to recognise: a double click that changes tab.
//
// Pure, in the sense src/can/decode.ts is pure: every clock this reasons about is passed
// in, so it reads no clock, touches no DOM and holds no timers. That is what lets
// scripts/check-handlebar-gestures.ts replay press sequences through the very object the
// phone runs. The impure half is ./handlebar-gestures.js.
//
// ⚠️ `nowMs` is the SERVER's clock — the `ts` the Pi stamped on the reading — and NOT the
// phone's. That is the opposite of the rule the rest of this codebase follows for
// durations, and it is deliberate: this measures the gap between two presses ON THE BIKE,
// and the phone's clock can only measure when two messages ARRIVED. On a stalling link
// the two differ, and two presses a second apart would collapse into one double click.
//
// ⚠️ THE LONG PRESS USED TO LIVE HERE AND IS GONE — it is src/gestures/long-press.ts now.
// It had to move: ./connection.js closes the socket whenever the page is hidden, so a
// phone in a pocket recognised nothing, which is every gesture worth making. The tab
// gesture cannot follow it, because changing tab is something only this page can do.
// docs/handlebar-gestures.md has the whole argument and the thresholds.

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

/**
 * How long two presses of the same button may be apart and still count as one
 * double click, measured between their RISING edges.
 *
 * Bounded on both sides by measurement: above a gloved double tap (~500 ms) and below
 * the ~1 s ./press.js puts between two presses that were meant to be separate. 700 ms
 * sits between the two with ~200 ms of headroom either side.
 *
 * Rising edge to rising edge, not release to press, because a cruise-set press is not
 * short: over the whole archive this button has 78 presses with a MEDIAN of 1.198 s, and
 * 38 of them run past 1.2 s. Measured that way a held press can never pair with the one
 * after it.
 * See docs/dashboard-decisions.md §"Handlebar gestures".
 */
export const DOUBLE_CLICK_WINDOW_MS = 700;

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
