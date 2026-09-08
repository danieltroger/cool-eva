// @ts-check

// Colour carries the state so the number doesn't have to be read.
//
// Deliberately few steps, and the same ramp everywhere: calm blue-green when
// there's nothing to think about, amber when it's worth a look, red when it isn't.
// A dashboard that is mostly grey-green at a glance means "fine" without being
// read at all, which is the only thing that works at speed.

export const CALM = "#e2e8f0";
export const GOOD = "#4ade80";
export const WATCH = "#facc15";
export const WARN = "#fb923c";
export const BAD = "#f87171";
export const COLD = "#38bdf8";
/* 6.1:1 against the tiles — matches --sub in style.css. Anything dimmer is
   unreadable in daylight; see the palette note there before changing it. */
export const MUTED = "#9aa9bf";

/**
 * @param {number | null} celsius
 * @returns {string}
 */
export function temperature(celsius) {
  if (celsius == null) {
    return MUTED;
  }
  if (celsius < 5) {
    return COLD;
  }
  if (celsius < 20) {
    return "#67e8f9";
  }
  if (celsius < 35) {
    return GOOD;
  }
  if (celsius < 45) {
    return WATCH;
  }
  if (celsius < 55) {
    return WARN;
  }
  return BAD;
}

/**
 * Cell spread. Tens of millivolts is a healthy pack; past ~50 mV one cell is
 * dragging the usable capacity of the whole thing down with it.
 * @param {number | null} millivolts
 */
export function spread(millivolts) {
  if (millivolts == null) {
    return MUTED;
  }
  if (millivolts < 15) {
    return GOOD;
  }
  if (millivolts < 30) {
    return WATCH;
  }
  if (millivolts < 50) {
    return WARN;
  }
  return BAD;
}

/**
 * Headroom of the weakest cell above the configured cut-off, in mV.
 * The BMS cuts on one cell, so this — not SOC — is what ends a ride.
 * @param {number | null} millivolts
 */
export function headroom(millivolts) {
  if (millivolts == null) {
    return MUTED;
  }
  if (millivolts > 300) {
    return GOOD;
  }
  if (millivolts > 150) {
    return WATCH;
  }
  if (millivolts > 50) {
    return WARN;
  }
  return BAD;
}

/**
 * @param {number | null} percent
 */
export function stateOfCharge(percent) {
  if (percent == null) {
    return MUTED;
  }
  if (percent < 10) {
    return BAD;
  }
  if (percent < 20) {
    return WARN;
  }
  if (percent < 35) {
    return WATCH;
  }
  return GOOD;
}

/**
 * How much of the pack's output is being burned as heat in its own resistance.
 * Scales with current squared, so this climbs fast and is the most direct signal
 * that you are riding expensively.
 * @param {number | null} percent
 */
export function lossFraction(percent) {
  if (percent == null) {
    return MUTED;
  }
  if (percent < 2) {
    return GOOD;
  }
  if (percent < 5) {
    return WATCH;
  }
  if (percent < 10) {
    return WARN;
  }
  return BAD;
}

/**
 * Power flow: regen green because energy is coming back, drive white at any load.
 *
 * ⚠️ `pack_kw` is NEGATIVE under discharge and POSITIVE on regen and charge — the
 * convention derive.js asserts by name rather than leaving in a minus sign. The
 * comparison here was `< -0.5` from 2026-08-03 (#33) until 2026-09-08, which is the
 * same test with the bike's sign convention read backwards: it painted a 100 kW pull
 * green and a 20 kW recovery amber. Nothing catches that by looking — both colours are
 * plausible on their own. scripts/check-power-bar.ts §1 asserts the direction.
 *
 * Drive used to ramp CALM → WATCH → WARN → BAD by magnitude, and that ramp is gone
 * rather than retuned. Two reasons, and the second is the real one:
 *
 *   • Contrast. The bar draws the BMS's derate as a dashed rule ON TOP of the fill, and
 *     that rule sat at 1.72:1 over the BAD red — the one state where crossing into
 *     unreachable power matters most. White takes it to 3.65:1 and needs no second
 *     colour to be legible against.
 *   • The ramp answered a worse question. Its thresholds were absolute — 3, 15, 40 kW —
 *     while the hatching beside it answers "how close am I to what the pack will
 *     actually give me", which moves with heat, cold and SOC and is the number a rider
 *     can act on. Two colour languages for load, one of them fixed and wrong most of
 *     the time, is worse than one.
 * @param {number | null} kilowatts
 */
export function power(kilowatts) {
  if (kilowatts == null) {
    return MUTED;
  }
  return kilowatts > 0.5 ? GOOD : CALM;
}
