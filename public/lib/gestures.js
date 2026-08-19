// @ts-check

// Turning handlebar button bits into deliberate gestures.
//
// Pure, in the sense src/can/decode.ts is pure: every clock these recognisers reason
// about is passed in, so they read no clock, touch no DOM and hold no timers. That is
// what lets scripts/check-handlebar-gestures.ts replay press sequences through the very
// objects the phone runs — including the real durations measured off this bike's own
// bus, which is the only evidence there is for the thresholds below. The impure half
// (subscribing to signals, scheduling the one timer a hold needs, calling the actions)
// is ./handlebar-gestures.js.
//
// ## The safety argument, which decides the shape of this file
//
// Both buttons these watch have primary vehicle functions: `btn_cruise_set` sets the
// cruise speed, `btn_indicator_cancel` cancels the turn signal. Neither function is
// affected by anything here, and not because the code is careful — because the phone
// is not in the circuit. The buttons are wired to the bike's own dashboard and VCU;
// CAN `0x102` / `0x400` carry a *report* of the switch state that the bike broadcasts
// after it has already acted. This dashboard is a passive listener on that broadcast
// (`src/can/socket.ts` comes up listen-only; nothing on this path ever transmits), so
// there is no press for it to swallow, debounce or delay. A gesture is recognised
// strictly downstream of the bike having done its own job.
//
// That is also why nothing here waits to see whether a press "turns into" a gesture.
// A double click does not suppress the first click, and a long press does not suppress
// the release — the bike never asked us, and both actions have already happened by the
// time the frame carrying them is decoded.

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
 * Bounded on both sides by measurements rather than taste:
 *
 *  • Above a gloved double tap. A bare-handed double click runs 150–300 ms; a thick
 *    glove on a vibrating bar roughly doubles that, so the gesture has to stay
 *    comfortably reachable at ~500 ms.
 *  • Below two presses that were meant to be separate. ./press.js puts the gap
 *    between deliberate presses of the same button at ~1 s, and that is the number
 *    this must not reach — two ordinary cruise-set presses a second apart must read
 *    as two, not as a tab switch.
 *
 * 700 ms sits between the two with ~200 ms of headroom either side.
 *
 * Rising edge to rising edge, not release to press, because a cruise-set press is not
 * short: the only one in the corpus was held 1.794 s. Measured that way a long press
 * can never pair with the press after it, which is the behaviour we want — a double
 * click is two quick taps, and a held press is not a tap.
 */
export const DOUBLE_CLICK_WINDOW_MS = 700;

/**
 * How long `btn_indicator_cancel` must be held before it saves a waypoint.
 *
 * The corpus is the argument. Across 14 candump captures the median handlebar press is
 * 140 ms and the shortest 30 ms, and indicator-cancel is 63 of the ~70 presses in it,
 * so that median is essentially the median cancel tap. The longest ordinary press ever
 * recorded on any handlebar button is 920 ms (`btn_cruise_enable`, which was not being
 * held for effect — a short press already arms cruise).
 *
 * 1200 ms is therefore ~8.5× a normal cancel tap and clears the longest ordinary press
 * of any button by 280 ms, while staying short enough to hold through a corner without
 * thinking about it. Riders do not hold the cancel switch in: it stops the lamp the
 * instant it closes and there is no reason to keep pressing.
 *
 * The cost of being wrong is deliberately asymmetric, which is why this is not set
 * even higher. A false positive saves a waypoint nobody wanted — a row in the log and
 * a banner. A false negative is a stop you meant to remember and did not. Neither
 * touches the indicator, which cancelled on the closing edge 1.2 s earlier.
 */
export const LONG_PRESS_MS = 1200;

/**
 * Recognises two quick presses of one button.
 *
 * Fires on the second rising edge, not on a release, so the gesture completes while
 * the thumb is still down and the tab has already changed when it lifts.
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
   * @param {number} nowMs from monotonicNow() — the window is a duration, and this
   *   process's wall clock is stepped from GPS (see ./clock.js)
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
    if (this.#lastRiseAt !== null && nowMs - this.#lastRiseAt <= this.#windowMs) {
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
 * Fires while the button is still down, at the moment the threshold is crossed, rather
 * than on release. With gloves and no glance to spare that matters: the confirmation
 * appears while the thumb is still there, so holding longer is self-correcting and the
 * rider never has to guess whether they held it long enough.
 *
 * ⚠️ Readings alone cannot drive this. The signal only moves on the two edges — and
 * `src/ws.ts` patches on change, so a 1.2 s hold can arrive as one message and then
 * silence — which means nothing would call observe() at the moment the threshold is
 * crossed. #deadlineMs is how the caller learns when to come back; ./handlebar-gestures.js
 * keeps the single timer that does it.
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
   * Folds in one reading of the button. Safe to call at any time with the current
   * value — that is what the deadline timer does.
   *
   * @param {number | null} value the button bit, or null if the signal has never arrived
   * @param {number} nowMs from monotonicNow()
   * @returns {boolean} true exactly once per press, when the hold passes the threshold
   */
  observe(value, nowMs) {
    if (value === null) {
      return false;
    }
    const previous = this.#previousValue;
    this.#previousValue = value;
    if (value !== 1) {
      this.#pressedAt = null;
      this.#fired = false;
      return false;
    }
    if (previous === 0) {
      this.#pressedAt = nowMs;
      this.#fired = false;
      return false;
    }
    if (this.#pressedAt === null || this.#fired) {
      // Either a hold that began before we were watching, or one that has already
      // fired. Latched so a hold saves one waypoint however long it lasts.
      return false;
    }
    if (nowMs - this.#pressedAt < this.#holdMs) {
      return false;
    }
    this.#fired = true;
    return true;
  }

  /**
   * When observe() would next fire if the button stays down, or null when nothing is
   * pending. The caller schedules a wakeup for this and calls observe() again.
   * @returns {number | null}
   */
  deadlineMs() {
    if (this.#pressedAt === null || this.#fired) {
      return null;
    }
    return this.#pressedAt + this.#holdMs;
  }
}
