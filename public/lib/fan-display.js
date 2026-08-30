// @ts-check

// The pure half of the cooling-fan section: which duties the slider may select, and the
// sentence each code out of src/fan/curve.ts and src/fan/fun.ts gets. No van, no fetch,
// no DOM — so scripts/check-fan-curve.ts and scripts/check-fan-fun.ts can assert all of
// it without standing up a page.
//
// ⚠️ Nothing here decides policy. The floor and the cap arrive in `/fan`'s `limits`, so
// a cap lowered on the Pi to hold the fan's average voltage moves the slider's stops
// with it and this file never has to be edited to agree.

/**
 * The gap between running stops, in percent.
 *
 * ⚠️ This was 5, and its reason was that "finer is not a duty this fan resolves". That is
 * FALSE — a 50 000 ns period is about 2500 counts, so the bridge resolves ~0.04 %, and
 * fun mode drives it at that resolution. The real reason for a coarse grid was thumb
 * precision on a phone, and that has now been traded away on purpose: nobody cares
 * whether it is 47 or 48 %, and sliding it and hearing the fan change immediately is
 * worth more than landing on an exact number. The cap is always the LAST stop whether or
 * not it lands on the grid.
 */
export const DUTY_STEP_PERCENT = 1;

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
 * The mode as `fan_auto_mode` carries it.
 *
 * ⚠️ A second copy of FAN_MODE_CODE in src/fan/auto.ts, because the browser cannot import
 * a .ts module and the code is the wire format. scripts/check-fan-fun.ts asserts the two
 * agree. Written as a bare `2` in public/views/fan.js it would survive swapping fun with
 * manual — which shows "Manual" over a fan taking its orders from the throttle.
 */
export const FAN_MODE_CODE = { MANUAL: 0, AUTOMATIC: 1, FUN: 2 };

/**
 * One sentence per FUN_GATE in src/fan/fun.ts, keyed by its code — why fun mode is or is
 * not on offer. Same arrangement as FAN_REASON_TEXT above and asserted the same way.
 * @type {Record<number, string>}
 */
export const FUN_GATE_TEXT = {
  0: "The bike cannot move, so the throttle can drive the fan.",
  1: "The bike is in Go — the throttle belongs to the motor.",
  2: "The bike is moving.",
  3: "No fresh `go` off 0x102, so nothing says the bike cannot move.",
  4: "No fresh `speed_can_kmh` off 0x104, so nothing says the bike is stopped.",
  5: "No fresh `throttle_pct` off 0x109, so there is nothing to drive the fan with.",
};

/**
 * A duty as a rider should read it. Fun mode carries a FRACTIONAL percent — the whole
 * point is a throttle finer than whole percent — and `43.51724137931034 %` is not a thing
 * to put on a phone. One decimal, and no trailing `.0` on the duties every other mode
 * produces.
 * @param {number | null | undefined} percent
 * @returns {string}
 */
export function formatDuty(percent) {
  if (typeof percent !== "number" || !Number.isFinite(percent)) {
    return "—";
  }
  return Number.isInteger(percent) ? String(percent) : percent.toFixed(1);
}

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
