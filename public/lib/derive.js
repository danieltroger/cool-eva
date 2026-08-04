// @ts-check

import { peek, valueOf } from "./store.js";
import { ringFor } from "./ring.js";
// Series count lives with everything else about the pack's cells, so the sag
// divisor and the strip's "n of 81" cannot disagree.
import { CELL_COUNT } from "./cells.js";

// Everything the dashboard shows that the bike does not itself measure.
//
// All of it is computed here, on the phone, and none of it is logged: the ride log
// holds measurements only, so a derivation that later turns out to be wrong can be
// redone against the raw data instead of poisoning it. The formulas come from the
// BMS's own configuration — see HYPERMILING.md.
//
// Sign convention, read off 7.6 M logged samples: `pack_a` and `pack_kw` are
// NEGATIVE under discharge (observed minima −407 A and −116.6 kW, against the
// Ribelle's 126 kW peak) and positive on regen and charge. Getting this backwards
// silently inverts sag compensation, so it is asserted by name below rather than
// left implicit in a minus sign.

/** Rolling windows. Long enough to be stable, short enough to reflect this hill. */
export const ROLLING_WINDOW_MS = 5 * 60_000;

/**
 * Current being pulled out of the pack, in amps, or 0 when charging/regenerating.
 * @returns {number | null}
 */
export function dischargeAmps() {
  const packAmps = valueOf("pack_a");
  if (packAmps == null) {
    return null;
  }
  return packAmps < 0 ? -packAmps : 0;
}

/**
 * Temperature the coolant picks up crossing the pack. This is the number the whole
 * watercooling project is judged by: with flow roughly constant, ΔT is proportional
 * to the heat actually being removed.
 * @returns {number | null}
 */
export function coolantDelta() {
  const inlet = valueOf("coolant_in");
  const outlet = valueOf("coolant_out");
  if (inlet == null || outlet == null) {
    return null;
  }
  return outlet - inlet;
}

/**
 * A signal's value only if it is above zero, else null.
 *
 * Several BMS fields sit at exactly 0 when the BMS is not producing them — the 1 Wh
 * remaining-energy field reads 0 until the extended config has something to report,
 * and pack resistance reads 0 while the pack is idle and not being estimated. `??`
 * does not catch that, because 0 is not nullish, so a naive fallback chain picks the
 * zero over the good value behind it and the screen says "0.0 kWh left" on a pack
 * that has 4.8 kWh in it. Every fallback below goes through here.
 * @param {string} key
 * @returns {number | null}
 */
function positiveOrNull(key) {
  const value = valueOf(key);
  return value != null && value > 0 ? value : null;
}

/**
 * Watts burned in the pack's own internal resistance — I²R.
 *
 * This is simultaneously the range you are throwing away and the heat the coolant
 * loop has to carry off, which is why it earns a place on the riding screen and not
 * just the hypermiling one. Because it goes as current squared, halving the current
 * quarters it: the most direct possible argument for a gentle throttle.
 *
 * Caveat worth keeping in mind when reading it: `pack_resistance_mohm` is the BMS's
 * own estimate and includes cabling and contactors, so some of these watts are shed
 * outside the cells. It is an upper bound on cell heating, not a measurement of it.
 * @returns {number | null}
 */
export function resistiveLossWatts() {
  const amps = valueOf("pack_a");
  // A pack with zero internal resistance does not exist; a zero here means the BMS
  // is not estimating one right now, which is not the same as "no losses" and must
  // not be drawn as a confident 0 W.
  const milliohms = positiveOrNull("pack_resistance_mohm");
  if (amps == null || milliohms == null) {
    return null;
  }
  // A² × mΩ = mW × 1000 ⇒ /1000 gives watts. Squaring drops the sign, so this is
  // correct for regen too, where the same loss applies to current going in.
  return (amps * amps * milliohms) / 1000;
}

/**
 * Resistive loss as a percentage of what the pack is delivering.
 * @returns {number | null}
 */
export function resistiveLossPercent() {
  const watts = resistiveLossWatts();
  const packKilowatts = valueOf("pack_kw");
  if (watts == null || packKilowatts == null) {
    return null;
  }
  const outputWatts = Math.abs(packKilowatts) * 1000;
  // Below a few hundred watts the ratio is dominated by its own rounding and swings
  // between nothing and everything while parked. No number is better than a wrong one.
  if (outputWatts < 300) {
    return null;
  }
  return (watts / outputWatts) * 100;
}

