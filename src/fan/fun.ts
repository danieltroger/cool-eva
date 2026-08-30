import { MAX_DUTY_PERCENT, MIN_RUNNING_DUTY_PERCENT } from "./control.ts";

// Fun mode: the rider's throttle drives the radiator fan, and the gate that decides
// whether it is allowed to. Both are arithmetic and nothing else — values in, an answer
// out, no signal lookups, no clock reads, no I/O — the way ./curve.ts and ../can/decode
// .ts are, so a bike in Go, a bus going silent and a throttle sweep are all one function
// call in scripts/check-fan-fun.ts. ./auto.ts is the half that reads the bus.
//
// ⚠️ THIS MAPS THE THROTTLE OF A 145 hp MOTORCYCLE ONTO A FAN. Every rule here is
// argued in docs/fan-control.md §"Fun mode" — including which signals mean "cannot
// move", which near-miss alternatives were rejected and on what measurements, and why
// the freshness rule below is the exact opposite of ./curve.ts's speed gate.

/**
 * How old a gate signal may be and still count as evidence about the bike.
 *
 * ⚠️ THE OPPOSITE POLARITY TO ./curve.ts's SPEED_MAX_AGE_MS, which is the one thing to
 * hold on to when reading the two together. There, a stale speed OPENS the gate, because
 * a parked bike stops broadcasting 0x104 and a hot pack in a garage is what the fan is
 * for. Here, a stale anything CLOSES it: this gate has to prove the bike cannot move,
 * and a signal nobody is refreshing proves nothing.
 *
 * 500 ms is 50 consecutive missed frames of 0x102 and 0x104, both of which broadcast at
 * ~100 Hz whenever the bus is awake at all — measured at 99.98 Hz through a DC session
 * and 100 Hz through the awake stretches of an AC one.
 */
export const FUN_GATE_MAX_AGE_MS = 500;

/**
 * How often the gate is re-checked while fun mode runs, on top of the change events that
 * drive it.
 *
 * ⚠️ Not the duty's cadence — the duty follows every `throttle_pct` change, so this is
 * only the case events cannot cover: a bus that has gone SILENT produces no change to
 * react to, and the fan would otherwise sit at the throttle's last duty for ever.
 */
export const FUN_WATCHDOG_MS = 250;

/** Why fun mode is or is not available. Published as `fan_fun_gate` for the dashboard. */
export const FUN_GATE = {
  /** Every condition holds: the bike cannot move and the throttle is readable. */
  READY: 0,
  /** `go` is set — the drive is enabled and the bike CAN move. */
  GO_SET: 1,
  /** `speed_can_kmh` is not zero. */
  MOVING: 2,
  /** No fresh `go`. Absent, stale, or not a number — all of which fail closed. */
  GO_UNKNOWN: 3,
  /** No fresh `speed_can_kmh`. */
  SPEED_UNKNOWN: 4,
  /** No fresh `throttle_pct`, so there is nothing to steer the fan with. */
  THROTTLE_UNKNOWN: 5,
} as const;

export type FunGate = (typeof FUN_GATE)[keyof typeof FUN_GATE];

/**
 * Why a request to enter fun mode was refused, in the Pi's own words — `/fan` hands
 * these straight to the dashboard's outcome line.
 *
 * Typed `Record<FunGate, string>` on purpose: adding a code to FUN_GATE above without a
 * sentence here does not compile, so no refusal can ever reach a rider as a bare number.
 * The dashboard's own FUN_GATE_TEXT answers a different question — why the button is not
 * there — and public/lib/fan-display.js holds those words, since they have to stay live.
 */
export const FUN_GATE_REFUSAL: Record<FunGate, string> = {
  [FUN_GATE.READY]: "the bike is parked and the throttle is readable",
  [FUN_GATE.GO_SET]: "the bike is in Go — it can move, so the throttle is not available for the fan",
  [FUN_GATE.MOVING]: "the bike is moving",
  [FUN_GATE.GO_UNKNOWN]: "no fresh `go` off 0x102, so there is nothing saying the bike cannot move",
  [FUN_GATE.SPEED_UNKNOWN]: "no fresh `speed_can_kmh` off 0x104, so there is nothing saying the bike is stopped",
  [FUN_GATE.THROTTLE_UNKNOWN]: "no fresh `throttle_pct` off 0x109, so there is nothing to drive the fan with",
};

