import { estimateHeatingRate, type TemperatureSample } from "./rate.ts";
import { CHARGE_MANAGER_STATE_DC } from "../fan/curve.ts";

// What current to command during a DC fast charge, so the pack does not reach the cliff. Pure —
// readings in, a decision out, no I/O and no clock read. The half that touches the world is
// ./auto.ts, the same split as src/fan/curve.ts and src/fan/auto.ts.
//
// The rule, whole: command the ceiling while the observed heating rate says the cliff is more than
// a reaction horizon away; step down while it says otherwise; hold in between. There is no target
// temperature and no thermal model — the rate IS the measurement of the cooling, so sun, wind, fan
// duty and ambient all arrive already accounted for, and it needs no departure time because it
// never aims at one. docs/charge-auto.md has the derivations and the limits.

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
  /** The rider moved the dial on the bike. Stood down for the rest of the session. */
  RIDER: 4,
  /** Too little history to see a rate yet, and the pack is not hot enough to act blind. */
  NO_HISTORY: 5,
  /** Too little history to see a rate, and the pack is hot: descending on the bound. */
  BLIND_DESCENT: 6,
  /** Close enough to the cliff that a merely-bounded rate is not worth trusting. */
  HARD_CEILING: 7,
  /** The rate says the cliff is inside the reaction horizon. */
  CLOSING: 8,
  /** The cliff is comfortably far; giving current back. */
  CLEAR: 9,
  /** Inside the hysteresis band — the current is right. */
  SETTLED: 10,
  /** Already at the floor and still closing: nothing left to give up. */
  AT_FLOOR: 11,
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
 * How much warning the controller needs to bend the curve before the cliff.
 *
 * ⚠️ Sized by simulating the closed loop, not chosen: at 5 minutes the simulated peak is
 * 54.0-54.3 °C, inside ONE quantisation step of the cliff on a whole-degree sensor read against a
 * two-anchor model — which is not a margin. At 8 the peak is 51.7-52.7 for 3-11 % of mean current.
 * ⚠️ Coupled to RATE_WINDOW_MS: the horizon must cover the estimator's own lag (half the window)
 * plus the descent, so shortening the window without revisiting this breaks the sizing.
 */
export const HORIZON_MIN = 8;

/**
 * Where the controller stops trusting a merely-bounded rate and descends anyway.
 *
 * Binds only when the rate is small; below it a bound of 0.2 K/min still leaves 10 minutes, more
 * than the horizon. Its job is to stop a bounded rate from stepping the current back UP right next
 * to the cliff, and on the two hot 2026-09-07 replays it is the branch that fires most.
 */
export const HARD_CEILING_C = 53;

/** Above this, no history at all justifies descending blind. Below it, wait and watch. */
export const BLIND_DESCENT_FROM_C = 50;

/**
 * The floor, and ⚠️ THE ONE KNOB THAT MATTERS. Capping below this is worse than doing nothing: the
 * cliff's saw-tooth averages a MEASURED 35.3 A duty-weighted (1.30 min per SOC point), so
 * break-even is `0.53 × 72.6 / 1.30 = 29.6 A` and a 25 A cap is 18 % SLOWER than not acting at all.
 * 35 A is 15 % faster than the saw-tooth, above break-even with margin, and on the dial's own grid.
 */
export const MIN_COMMAND_A = 35;

/** One 5 A step per update — the dash's own dial granularity, so a rider taking over sees the same numbers. */
export const STEP_A = 5;

/** Give current back only when the cliff is this many horizons away. The hysteresis; stops chatter. */
export const RELEASE_FACTOR = 1.5;

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
  const current = input.commandedAmps ?? ceiling;
  const rate = estimateHeatingRate(input.samples, input.nowMs);

  // ⚠️ FIRST, and on temperature ALONE. This used to sit after the `unknown` branch, so whether the
  // ceiling applied depended on whether a rate happened to be measurable — the same mistake as
  // gating it behind an estimate, which only looked safe because BLIND_DESCENT_FROM_C happens to be
  // below it. The check asserts that ordering rather than leaving it to luck.
  if (temperature >= HARD_CEILING_C) {
    return stepTo(current - STEP_A, current, ceiling, CHARGE_AUTO_REASON.HARD_CEILING);
  }
  if (rate.kind === "unknown") {
    // Cannot see. Acting blind is justified only by the pack already being hot — otherwise waiting
    // costs nothing, because a cool pack is minutes of climbing away from mattering.
    if (temperature < BLIND_DESCENT_FROM_C) {
      return { kind: "hold", reason: CHARGE_AUTO_REASON.NO_HISTORY };
    }
    return stepTo(current - STEP_A, current, ceiling, CHARGE_AUTO_REASON.BLIND_DESCENT);
  }
  const minutesToCliff = timeToCliffMinutes(temperature, rate.perMinute);
  if (minutesToCliff <= HORIZON_MIN) {
    return stepTo(current - STEP_A, current, ceiling, CHARGE_AUTO_REASON.CLOSING);
  }
  if (minutesToCliff > HORIZON_MIN * RELEASE_FACTOR) {
    return stepTo(current + STEP_A, current, ceiling, CHARGE_AUTO_REASON.CLEAR);
  }
  return { kind: "hold", reason: CHARGE_AUTO_REASON.SETTLED };
}

/**
 * How long until the pack reaches the cliff at the rate observed, in minutes.
 *
 * A pack that is flat or cooling is never closing, so it gets an infinite answer rather than a
 * division. A `bounded` rate is passed in exactly as a measured one — it is the most the pack CAN
 * be doing, which is the conservative direction for a question about how long there is left.
 */
function timeToCliffMinutes(temperature: number, perMinute: number): number {
  if (perMinute <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  return (CLIFF_C - temperature) / perMinute;
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
  const amps = Math.min(ceiling, Math.max(MIN_COMMAND_A, wanted));
  if (amps === current) {
    return { kind: "hold", reason: amps === MIN_COMMAND_A ? CHARGE_AUTO_REASON.AT_FLOOR : CHARGE_AUTO_REASON.SETTLED };
  }
  return { kind: "command", amps, reason };
}
