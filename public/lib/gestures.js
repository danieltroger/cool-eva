// @ts-check

// Turning handlebar button bits into deliberate gestures.
//
// Pure, in the sense src/can/decode.ts is pure: every clock these recognisers reason
// about is passed in, so they read no clock, touch no DOM and hold no timers. That is
// what lets scripts/check-handlebar-gestures.ts replay press sequences through the very
// objects the phone runs — including the real durations measured off this bike's own
// bus, which is the only evidence there is for the thresholds below. The impure half
// (subscribing to signals, calling the actions) is ./handlebar-gestures.js.
//
// ## ⚠️ The clock these take is the SERVER's, not the phone's
//
// `nowMs` below is `serverTime` from ./store.js — the `ts` the Pi stamped on the
// message — and NOT `monotonicNow()`. That is the opposite of the rule the rest of this
// codebase follows for durations, so it needs its argument written down.
//
// What these measure is how long a button was down ON THE BIKE. The phone's monotonic
// clock cannot answer that: it measures the gap between two WebSocket messages
// ARRIVING, and those are the same number only while delivery latency is constant. On
// a garage hotspot it is not. A 140 ms tap whose release patch is held up 1.5 s by the
// link looks, on the arrival clock, exactly like a 1.5 s hold — and would save a
// waypoint nobody asked for. Two deliberate presses a second apart, delivered
// back-to-back after a stall, look exactly like a double click.
//
// The Pi stamps `ts` when it builds the patch, before the message goes anywhere, so
// server-side differences are immune to whatever the link does afterwards. A stall
// simply stops the clock advancing, and the queued release arrives carrying the time it
// really happened.
//
// The one thing the server clock can do that a monotonic clock cannot is JUMP:
// ../../src/gps/clock.ts steps it from satellite time, by at least
// DRIFT_THRESHOLD_SECONDS (60 s) when it does. IMPLAUSIBLE_HOLD_MS below is what keeps
// a step from being read as a very long press.
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
 *    comfortably reachable at ~500 ms. The 2026-08-19 MODE-button measurements put a
 *    single deliberate press at 120–260 ms, so two of them plus the gap between is
 *    already most of half a second before a glove is anywhere near it.
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
 * Corroborated since, and independently: the MODE buttons and `btn_set_back` were
 * confirmed on 2026-08-19 by instructed presses, 8/8 each, as clean momentary 0→1→0
 * pulses of 120–260 ms. A deliberate press of a handlebar button made on purpose, by a
 * rider being asked to press it, is a quarter of a second at the outside — which is the
 * same story the corpus median tells, told by a different measurement.
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
 * which is usually while it still is, because ./store.js is fed a patch on every
 * signal change and those run at ~5 Hz even on a parked bike (measured over the 90 s
 * capture in obd-garage/captures). So the banner normally appears about a tenth of a
 * second after the threshold, with the thumb still on the button, and holding longer
 * is self-correcting.
 *
 * When the bus goes quiet the evidence can instead arrive with the RELEASE, whose
 * timestamp says how long the press really was. Firing then is late feedback for a
 * gesture that was genuinely made, which is far better than dropping it — and it is
 * the same rule, not a special case: fire when the server's own timeline shows the
 * threshold was passed.
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