export interface FunGateInputs {
  /** `go` (0x102 b1 bit3), or null when it is absent, stale or not finite. */
  go: number | null;
  /** `speed_can_kmh` (0x104), or null on the same terms. */
  speedKmh: number | null;
  /** `throttle_pct` (0x109), or null on the same terms. */
  throttlePercent: number | null;
}

/**
 * Whether the throttle may drive the fan right now, and if not, which condition failed.
 *
 * ⚠️ FAILS CLOSED BY CONSTRUCTION: every branch that is not the last line returns a
 * refusal, so a null, a NaN or a value nobody anticipated is a refusal too. The only way
 * to reach READY is for all three signals to be present, fresh and to read the specific
 * values that mean a stationary bike with the drive disabled.
 *
 * The order is the order the answers are worth reporting in: what the bike is doing
 * first, then what could not be established about it.
 */
export function funGate(inputs: FunGateInputs): FunGate {
  if (inputs.go === null || !Number.isFinite(inputs.go)) {
    return FUN_GATE.GO_UNKNOWN;
  }
  if (inputs.go !== 0) {
    return FUN_GATE.GO_SET;
  }
  if (inputs.speedKmh === null || !Number.isFinite(inputs.speedKmh)) {
    return FUN_GATE.SPEED_UNKNOWN;
  }
  // Exactly zero, with no tolerance band. `speed_can_kmh` is `motor_rpm_can / 42`, so a
  // turning wheel is a non-zero reading; it read exactly 0 in 317 780 of 317 780 frames
  // through a 77-minute charge. A bike being rolled by hand therefore drops fun mode,
  // which is the right answer — it is moving.
  if (inputs.speedKmh !== 0) {
    return FUN_GATE.MOVING;
  }
  if (inputs.throttlePercent === null || !Number.isFinite(inputs.throttlePercent)) {
    return FUN_GATE.THROTTLE_UNKNOWN;
  }
  return FUN_GATE.READY;
}

/** The one value of FUN_GATE that lets the throttle through. */
export function funGateAllows(gate: FunGate): boolean {
  return gate === FUN_GATE.READY;
}

/**
 * Throttle percent onto fan duty: closed is the floor, wide open is the cap.
 *
 * ⚠️ The bottom of the range is MIN_RUNNING_DUTY_PERCENT, not 0, so **no throttle
 * position anywhere stops the fan**. That is deliberate and it is what makes the mode
 * cheap: no duty in the range crosses ./control.ts's stop threshold, so the bridge
 * enables are set once on entry and cleared once on exit and a throttle movement never
 * spawns `pinctrl`. You leave the mode to stop the fan.
 *
 * ⚠️ And the answer is a FRACTIONAL percent, deliberately not rounded. The PWM period is
 * 50 000 ns and `throttle_pct` resolves 0.1 %, which is 35 ns of duty per step — about
 * 1.75 counts of the ~2500 the period holds. Rounding to whole percent here would throw
 * away 14 of every 15 throttle steps, and hearing where the resolution actually runs out
 * is the whole point of the mode. docs/fan-control.md §"Fun mode".
 */
export function funDutyPercent(throttlePercent: number): number {
  if (!Number.isFinite(throttlePercent)) {
    // The floor rather than a throw or a 0: this is downstream of a gate that already
    // refuses a non-finite throttle, so reaching it means something upstream changed —
    // and a fan at the floor is the safe reading of "no idea what the rider wants".
    return MIN_RUNNING_DUTY_PERCENT;
  }
  const fraction = Math.min(Math.max(throttlePercent, 0), 100) / 100;
  return MIN_RUNNING_DUTY_PERCENT + fraction * (MAX_DUTY_PERCENT - MIN_RUNNING_DUTY_PERCENT);
}