/**
 * Per-cell voltage sag attributable to current draw, in millivolts.
 * Ohmic model: amps × milliohms lands directly in millivolts, spread over the
 * series count. See HYPERMILING.md — at 100 A through a 100 mΩ pack this is
 * ~123 mV per cell, comparable to the entire margin being watched.
 * @returns {number | null}
 */
export function sagPerCellMv() {
  const amps = dischargeAmps();
  const milliohms = positiveOrNull("pack_resistance_mohm");
  if (amps == null || milliohms == null) {
    return null;
  }
  return (amps * milliohms) / CELL_COUNT;
}

/**
 * What the weakest cell would read with the throttle shut — measured voltage plus
 * the sag the current is causing. This is the honest picture of how much is left.
 * @returns {number | null}
 */
export function restingMinCellMv() {
  const minimum = valueOf("cell_min_mv");
  const sag = sagPerCellMv();
  if (minimum == null || sag == null) {
    return null;
  }
  return minimum + sag;
}

/**
 * Millivolts the weakest cell has above the configured cut-off, right now. This is
 * what the BMS actually trips on, so it is the authority — the resting figure below
 * is the aid, never the other way round.
 * @returns {number | null}
 */
export function headroomMv() {
  return headroomMvWith(valueOf);
}

/**
 * The same, sampled rather than subscribed — for the view rules in app.js, which
 * are paced by the shared tick and must not add cell_min_mv to its dependencies.
 * @returns {number | null}
 */
export function headroomMvSampled() {
  return headroomMvWith(peek);
}

/**
 * Parameterised on how it reads, so the subscribing and sampling variants above
 * cannot drift apart — the alternative is two copies of the same subtraction, and
 * the one that gets fixed is never the one that is wrong.
 * @param {(key: string) => number | null} read
 * @returns {number | null}
 */
function headroomMvWith(read) {
  const minimum = read("cell_min_mv");
  const cutoff = read("cell_cutoff_mv");
  if (minimum == null || cutoff == null) {
    return null;
  }
  return minimum - cutoff;
}

/**
 * Headroom with sag taken out — how much range is genuinely left, as opposed to
 * how close the current dip is to the floor.
 * @returns {number | null}
 */
export function restingHeadroomMv() {
  const resting = restingMinCellMv();
  const cutoff = valueOf("cell_cutoff_mv");
  if (resting == null || cutoff == null) {
    return null;
  }
  return resting - cutoff;
}

/**
 * Energy the pack says it has left, preferring the 1 Wh field from the extended
 * config over the coarser VCU one.
 * @returns {number | null}
 */
export function remainingWh() {
  return positiveOrNull("bms_remaining_energy_wh") ?? positiveOrNull("residual_energy_wh");
}

/**
 * Wh/km over the last few minutes: pack power integrated over time, against
 * distance actually covered.
 *
 * The energy term is integrated from `pack_kw` rather than differenced from a
 * remaining-energy counter, which is what the first version did and why the
 * readout kept going blank mid-ride. Measured across the seven rides of
 * 2026-08-04: `residual_energy_wh` moves in ~158 Wh steps — roughly one step per
 * kilometre — so a five-minute window often held fewer than the two samples a
 * difference needs, and the tile showed nothing between 23% and 100% of the time
 * depending on the ride. `bms_remaining_energy_wh`, which has the 1 Wh resolution
 * this wants, reads a constant 0 on this pack.
 *
 * `pack_kw` has no such problem: it is pushed to the ring at up to 2 Hz, so the
 * window is never short of samples while the bike is moving. Cross-checked against
 * an independent source on the same rides — Δ`remaining_ah` × pack voltage — the
 * integral agrees to within ~5% on every one of them.
 *
 * Differencing `residual_energy_wh` lands 25-35% below both, but that is not
 * evidence of a bad decode: it is validated against the bike's own menu (see
 * decode.ts 0x10a) and is an estimate of energy *available to the cut-off*, which
 * is legitimately less than the charge the pack still holds. It is simply the wrong
 * quantity for "what did the last five minutes cost", which is energy drawn.
 *
 * Still preferred over the bike's own average because the horizon is known and
 * stated on screen; a single averaged number with no stated window invites false
 * precision.
 * @param {number} now monotonic, from lib/clock.js — the rings are keyed on it
 * @returns {{ whPerKm: number, km: number } | null}
 */
