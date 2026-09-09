import { estimateHeatingRate, minutesSinceNewestSample, type TemperatureSample } from "./rate.ts";
import { CHARGE_MANAGER_STATE_DC } from "../fan/curve.ts";

// What current to command during a DC fast charge, so the pack does not reach the cliff. Pure —
// readings in, a decision out, no I/O and no clock read. The half that touches the world is
// ./auto.ts, the same split as src/fan/curve.ts and src/fan/auto.ts.
//
// The rule, whole: hold the pack AT 54 °C from both directions. One line does the work —
// `headroomKelvin = (54 − T) − rate × REACTION_MIN`, how far below the setpoint the pack is
// predicted to be one reaction time from now — and the step is proportional to it, bounded, never
// below 1 A. There is still no thermal model: the rate IS the measurement of the cooling, so sun,
// wind, fan duty and ambient arrive already accounted for, and it needs no departure time because
// it never aims at one. docs/charge-auto.md has the derivations, the sweep and the limits.

/** What to do with the charge current this tick. Closed, so the runner cannot invent a case. */
export type ChargeAutoDecision =
  /** Send this many amps. Only ever emitted when every precondition held. */
  | { kind: "command"; amps: number; reason: ChargeAutoReason }
  /** Do nothing this tick, and why. The safe answer, and the default for anything unknown. */
  | { kind: "hold"; reason: ChargeAutoReason };

/**
 * Why the controller did what it did. Recorded as `charge_auto_reason` and shown on the charge tab,
 * so the codes are the vocabulary of both — the same shape as FAN_REASON in src/fan/curve.ts.
 */
export const CHARGE_AUTO_REASON = {
  /** Switched off, by env var or from the dashboard. */
  DISABLED: 0,
  /** No settled DC session to command into. ⚠️ DC only — see the note on `chargeManagerState`. */
  NOT_DC: 1,
  /** `batt_temp_hi` missing, stale or outside the plausible range. The fail-safe. */
  NO_TEMPERATURE: 2,
  /** `fast_dc_limit_max_a` has never arrived, so there is no ceiling to command against. */
  NO_CEILING: 3,
  /** The rider set a current that is not the one we asked for. Stood down for this charge. */
  RIDER: 4,
  /** Too little history to see a rate yet, and the pack is not hot enough to act blind. */
  NO_HISTORY: 5,
  /** Too little history to see a rate, and the pack is hot: descending on the bound. */
  BLIND_DESCENT: 6,
  /** At or above the setpoint (or past the cliff): reducing, because the reading itself says so. */
  HARD_CEILING: 7,
  /** Below the setpoint but heating towards it faster than the reaction time allows. */
  CLOSING: 8,
  /** Predicted to stay below the setpoint with room to spare; giving current back. */
  CLEAR: 9,
  /** Below the setpoint and inside the sensor's own half-degree; the current is right. */
  SETTLED: 10,
  /** Already at the floor and still closing: nothing left to give up. */
  AT_FLOOR: 11,
  /** At the setpoint and not heating: holding this current, and never raising from here. */
  NEAR_CEILING: 12,
} as const;

export type ChargeAutoReason = (typeof CHARGE_AUTO_REASON)[keyof typeof CHARGE_AUTO_REASON];

/**
 * The cliff. At a TRUE 55 °C the config-15 BMS clamp releases, the VCU finally sees the real pack
 * temperature, and the DC current collapses to ~19.5 A — measured 2026-09-07, twice, at a cost of
 * 42 minutes over two stops.
 *
 * ⚠️ A DERIVATION, not a preference: 55 is `LIMP_B_TEMP` and the clamp's release point, and it moves
 * if the BMS config or that parameter moves.
 */
export const CLIFF_C = 55;

