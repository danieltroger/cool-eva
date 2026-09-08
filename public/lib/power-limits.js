// @ts-check

import { chargeMode } from "./charge-mode.js";

// The two power ceilings the BMS is enforcing right now, in kilowatts.
//
// `allowed_discharge_a` and `allowed_regen_a` (0x202, 10 Hz) are the BMS's own live
// current limits, and they derate for heat, cold and low SOC long before any voltage
// floor is reached — which is what makes them the earlier and more actionable warning
// (HYPERMILING.md §c). They are amps at the pack and `pack_kw` is `pack_v × pack_a`, so
// multiplying by the measured pack voltage puts a limit and the power drawn against it
// on the same axis with nothing assumed. Sag is a feature of that rather than an error
// in it: the real ceiling does fall as the pack is pulled down, and a limit computed
// against a nominal voltage would hide exactly that.
//
// The reader and the staleness test are handed in the way charge-mode.js takes them:
// that is what lets scripts/check-power-bar.ts run this against literal readings in
// Node, where store.js's van states have no DOM to live in. Measured ranges over the
// archive are in docs/dashboard-decisions.md §"The power bar".

/**
 * @typedef {object} PowerLimitsKw
 * @property {number | null} drive largest discharge the BMS is allowing, kW, positive
 * @property {number | null} regen largest regen the BMS is accepting, kW, positive
 */

/**
 * Both ceilings as positive magnitudes — the bar draws direction itself, so a signed
 * limit here would only be a second place for the sign convention to be got wrong.
 *
 * ⚠️ Nothing is claimed while a charge is up, and that is not caution, it is the one
 * case measured to be wrong. The BMS zeroes BOTH limits during a DC session — rightly,
 * since neither the drive nor the regen path is carrying that current — in 6293 of the
 * 6296 archived samples inside one, while `pack_kw` runs to +24 kW. Riding is a tab and
 * the charge screen is another, so the rider can be looking at this bar mid-charge
 * (views/view-rules.js), and it would then read "the pack allows nothing in either
 * direction and you are 24 kW past it". Staleness does not save it: 0 A is a perfectly
 * fresh reading. Exactly the fault views/charge.js documents from the other side.
 * @param {(key: string) => number | null} read store.js's valueOf, or a stub
 * @param {(key: string, maxAgeMs: number) => boolean} stale store.js's isStale, or a stub
 * @returns {PowerLimitsKw}
 */
export function powerLimitsKw(read, stale) {
  if (chargeMode(read, stale) !== "none") {
    return { drive: null, regen: null };
  }
  const volts = read("pack_v");
  return {
    drive: limitKw(read("allowed_discharge_a"), volts),
    regen: limitKw(read("allowed_regen_a"), volts),
  };
}

/**
 * ⚠️ Zero amps is a REAL limit and must survive: a BMS that has derated all the way to
 * zero is the single most important thing this can say, and a `positiveOrNull()`-shaped
 * guard would drop it on the floor as "no data". Zero volts is not — the pack is never
 * at zero while anything is reading it, so that is a missing or implausible reading.
 * @param {number | null} amps
 * @param {number | null} volts
 * @returns {number | null}
 */
function limitKw(amps, volts) {
  if (amps == null || volts == null || amps < 0 || volts <= 0) {
    return null;
  }
  return (amps * volts) / 1000;
}
