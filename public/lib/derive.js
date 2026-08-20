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

/** Below this the odometer's own 100 m resolution dominates the ratio. */
const MIN_DISTANCE_KM = 0.2;

/** Longest a single pack_kw sample may stand for before the gap counts as missing. */
const MAX_HOLD_MS = 3000;

/** Fraction of the measured stretch that must have power data behind it. */
const MIN_COVERAGE = 0.7;

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
 * Wh/km over the last few minutes: pack power integrated over time, against distance
 * actually covered.
 *
 * The energy term is INTEGRATED from `pack_kw` rather than differenced from a
 * remaining-energy counter, which is what the first version did and why the readout kept
 * going blank mid-ride. Returns a state rather than a bare number, because "nothing to
 * show yet" and "you are net regenerating" are different things and a descent must not
 * be reported as waiting for you to start moving. Measurements, and why the bike's own
 * average is not used: docs/dashboard-decisions.md §"Wh/km".
 * @param {number} now monotonic, from lib/clock.js — the rings are keyed on it
 * @returns {{ state: "measured", whPerKm: number, km: number }
 *          | { state: "regenerating", km: number }
 *          | { state: "waiting" }}
 */
export function rollingConsumption(now) {
  const power = ringFor("pack_kw").since(ROLLING_WINDOW_MS, now);
  // 0x104's odometer in preference to the hub's: it is on the CAN bus, so it is
  // there whenever the bike is awake, while the Bluetooth one needs the hub link to
  // be up. Both are logged separately on purpose, so this picks rather than merges.
  const distanceKey = positiveOrNull("odometer_can_km") != null ? "odometer_can_km" : "odometer_km";
  const distance = ringFor(distanceKey).since(ROLLING_WINDOW_MS, now);
  if (power.values.length < 2 || distance.values.length < 2) {
    return { state: "waiting" };
  }

  // Both terms are measured over the DISTANCE window, not the power window: pack_kw
  // keeps arriving while the bike stands still and the odometer does not, so the wider
  // window would charge four minutes at a red light to the 500 m actually ridden. The
  // cost is that standing-still draw is excluded, which makes rollingRangeKm() slightly
  // optimistic in traffic — docs/dashboard-decisions.md §"Wh/km".
  const from = distance.times[0];
  const to = distance.times[distance.times.length - 1];
  const travelledKm = distance.values[distance.values.length - 1] - distance.values[0];
  // Under ~200 m the odometer's 100 m resolution dominates and the ratio is garbage.
  if (travelledKm < MIN_DISTANCE_KM || to <= from) {
    return { state: "waiting" };
  }

  const { wattHours, coveredMs } = integrateWh(power.times, power.values, from, to);
  // Too much of the stretch has no power data to stand behind a number.
  if (coveredMs < (to - from) * MIN_COVERAGE) {
    return { state: "waiting" };
  }
  // Net regen over the whole stretch is a real state, not a missing measurement —
  // a long descent — and the caller says so rather than claiming to be waiting.
  if (wattHours <= 0) {
    return { state: "regenerating", km: travelledKm };
  }
  return { state: "measured", whPerKm: wattHours / travelledKm, km: travelledKm };
}

/**
 * Watt-hours drawn from the pack between `from` and `to`.
 *
 * Zero-order hold, which is right for a signal pushed on change — but a gap in the ring
 * has two indistinguishable causes, the value genuinely holding and nothing arriving at
 * all. Holding across the second invents energy, so an interval longer than MAX_HOLD_MS
 * is dropped and the caller checks MIN_COVERAGE before trusting the total. Discharge is
 * negative on this bike (see the sign note at the top of this file), so the sum is
 * negated; regen keeps its own sign. See docs/dashboard-decisions.md §"Zero-order hold".
 * @param {number[]} times monotonic, oldest first
 * @param {number[]} kilowatts
 * @param {number} from
 * @param {number} to
 * @returns {{ wattHours: number, coveredMs: number }}
 */
function integrateWh(times, kilowatts, from, to) {
  let wattHours = 0;
  let coveredMs = 0;
  for (let index = 0; index < times.length - 1; index++) {
    // pack_kw derives from pack_a at 20 Hz and reaches the ring at up to 2 Hz, so
    // silence past a few seconds is missing data rather than a steady reading.
    if (times[index + 1] - times[index] > MAX_HOLD_MS) {
      continue;
    }
    const start = Math.max(times[index], from);
    const end = Math.min(times[index + 1], to);
    if (end <= start) {
      continue;
    }
    wattHours += -kilowatts[index] * ((end - start) / 3_600_000) * 1000;
    coveredMs += end - start;
  }
  return { wattHours, coveredMs };
}

/**
 * The bike's own consumption figure over the same window, in Wh/km — a cross-check
 * on the integral from a completely different path.
 *
 * `kwh_per_100km` off the Bluetooth hub is the only usable one of the three consumption
 * fields the hub sends. Median rather than mean, and windowed rather than
 * instantaneous, because the raw signal swings between 1 and 495 Wh/km inside one ride.
 * Not the primary reading: it arrives at ~5/min against pack_kw's 2 Hz and stops
 * whenever the Bluetooth link is down, which CAN never is.
 * See docs/dashboard-decisions.md §"The cross-check from the hub".
 * @param {number} now monotonic, from lib/clock.js
 * @returns {number | null}
 */
export function bikeConsumptionWhPerKm(now) {
  const { values } = ringFor("kwh_per_100km").since(ROLLING_WINDOW_MS, now);
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((first, second) => first - second);
  return sorted[Math.floor(sorted.length / 2)] * 10;
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
  if (consumption.state !== "measured" || energy == null) {
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

// --- Charging thermals -------------------------------------------------------
//
// Two numbers that only mean something next to each other: the heat the pack is
// making, and the heat the loop is taking away.

/**
 * Rated delivery of the coolant pump, in litres per hour.
 *
 * Bosch PAD 12 V, part 0 392 023 004: 850 dm³/h at 0.1 bar and 13 V. ⚠️ There is no flow
 * sensor on this bike, so this is the one number here that is SPECIFIED rather than
 * measured, and it is an UPPER bound — everything derived from it inherits that.
 *
 * Independently supported to within 8% by an energy balance over the 40-minute DC charge
 * of 2026-08-09, which is why it is worth showing at all:
 * docs/dashboard-decisions.md §"Coolant flow is specified, not measured".
 */
export const COOLANT_FLOW_LPH = 850;

/** 50/50 ethylene glycol: ~3800 J/(kg·K), ~1.05 kg/L. Water would be 4180 and 1.0. */
const COOLANT_SPECIFIC_HEAT_J_PER_KG_K = 3800;
const COOLANT_DENSITY_KG_PER_L = 1.05;

/** Watts the loop carries away per kelvin of ΔT across the pack, at rated flow. */
export const COOLANT_WATTS_PER_KELVIN =
  (COOLANT_FLOW_LPH / 3600) * COOLANT_DENSITY_KG_PER_L * COOLANT_SPECIFIC_HEAT_J_PER_KG_K;

/**
 * Heat the loop is currently removing, in watts.
 *
 * ṁ·cp·ΔT, with ṁ assumed from the pump's rating — so this inherits every caveat on
 * COOLANT_FLOW_LPH above and is a best estimate, not a measurement. ΔT itself is
 * measured, and it is the term that actually moves.
 * @returns {number | null}
 */
export function coolantHeatRemovedWatts() {
  const delta = coolantDelta();
  if (delta == null) {
    return null;
  }
  return delta * COOLANT_WATTS_PER_KELVIN;
}
