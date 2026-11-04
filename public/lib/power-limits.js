// @ts-check
// Pack-side current, measured volts, zero and charging constraints: docs/ride-power.md.

/** @param {number | null} amps @param {number | null} volts @returns {number | null} */
export function limitKw(amps, volts) {
  if (amps === null || volts === null || amps < 0 || volts <= 0) return null;
  return (amps * volts) / 1000;
}

// Sized against configured ceilings, rather than observed peaks; see docs/dashboard-decisions.md.
export const POWER_SCALE_KW = { drive: 130, regen: 36 };