/**
 * The setpoint. The controller holds the pack here from BOTH directions.
 *
 * ⚠️ Daniel watched the pack sit at 54 for a long time without touching 55 with the controller off,
 * so the equilibrium exists and charging below it leaves range on the table — the hotter the pack,
 * the larger the coolant-to-pack ΔT and the more heat the loop pulls out. `batt_temp_hi` is WHOLE
 * degrees, so a reading of 54 means anywhere in [54, 55): that is why nothing may RAISE from here,
 * and why the 0.5 K deadband below is not applied at or above it. docs/charge-auto.md.
 */
export const TARGET_C = 54;

/**
 * How far ahead the rule looks when deciding whether the pack is heading past the setpoint.
 *
 * ⚠️ The old `HORIZON_MIN` under a new name and aimed one degree lower: `headroomKelvin < 0` is
 * exactly `(TARGET_C − T) / rate < REACTION_MIN`, so this inherits that sizing rather than
 * replacing it. ⚠️ Still coupled to RATE_WINDOW_MS — it must cover the estimator's own lag (half
 * the window) plus the descent, so shortening the window without revisiting this breaks it.
 */
export const REACTION_MIN = 12;

/**
 * The floor, and ⚠️ THE ONE KNOB THAT MATTERS. Capping below this is worse than doing nothing: the
 * cliff's saw-tooth averages a MEASURED 35.3 A duty-weighted (1.30 min per SOC point), so
 * break-even is `0.53 × 72.6 / 1.30 = 29.6 A` and a 25 A cap is 18 % SLOWER than not acting at all.
 * 35 A is 15 % faster than the saw-tooth, above break-even with margin, and on the dial's own grid.
 */
export const MIN_COMMAND_A = 35;

/**
 * How many amps one kelvin of predicted headroom is worth — the loop's gain.
 *
 * ⚠️ A GAIN, not a thermal model: it converts an error into a step and its only job is to be small
 * enough not to oscillate against the estimator's ~5 min lag and large enough to matter. Chosen by
 * the frozen-grid sweep in docs/charge-auto.md, where a gain of 2 gives the fewest cliff crossings
 * AND the least chatter of any feasible point. Under-gaining costs time; over-gaining costs frames
 * and dash flicker. Both are bounded by MAX_STEP_A and by the deadband.
 */
export const AMPS_PER_KELVIN = 2;

/** The bike accepts 1 A (verified against the manual sheet), so the loop is not a coarse ratchet. */
export const MIN_STEP_A = 1;

/**
 * The largest single move, in amps. ⚠️ NOT a preference — every A1-feasible point in the sweep sits
 * here, and a cap of 5 crosses the cliff on 28-30 of the 150 frozen plants against 16 at this value:
 * a proportional law that cannot move faster than the pack is a slower ratchet, not a gentler one.
 */
export const MAX_STEP_A = 15;

/**
 * The deadband, in kelvin of predicted headroom: half a least count of a whole-degree sensor.
 *
 * ⚠️ Derived, not chosen, and applied ONLY BELOW the setpoint. At or above a reading of 54 the pack
 * may be at 54.99 and there is no slack to spend, so any positive rate acts there.
 */
export const QUANTISATION_K = 0.5;

/**
 * How old `batt_temp_hi` may be. Matches TEMPERATURE_FRESH_MS in src/fan/curve.ts and for the same
 * reason: server-side, `ageMs()` is refreshed by every 0x200 frame, so 5 s means the BMS went quiet.
 * ⚠️ A different question from RATE_MIN_SPAN_MS — freshness is per frame, a rate needs value CHANGES.
 */
export const TEMPERATURE_MAX_AGE_MS = 5_000;

/**
 * `charge_manager_state` (0x610 b7) for a settled DC session. AC is not commanded automatically.
 *
 * Re-exported from src/fan/curve.ts rather than re-typed: this was the fifth private copy of the
 * byte, and unlike src/charge/ack-watch.ts's — which says why it keeps its own — nothing here
 * justified a sixth, since this module's runner already imports from that file.
 */
export { CHARGE_MANAGER_STATE_DC } from "../fan/curve.ts";

/** How old that state may be before the session counts as gone. The same 5 s the write runner uses. */
export const CHARGE_SESSION_MAX_AGE_MS = 5_000;

