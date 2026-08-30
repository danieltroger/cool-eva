import { latestValue, record, type LiveValue } from "../can/signals.ts";
import type { FanController } from "./control.ts";
import type { FanMode } from "./auto.ts";
import { FUN_GATE_MAX_AGE_MS, funDutyPercent, funGate, funGateAllows, type FunGate } from "./fun.ts";

// The half of fun mode that touches the world: it reads three signals off the bus, hands
// them to the pure gate and mapping in ./fun.ts, and drives ./control.ts with the answer.
// Nothing here decides a duty or a verdict — that is all next door, so it can be replayed.
//
// ⚠️ ./auto.ts owns the MODE and every transition between the three. This file only ever
// asks to be let go, through `handBackToCurve`, so "what can take the fan out of fun
// mode" stays one function in one file. docs/fan-control.md §"Fun mode".

/**
 * What one fun-mode session needs from the loop that owns it. `AutoContext` in ./auto.ts
 * satisfies this structurally, which is what keeps the two files from importing each
 * other's state.
 */
export interface FunRunnerContext {
  controller: FanController;
  /** Read, never written here. */
  mode: FanMode;
  /** What the loop last got the controller to accept, so a still throttle writes nothing. */
  lastCommandedPercent: number | null;
  /** The last gate answer, for `/fan` and for the dashboard's show-or-hide. */
  funGate: FunGate;
  /** Whether a fun-mode duty is on its way to the bridge. See driveFun(). */
  funCommandInFlight: boolean;
  /** Whether the throttle moved again while one was. */
  funPending: boolean;
  /** Hands the fan back to the temperature curve, because the bike can move again. */
  handBackToCurve: (gate: FunGate) => Promise<void>;
  /** A signal's value, or null when it is absent, stale, or not a finite number. */
  freshValue: (key: string, maxAgeMs: number) => number | null;
}

/** The three keys a fun-mode duty depends on, so a batch without any of them is skipped. */
const FUN_KEYS = ["throttle_pct", "go", "speed_can_kmh"];

/**
 * One pass of fun mode: check the gate, map the throttle, command the fan.
 *
 * ⚠️ The gate is re-checked HERE, on the same pass that computes the duty, so there is no
 * arrangement of events under which a duty is applied against a gate nobody looked at. A
 * closed gate hands the fan back immediately — not at the next 2 s tick and not at the
 * next event either, because `go` going 1 IS an event and this runs on it.
 *
 * ⚠️ And it is not re-entrant. Events arrive at ~100 Hz while the throttle sweeps and
 * every pass awaits a sysfs write, so overlapping passes would queue commands in
 * ./control.ts without bound. The in-flight flag makes a pass that arrives during one
 * mark the work instead, and the loop below picks the LATEST throttle up when the write
 * lands — so a burst costs one extra pass rather than one per event, and never leaves the
 * fan on a duty the rider has already moved past.
 */
export async function driveFun(context: FunRunnerContext): Promise<void> {
  if (context.funCommandInFlight) {
    context.funPending = true;
    return;
  }
  context.funCommandInFlight = true;
  try {
    do {
      context.funPending = false;
      const gate = refreshGate(context);
      if (!funGateAllows(gate)) {
        await context.handBackToCurve(gate);
        return;
      }
      const dutyPercent = funDutyPercent(latestValue("throttle_pct") ?? 0);
      if (dutyPercent === context.lastCommandedPercent) {
        continue;
      }
      const outcome = await context.controller.setDutyPercent(dutyPercent);
      // Forgotten on failure so the next throttle movement re-commands rather than
      // believing a duty that never reached the bridge, exactly as the curve does.
      context.lastCommandedPercent = outcome.ok ? dutyPercent : null;
    } while (context.funPending && context.mode === "fun");
  } finally {
    context.funCommandInFlight = false;
  }
}

/**
 * Re-reads the gate off the bus and publishes it. Returns what it found.
 *
 * ⚠️ `freshValue` answers null for absent, stale and non-finite alike, and ./fun.ts turns
 * every null into a refusal. That is the fail-closed path, and it is why nothing here
 * substitutes a last-known value the way ./auto.ts's sampleTemperature() deliberately
 * does for the pack: a `go` from ten seconds ago is not evidence that the bike is parked
 * now.
 */
export function refreshGate(context: FunRunnerContext): FunGate {
  const gate = funGate({
    go: context.freshValue("go", FUN_GATE_MAX_AGE_MS),
    speedKmh: context.freshValue("speed_can_kmh", FUN_GATE_MAX_AGE_MS),
    throttlePercent: context.freshValue("throttle_pct", FUN_GATE_MAX_AGE_MS),
  });
  context.funGate = gate;
  record("fan_fun_gate", gate);
  record("fan_fun_available", funGateAllows(gate) ? 1 : 0);
  return gate;
}

/**
 * The throttle moved — or `go` or the speed did. The event half of fun mode.
 *
 * Preferred over polling for the duty because it is both faster and cheaper: a throttle
 * being swept produces ~100 evaluations a second and a throttle at rest produces none.
 * ⚠️ What it CANNOT do is notice a bus that went silent, since silence raises no event.
 * That is what ./auto.ts keeps a watchdog tick for.
 */
export function onSignalsChanged(context: FunRunnerContext, changed: Record<string, LiveValue>): void {
  if (context.mode !== "fun") {
    return;
  }
  if (!FUN_KEYS.some(key => key in changed)) {
    return;
  }
  void driveFun(context);
}
