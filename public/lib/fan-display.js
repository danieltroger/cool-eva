// @ts-check

// The pure half of the cooling-fan section: which duties the slider may select, and the
// sentence each code out of src/fan/curve.ts gets. No van, no fetch, no DOM — so
// scripts/check-fan-curve.ts can assert both without standing up a page.
//
// ⚠️ Nothing here decides policy. The floor and the cap arrive in `/fan`'s `limits`, so
// a cap lowered on the Pi to hold the fan's average voltage moves the slider's stops
// with it and this file never has to be edited to agree.

/**
 * The gap between running stops, in percent.
 *
 * Finer is not a duty this fan resolves, and it costs precision the thumb does not have
 * on a phone. The cap is always the LAST stop whether or not it lands on the grid.
 */
export const DUTY_STEP_PERCENT = 5;

/**
 * The duties the slider offers: stop, then the running band.
 *
 * ⚠️ This is the whole fix for the dead zone. The slider used to run 0…100 in 5 % steps
 * against a 30 % minimum running duty, so 5, 10, 15, 20 and 25 — a quarter of the travel
 * — all silently meant "stop". Every position here is a duty the Pi will actually take,
 * and the slider indexes this array rather than carrying percentages of its own.
 *
 * @param {number} minRunningPercent the Pi's floor; 0 before it has answered
 * @param {number} maxPercent the Pi's cap; 0 before it has answered
 * @returns {number[]}
 */
export function dutyStops(minRunningPercent, maxPercent) {
  const stops = [0];
  if (!(minRunningPercent > 0) || !(maxPercent >= minRunningPercent)) {
    // No reply yet, or a nonsense pair. One stop leaves the slider inert rather than
    // offering duties nothing has agreed to.
    return stops;
  }
  for (let duty = minRunningPercent; duty < maxPercent; duty += DUTY_STEP_PERCENT) {
    stops.push(duty);
  }
  stops.push(maxPercent);
  return stops;
}

/**
 * Which stop a duty sits at — the nearest, so a duty the curve picked off its own line
 * (say 63 %) still puts the thumb somewhere honest instead of at 0.
 * @param {number[]} stops
 * @param {number} duty
 * @returns {number}
 */
export function dutyStopIndex(stops, duty) {
  let best = 0;
  for (let index = 1; index < stops.length; index += 1) {
    if (Math.abs(stops[index] - duty) < Math.abs(stops[best] - duty)) {
      best = index;
    }
  }
  return best;
}

/**
 * One sentence per FAN_REASON in src/fan/curve.ts, keyed by its code.
 *
 * ⚠️ The codes are the wire format and the words are not: a signal is a number, so this
 * is where it becomes something a rider can read. A code with no entry here would render
 * as a bare integer, which is why the check asserts the two sets match exactly.
 * @type {Record<number, string>}
 */
export const FAN_REASON_TEXT = {
  0: "The slider is driving the fan.",
  1: "Waiting for the first pack temperature — the fan stays stopped until one arrives.",
  2:
    "⚠️  No usable pack temperature. Running at the floor rather than off, because a dead sensor reads exactly " +
    "like a cold pack.",
  3: "The pack is below the temperature the fan starts at.",
  4: "Moving fast enough that the airstream through the duct does the cooling.",
  5: "Following the pack temperature.",
  6: "DC charging — the floor every DC session gets, whatever the pack temperature.",
  7: "DC charging, following the pack temperature up the steeper curve.",
};

/**
 * The one reason code the sheet paints as a FAULT rather than a note: no usable pack
 * temperature for a minute, so the fan is at the floor and a sensor is dead.
 *
 * ⚠️ A second copy of src/fan/curve.ts's FAN_REASON.TEMPERATURE_FAULT, because the
 * browser cannot import a .ts module and the code is the wire format. §8 of
 * scripts/check-fan-curve.ts asserts the two still agree. Written as a bare `2` in
 * public/views/fan.js it survived swapping TEMPERATURE_FAULT with BELOW_THRESHOLD —
 * which raises that banner for a merely cold pack and never for the dead sensor.
 */
export const TEMPERATURE_FAULT_REASON = 2;

/**
 * One clause per FAN_TEMPERATURE_INPUT in src/fan/curve.ts. Empty where there is nothing
 * to add: a live reading needs no comment, and code 2 is already spelled out by reason 1
 * or 2, whichever applies.
 * @type {Record<number, string>}
 */
export const FAN_TEMPERATURE_NOTE = {
  0: "",
  1: " Steering by the last in-bounds batt_temp_hi — the signal has stopped arriving.",
  2: "",
};

/**
 * What the automatic mode is doing right now, as one line.
 * @param {number | null} reason
 * @param {number | null} temperatureInput
 * @returns {string}
 */
export function describeAutoReason(reason, temperatureInput) {
  if (reason === null) {
    return "";
  }
  const sentence = FAN_REASON_TEXT[reason] ?? `Reason code ${reason}, which this page has no words for.`;
  return sentence + (temperatureInput === null ? "" : (FAN_TEMPERATURE_NOTE[temperatureInput] ?? ""));
}