export interface ChargeAutoInput {
  enabled: boolean;
  /** `batt_temp_hi` — the TRUE pack temperature. ⚠️ Never `batt_temp_hi_vcu`, which the clamp flattens. */
  packTemperatureC: number | null;
  packTemperatureAgeMs: number | null;
  /** Whether that reading is inside the physically plausible band. The caller applies the gate. */
  packTemperaturePlausible: boolean;
  /** `charge_manager_state` and its age. DC only. */
  chargeManagerState: number | null;
  chargeManagerStateAgeMs: number | null;
  /** `fast_dc_limit_max_a`. Never fabricated — absent means CAN is not being received. */
  ceilingAmps: number | null;
  /** What this controller last commanded, or null if it has not commanded yet this session. */
  commandedAmps: number | null;
  /** True once the rider has moved the dial on the bike this session. */
  riderOverride: boolean;
  /** The temperature ring, and the monotonic reading to judge it against. */
  samples: TemperatureSample[];
  nowMs: number;
}

/**
 * Decides the charge current for one tick. Pure.
 *
 * ⚠️ Every unknown returns `hold`, never a current. On stale or implausible temperature, no session,
 * no ceiling or a rider override the controller does NOTHING — which leaves the bike charging
 * exactly as it does today. That is the whole safety posture: this can only ever improve on the
 * status quo, never make it worse.
 */
