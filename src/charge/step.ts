import { AMPS_PER_KELVIN, MAX_STEP_A, MIN_STEP_A, QUANTISATION_K, REACTION_MIN } from "./auto-curve.ts";
import { minutesSinceNewestSample, type TemperatureSample } from "./rate.ts";

// How many amps one move is worth. Pure — an estimate and a headroom in, a step out. What the move
// is FOR is ./auto-curve.ts; this is only its size.
//
// ⚠️ THE SIZE IS WHERE #276 LIVES, not the direction. The rule this replaces read a bound as a
// rate, and a bound is a CONSTANT 0.1 K/min on a still ring — so `(54 − T) − 1.2` is the same
// number every tick for ever. Below a reading of 53 that walks the command to the ceiling and at
// 53 it tips the deadband and freezes at the floor: both halves are one wrong multiplicand.

/**
 * How much of the headroom a pack that has not risen has actually EARNED, and ⚠️ THE ANTI-WINDUP
 * THE PHANTOM USED TO PROVIDE. Two terms come off the distance to the setpoint:
 *
 * - `QUANTISATION_K`, because a reading of T means [T, T+1) and a raise must assume the worse half.
 *   ⚠️ Subtracted on THIS ARM ONLY. A fitted slope brings independent evidence that the pack is
 *   moving, so truncation is not its whole error budget; #181 tried the correction at every
 *   temperature and measured a COLDER equilibrium for it (docs/charge-auto.md § "Superseded: the
 *   two tiers at 53 and 54, and what survives them"). This is half that magnitude and gated.
 * - `REACTION_MIN / t`, the silence's own bound — unmoved for `t` minutes means under `1/t` K/min
 *   — which is the substitution `blindStepAmps` below already makes, so the two rest on one
 *   measurement rather than two guesses. It DECAYS: the longer the pack proves it is still, the
 *   more of the headroom it may spend.
 */
export function confidentHeadroomKelvin(samples: TemperatureSample[], nowMs: number, headroomKelvin: number): number {
  const silentMinutes = minutesSinceNewestSample(samples, nowMs);
  return silentMinutes === null ? 0 : headroomKelvin - QUANTISATION_K - REACTION_MIN / silentMinutes;
}

/**
 * Kelvin of spendable headroom into amps: the loop's gain, bounded at both ends.
 *
 * ⚠️ ONE COPY. It was written out three times — both arms of the old `stepAmps` and the blind
 * descent — in the one file whose subject is how big a move is.
 */
export function clampedStep(kelvin: number): number {
  return Math.min(MAX_STEP_A, Math.max(MIN_STEP_A, Math.round(AMPS_PER_KELVIN * kelvin)));
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
export function blindStepAmps(samples: TemperatureSample[], nowMs: number): number {
  // No samples at all is the only case with no bound to read. A zero silence needs no branch of its
  // own: `REACTION_MIN / 0` is Infinity, which the clamp below turns into MAX_STEP_A anyway.
  const silentMinutes = minutesSinceNewestSample(samples, nowMs);
  return silentMinutes === null ? MAX_STEP_A : clampedStep(REACTION_MIN / silentMinutes);
}
