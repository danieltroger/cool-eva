import {
  AMPS_PER_KELVIN,
  MAX_STEP_A,
  MIN_STEP_A,
  QUANTISATION_K,
  REACTION_MIN,
  type ChargeAutoInput,
} from "./auto-curve.ts";
import { minutesSinceNewestSample, type HeatingRate } from "./rate.ts";

// How many amps one move is worth. Pure — an estimate and a headroom in, a step out. What the move
// is FOR is ./auto-curve.ts; this is only its size.
//
// ⚠️ THE SIZE IS WHERE #276 LIVES, not the direction. The rule this replaces read a bound as a
// rate, and a bound is a CONSTANT 0.1 K/min on a still ring — so `(54 − T) − 1.2` is the same
// number every tick for ever. Below a reading of 53 that walks the command to the ceiling and at
// 53 it tips the deadband and freezes at the floor: both halves are one wrong multiplicand.

/**
 * The rate the headroom line may spend. A bound is not one; a reading that did not rise measures 0.
 *
 * ⚠️ `unknown` never reaches here — `decideChargeCurrent` answers it above — and the arms are named
 * rather than defaulted so a fifth one cannot inherit a silent zero.
 */
export function measuredRatePerMinute(rate: HeatingRate): number {
  return rate.kind === "rate" || rate.kind === "bounded" ? rate.perMinute : 0;
}

/**
 * How many amps this tick may move, and ⚠️ THE ANTI-WINDUP THE PHANTOM USED TO PROVIDE.
 *
 * On a `not-rising` answer the step is sized from the CONFIDENT headroom below rather than from
 * the headroom itself — the same gain over a smaller number. MEASURED on a still ring from the
 * floor over thirty minutes, the rule this replaces reaches the 80 A ceiling at a reading of 50,
 * 51 and 52 alike; with the silence subtracted the same probe reaches 59 A at 51 and 47 at 52.
 */
export function stepAmps(input: ChargeAutoInput, rate: HeatingRate, headroomKelvin: number): number {
  if (rate.kind === "not-rising") {
    return Math.min(
      MAX_STEP_A,
      Math.max(MIN_STEP_A, Math.round(AMPS_PER_KELVIN * confidentHeadroomKelvin(input, headroomKelvin)))
    );
  }
  return Math.min(MAX_STEP_A, Math.max(MIN_STEP_A, Math.round(AMPS_PER_KELVIN * Math.abs(headroomKelvin))));
}

export function confidentHeadroomKelvin(input: ChargeAutoInput, headroomKelvin: number): number {
  const silentMinutes = minutesSinceNewestSample(input.samples, input.nowMs);
  return silentMinutes === null ? 0 : headroomKelvin - QUANTISATION_K - REACTION_MIN / silentMinutes;
}

/**
 * How far to descend with no fitted slope to descend on.
 *
 * ⚠️ Sized from the SILENCE, not from a constant: the reading has not moved for `t` minutes, so the
 * rate is under `1/t`, and substituting that bound into `headroomKelvin` at the setpoint leaves
 * `REACTION_MIN / t` kelvin of deficit. Same bound the estimator's cap uses, so the blind branch
 * and the headline fix rest on one measurement rather than two guesses. No samples at all is the
 * one case with no bound to read, and it takes the largest step the rule allows — a pack reading
 * ≥ 54 with no history whatsoever is the least safe thing this branch ever sees.
 *
 * ⚠️ It SATURATES: this branch only runs while the span is under RATE_MIN_SPAN_MS, and the silence
 * cannot exceed the span, so for short silences the deficit exceeds the cap and the step is simply
 * MAX_STEP_A. The frozen grid therefore cannot tell this apart from a fixed maximum step — the
 * evidence for the derivation is the argument and the unit fixture, not the crossing count.
 */
export function blindStepAmps(input: ChargeAutoInput): number {
  // No samples at all is the only case with no bound to read. A zero silence needs no branch of its
  // own: `REACTION_MIN / 0` is Infinity, which the clamp below turns into MAX_STEP_A anyway.
  const silentMinutes = minutesSinceNewestSample(input.samples, input.nowMs);
  if (silentMinutes === null) {
    return MAX_STEP_A;
  }
  const deficitKelvin = REACTION_MIN / silentMinutes;
  return Math.min(MAX_STEP_A, Math.max(MIN_STEP_A, Math.round(AMPS_PER_KELVIN * deficitKelvin)));
}
