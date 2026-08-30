import { latestValue, record, type LiveValue } from "../can/signals.ts";
import { monotonicNow, since } from "../monotonic.ts";
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
 * How often a repeating fun-mode failure may put a line in the journal.
 *
 * ⚠️ ./auto.ts's runTick() warns off a 2 s tick; this path is driven by `throttle_pct`
 * change events at ~100 Hz, so a bridge that starts refusing would write a hundred lines a
 * second onto a Pi that is also writing a ride log, and the messages worth having would be
 * the ones that scrolled past. COALESCED, NOT DROPPED: the first failure warns at once and
 * every line carries how many it stands for — see warnFunPassFailed() below.
 */
const FUN_FAILURE_LOG_INTERVAL_MS = 1_000;

let funFailuresSinceWarning = 0;
let lastFunFailureWarnedAt: number | null = null;

/**
 * driveFun() with the guard ./auto.ts's runTick() puts around evaluate(), and the only
 * form the two callers outside this file use. Returns what failed, or null.
 *
 * ⚠️ Both of fun mode's entry points discard or forward a promise that nothing else
 * catches — the change listener's is discarded at ~100 Hz, and enterFun's travels through
 * setMode into src/index.ts's `createServer(async …)`, which Node does not await either.
 * An escaped rejection on either ends the process, taking the CAN logging and the
 * WebSocket with it. Nothing on today's paths rejects; that is a property of ./control.ts
 * rather than of this file, which is the argument scripts/check-fan-curve.ts §11 already
 * makes for the timer path and declines to accept.
 */
export async function runFunPass(context: FunRunnerContext): Promise<Error | null> {
  try {
    await driveFun(context);
    return null;
  } catch (error) {
    warnFunPassFailed(error);
    // Forgotten for the reason a refused command is: what the bridge is holding is now
    // unknown, so the next throttle movement or watchdog beat must command rather than
    // believe a match.
    context.lastCommandedPercent = null;
    return error instanceof Error ? error : new Error(String(error));
  }
}

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
  // ⚠️ No mode check of its own, deliberately: both callers make one — onSignalsChanged
  // below and ./auto.ts's evaluate() — and ./auto.ts's handBackToCurve() adopts the new
  // mode SYNCHRONOUSLY, before its first await. So a pass arriving during a hand-back
  // already sees "automatic" at its caller and never gets here, which is what stops two
  // hand-backs overlapping. A third check here would be one nothing could ever trip.
  if (context.funCommandInFlight) {
    // ⚠️ EVEN THIS BRANCH READS THE GATE, which is what stops the in-flight flag wedging
    // the session. A setDutyPercent() that HANGS — not rejects — leaves the flag true for
    // ever, and if this early return came before a gate read then every route out of fun
    // mode would end here at line 1: the throttle events, and the 250 ms watchdog beat
    // too, since that beat is also just this function. The one mechanism meant to end the
    // session when the bus goes quiet could not run. Handing the fan back does not need
    // the bridge to be free, so a closed gate is answered here and not deferred.
    const gate = refreshGate(context);
    if (!funGateAllows(gate)) {
      await context.handBackToCurve(gate);
      return;
    }
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
 *
 * ⚠️ The promise is DISCARDED, at ~100 Hz, which is why it goes through runFunPass: this
 * is a change-listener callback and there is nothing above it to catch a rejection.
 */
export function onSignalsChanged(context: FunRunnerContext, changed: Record<string, LiveValue>): void {
  if (context.mode !== "fun") {
    return;
  }
  if (!FUN_KEYS.some(key => key in changed)) {
    return;
  }
  void runFunPass(context);
}

/**
 * The journal line for a failed pass, at most one per FUN_FAILURE_LOG_INTERVAL_MS.
 *
 * ⚠️ Rate-limited, never silenced: the first failure is written the moment it happens, and
 * every line names both the failing call and how many failures it stands for, so a bridge
 * that has started refusing is still loud without being a hundred lines a second. The
 * counter is cleared only by a line that reports it, so a burst that stops before the next
 * line rides on the one after rather than being lost. Paced on the monotonic clock rather
 * than Date.now(), because ../gps/clock.ts steps the wall one out from under it.
 */
function warnFunPassFailed(error: unknown): void {
  funFailuresSinceWarning += 1;
  if (lastFunFailureWarnedAt !== null && since(lastFunFailureWarnedAt) < FUN_FAILURE_LOG_INTERVAL_MS) {
    return;
  }
  const coalesced = funFailuresSinceWarning;
  funFailuresSinceWarning = 0;
  lastFunFailureWarnedAt = monotonicNow();
  console.warn(`fan: a fun-mode pass failed (${coalesced} since the last line) —`, error);
}