export function decideChargeCurrent(input: ChargeAutoInput): ChargeAutoDecision {
  if (!input.enabled) {
    return { kind: "hold", reason: CHARGE_AUTO_REASON.DISABLED };
  }
  if (input.riderOverride) {
    return { kind: "hold", reason: CHARGE_AUTO_REASON.RIDER };
  }
  if (
    input.chargeManagerState !== CHARGE_MANAGER_STATE_DC ||
    input.chargeManagerStateAgeMs === null ||
    input.chargeManagerStateAgeMs > CHARGE_SESSION_MAX_AGE_MS
  ) {
    return { kind: "hold", reason: CHARGE_AUTO_REASON.NOT_DC };
  }
  if (
    input.packTemperatureC === null ||
    !input.packTemperaturePlausible ||
    input.packTemperatureAgeMs === null ||
    input.packTemperatureAgeMs > TEMPERATURE_MAX_AGE_MS
  ) {
    return { kind: "hold", reason: CHARGE_AUTO_REASON.NO_TEMPERATURE };
  }
  if (input.ceilingAmps === null) {
    return { kind: "hold", reason: CHARGE_AUTO_REASON.NO_CEILING };
  }

  const temperature = input.packTemperatureC;
  const ceiling = input.ceilingAmps;
  // ⚠️ FLOORED, both of them. The plant's ceiling is 72.6 A and the bike refuses a non-integer, so
  // an unfloored `current` makes the rule command 72 while already at 72.6 and call that acting —
  // which failed the cold-plant assertion outright and moved the frozen-grid crossing count.
  const current = Math.floor(input.commandedAmps ?? ceiling);
  const rate = estimateHeatingRate(input.samples, input.nowMs);

  // ⚠️ FIRST, and on temperature ALONE: at or past the cliff the clamp has already released, so the
  // reading is no longer evidence about anything except that we are too late. Give up the most the
  // rule is allowed to give up in one move.
  if (temperature >= CLIFF_C) {
    return stepTo(current - MAX_STEP_A, current, ceiling, CHARGE_AUTO_REASON.HARD_CEILING);
  }
  if (rate.kind === "unknown") {
    if (temperature < TARGET_C) {
      return { kind: "hold", reason: CHARGE_AUTO_REASON.NO_HISTORY };
    }
    return stepTo(current - blindStepAmps(input), current, ceiling, CHARGE_AUTO_REASON.BLIND_DESCENT);
  }

  // ⚠️ AT THE SETPOINT, A BOUND IS NOT EVIDENCE OF HEATING. `bounded` is strictly positive by
  // construction — it says only "the reading did not move" — so feeding it into the law below at a
  // reading of 54, where the headroom is already clamped to at most 0, guarantees a step down every
  // single tick. That is #163's "descend because it is stable" one level up, and it made the hold
  // Daniel asked for unreachable: NEAR_CEILING fired 0 times in 6 770 ticks of the frozen grid, and
  // a pack sitting perfectly still at 54 for fifteen minutes was still being ratcheted down. Only a
  // FITTED slope can establish that a pack at the setpoint is heating; a pack past the cliff is
  // handled above, on temperature alone, where no rate is needed.
  if (temperature >= TARGET_C && rate.kind === "bounded") {
    return { kind: "hold", reason: CHARGE_AUTO_REASON.NEAR_CEILING };
  }

  // The whole rule: how far below the setpoint the pack is predicted to be one reaction time from
  // now. Positive is room to give, negative is a move to take back. ⚠️ `headroomKelvin < 0` is
  // algebraically the shipped time-to-cliff test aimed at 54 instead of 55, which is why the steep
  // -heating guard needs no branch of its own — it IS this line.
  let headroomKelvin = TARGET_C - temperature - rate.perMinute * REACTION_MIN;
  // ⚠️ Never raise at or above the setpoint. A reading of 54 can be a true 54.99, and this is the
  // surviving half of the quantisation argument the 53/54 tiers were built on.
  if (temperature >= TARGET_C) {
    headroomKelvin = Math.min(headroomKelvin, 0);
  }
  if (temperature < TARGET_C && Math.abs(headroomKelvin) < QUANTISATION_K) {
    return { kind: "hold", reason: CHARGE_AUTO_REASON.SETTLED };
  }
  if (headroomKelvin === 0) {
    return { kind: "hold", reason: CHARGE_AUTO_REASON.NEAR_CEILING };
  }
  const step = Math.min(MAX_STEP_A, Math.max(MIN_STEP_A, Math.round(AMPS_PER_KELVIN * Math.abs(headroomKelvin))));
  if (headroomKelvin > 0) {
    return stepTo(current + step, current, ceiling, CHARGE_AUTO_REASON.CLEAR);
  }
  const lowering = temperature >= TARGET_C ? CHARGE_AUTO_REASON.HARD_CEILING : CHARGE_AUTO_REASON.CLOSING;
  return stepTo(current - step, current, ceiling, lowering);
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
function blindStepAmps(input: ChargeAutoInput): number {
  const silentMinutes = minutesSinceNewestSample(input.samples, input.nowMs);
  if (silentMinutes === null || silentMinutes <= 0) {
    return MAX_STEP_A;
  }
  const deficitKelvin = REACTION_MIN / silentMinutes;
  return Math.min(MAX_STEP_A, Math.max(MIN_STEP_A, Math.round(AMPS_PER_KELVIN * deficitKelvin)));
}

/**
 * One step, clamped, and a hold when the clamp leaves it where it already was.
 *
 * ⚠️ The floor is the guarantee, not the law: below MIN_COMMAND_A the feature is worse than doing
 * nothing, so the descent stops there and says `AT_FLOOR` rather than pretending it acted.
 */
function stepTo(wanted: number, current: number, ceiling: number, reason: ChargeAutoReason): ChargeAutoDecision {
  // ⚠️ A station offering less than the floor leaves nothing to give up: clamping the floor LAST
  // would command 35 A into a 20 A ceiling, which is above the station's own maximum and a frame the
  // builder refuses outright. Hold instead of asking for something invalid every minute.
  if (ceiling <= MIN_COMMAND_A) {
    return { kind: "hold", reason: CHARGE_AUTO_REASON.AT_FLOOR };
  }
  const amps = Math.min(Math.floor(ceiling), Math.max(MIN_COMMAND_A, Math.round(wanted)));
  if (amps === current) {
    return { kind: "hold", reason: amps === MIN_COMMAND_A ? CHARGE_AUTO_REASON.AT_FLOOR : CHARGE_AUTO_REASON.SETTLED };
  }
  return { kind: "command", amps, reason };
}
