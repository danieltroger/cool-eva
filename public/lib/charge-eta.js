// @ts-check

import { ringFor } from "./ring.js";
import { monotonicNow } from "./clock.js";

// How long until the charge reaches the limit — the arithmetic, with no rendering in it. The tile
// is ./../views/charge-eta.js; this is what scripts/check-charge-eta.ts exercises.
//
// ⚠️ It prices an SOC point in ENERGY and divides by measured power. It does NOT time the SOC
// steps, which was the first design: replayed against the archive, energy ÷ power is unbiased on
// AC (median predicted/actual 1.00) where a median-of-3-step-intervals runs 8 % optimistic with
// twice the dispersion. Differencing whole-percent LEVELS does carry ±1 point of quantisation —
// but this has no SOC term to quantise, so it was never exposed to it.
//
// Every figure below is measured, and docs/charge-eta.md has the tables and the method.

/**
 * What the pack ABSORBS per SOC point, integrated from `pack_kw` across the archive's charging
 * runs: AC n=10 median 198.8, DC n=34 median 199.7, measured between SOC transition instants.
 *
 * ⚠️ A compromise good to about ±5 %: within DC it drifts 188.6 Wh (20-29 %) to 208.1 (80-89 %),
 * so it runs slightly optimistic where a charge limit sits. And it is emphatically NOT
 * `residual_energy_wh ÷ soc`, which is discharge-side, nor the 21.5 kWh nameplate — both were
 * tried and both were wrong. Why, and in which direction: docs/charge-eta.md.
 */
export const WH_PER_SOC_POINT = 199;

/**
 * The power below which there is no answer worth giving.
 *
 * ⚠️ A floor, not a zero test: at 0.02 kW the arithmetic returns a forty-day ETA, which is not an
 * answer. It doubles as the stall rule — a stalled charge reads below this, and `charge_manager_state`
 * demonstrably does NOT move during one (it stayed put through all five of the archive's longest).
 */
export const MIN_CHARGE_KW = 0.1;

/**
 * The target at and above which only a LOWER BOUND is honest.
 *
 * ⚠️ 100, and the boundary is measured rather than borrowed. Predicted/actual by target: 88 → 0.81
 * DC / 0.95 AC, 90 → 0.82/0.96, 99 → 0.68/0.92, then 100 → 0.39/0.78. One discontinuity, between 99
 * and 100. The last step's own durations are too few to carry more than that (7 archive-wide, all
 * AC, none DC), so the table is the evidence, not the step.
 *
 * ⚠️ It is NOT `SOC_RATE_TRUSTED_BELOW` (88) from src/charge/soc.ts. That was measured for a
 * trailing-rate DC controller and says so; a different instrument measures its own boundary, and
 * borrowing it would refuse a real time for targets 90-99 — exactly the range the charge limit sets.
 */
export const BOUND_AT_OR_ABOVE = 100;

/** How far back to look for a representative charging power. */
export const SMOOTH_MS = 60_000;

/** Fewer samples than this in the window and the newest reading is used instead. */
export const MIN_SMOOTH_SAMPLES = 3;

/**
 * @typedef {{ kind: "estimate" | "bound", minutes: number }
 *   | { kind: "none", why: string }} ChargeEta
 */

/**
 * Minutes until `targetPct`, or why there is no answer. Pure.
 *
 * `kind` is `"bound"` at and above BOUND_AT_OR_ABOVE: the figure is then a floor rather than an
 * estimate, because the pack's own taper takes the last point and nothing here models it.
 *
 * @param {{ socPct: number | null, targetPct: number | null, kw: number | null }} input
 * @returns {ChargeEta}
 */
export function chargeEta({ socPct, targetPct, kw }) {
  if (socPct === null || !Number.isFinite(socPct)) {
    return { kind: "none", why: "no state of charge" };
  }
  if (targetPct === null || !Number.isFinite(targetPct)) {
    return { kind: "none", why: "no target" };
  }
  if (targetPct <= socPct) {
    return { kind: "none", why: "already there" };
  }
  if (kw === null || !Number.isFinite(kw) || kw < MIN_CHARGE_KW) {
    // Covers not charging, a stalled charge and a discharging pack in one rule, because all three
    // are the same question — is enough going in to divide by.
    return { kind: "none", why: "not charging" };
  }
  // watt-hours needed ÷ watts in, turned into minutes.
  const minutes = (((targetPct - socPct) * WH_PER_SOC_POINT) / (kw * 1000)) * 60;
  return { kind: targetPct >= BOUND_AT_OR_ABOVE ? "bound" : "estimate", minutes };
}

/**
 * A representative charging power: the median of `pack_kw` over the last SMOOTH_MS, or the newest
 * reading when the window holds fewer than MIN_SMOOTH_SAMPLES.
 *
 * ⚠️ `pack_kw` does NOT arrive at 20 Hz — `notifyChange` sits inside `record()`'s deadband branch,
 * so the patch stream is the ride log's row stream (AC p10 0.5 rows/min). A 60 s window can hold
 * nothing, and the fallback is correct rather than a concession: silence on a log-on-change signal
 * means UNCHANGED. Rates and the rest: docs/charge-eta.md.
 *
 * @param {number} [now] monotonic; defaults to now. Passed in by the check.
 * @returns {number | null}
 */
export function smoothedChargeKw(now = monotonicNow()) {
  const ring = ringFor("pack_kw");
  const { values } = ring.since(SMOOTH_MS, now);
  if (values.length < MIN_SMOOTH_SAMPLES) {
    return ring.latest();
  }
  return median(values);
}

/**
 * The middle value of a copy, so the caller's array is left alone.
 * @param {number[]} values
 * @returns {number}
 */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}
