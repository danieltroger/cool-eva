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
 * Power flow: regen is always green (energy coming back), drive ramps with load.
 * @param {number | null} kilowatts
 */
export function power(kilowatts) {
  if (kilowatts == null) {
    return MUTED;
  }
  if (kilowatts < -0.5) {
    return GOOD;
  }
  const magnitude = Math.abs(kilowatts);
  if (magnitude < 3) {
    return CALM;
  }
  if (magnitude < 15) {
    return WATCH;
  }
  if (magnitude < 40) {
    return WARN;
  }
  return BAD;
}