export function rollingConsumption(now) {
  const power = ringFor("pack_kw").since(ROLLING_WINDOW_MS, now);
  // 0x104's odometer in preference to the hub's: it is on the CAN bus, so it is
  // there whenever the bike is awake, while the Bluetooth one needs the hub link to
  // be up. Both are logged separately on purpose, so this picks rather than merges.
  const distanceKey = positiveOrNull("odometer_can_km") != null ? "odometer_can_km" : "odometer_km";
  const distance = ringFor(distanceKey).since(ROLLING_WINDOW_MS, now);
  if (power.values.length < 2 || distance.values.length < 2) {
    return null;
  }

  const spentWh = integrateWh(power.times, power.values);
  const travelledKm = distance.values[distance.values.length - 1] - distance.values[0];
  // Under ~200 m the odometer's 100 m resolution dominates and the ratio is garbage.
  // A window that is net-regen has nothing useful to say as a consumption figure.
  if (travelledKm < 0.2 || spentWh <= 0) {
    return null;
  }
  return { whPerKm: spentWh / travelledKm, km: travelledKm };
}

/**
 * Watt-hours drawn from the pack across a window of pack_kw samples.
 *
 * Zero-order hold: each sample is taken to apply until the next one. pack_kw is
 * pushed to the ring on change with a 0.05 kW deadband, so a value that stops
 * updating genuinely has not moved, and the step is the reading rather than an
 * interpolation between two guesses.
 *
 * Discharge is negative on this bike (see the sign note at the top of this file),
 * so the sum is negated to make consumption positive. Regen is included with its
 * own sign and correctly reduces the total.
 *
 * This assumes ring time advances at the same rate as the ride, which is true on
 * the bike and is NOT true under scripts/replay-capture.ts at anything other than
 * `--speed 1`: the odometer supplies distance in ride-space while the ring is
 * stamped in real time, so a 10x replay reports a tenth of the real Wh/km. That is
 * an artefact of the tool, not of this function — worth knowing before filing it
 * as a bug for the second time.
 * @param {number[]} times monotonic, oldest first
 * @param {number[]} kilowatts
 * @returns {number}
 */
function integrateWh(times, kilowatts) {
  let wattHours = 0;
  for (let index = 0; index < times.length - 1; index++) {
    const hours = (times[index + 1] - times[index]) / 3_600_000;
    wattHours += -kilowatts[index] * hours * 1000;
  }
  return wattHours;
}

/**
 * Range left at the rate you have actually been riding, rather than at whatever
 * the bike's estimator assumes.
 * @param {number} now monotonic, from lib/clock.js
 * @returns {number | null}
 */
export function rollingRangeKm(now) {
  const consumption = rollingConsumption(now);
  const energy = remainingWh();
  if (!consumption || energy == null) {
    return null;
  }
  return energy / consumption.whPerKm;
}

/**
 * How hard the BMS is currently throttling you, 0–1, against its own ceiling.
 * Falls before the voltage floor is reached and also for cold, heat and low SOC,
 * which makes it the earlier and more actionable warning of the two.
 * @param {"allowed_discharge_a" | "allowed_regen_a"} key
 * @param {number} ceiling
 * @returns {number | null}
 */
export function limitFraction(key, ceiling) {
  const allowed = valueOf(key);
  if (allowed == null || ceiling <= 0) {
    return null;
  }
  return Math.max(0, Math.min(1, allowed / ceiling));
}

/** True when the BMS reports any state that means "charging" — see the bitfield note. */
export function isCharging() {
  return isChargingWith(valueOf);
}

/** The same, sampled rather than subscribed. See headroomMvSampled(). */
export function isChargingSampled() {
  return isChargingWith(peek);
}

/**
 * `charge_state` is a bitfield, not an enum: 1 = discharge, 2 = charge, 4
 * balancing, 8 trickle, 16 idle, 32 charge-complete, 64 maintenance. Testing it
 * against a single value flags Idle as charging, which is what the old dashboard's
 * `!== 1` did — so this reads the decoded bits instead. Charge-complete is
 * deliberately excluded: current is no longer going in.
 * @param {(key: string) => number | null} read
 */
function isChargingWith(read) {
  return read("bms_state_charge") === 1 || read("bms_state_trickle") === 1 || read("bms_state_maintenance") === 1;
}
