import { ageMs, latestValue, onChange, record, type LiveValue } from "../can/signals.ts";
import { monotonicNow, since } from "../monotonic.ts";
import { MAX_DUTY_PERCENT, MIN_RUNNING_DUTY_PERCENT, type FanCommandResult, type FanController } from "./control.ts";
import {
  CHARGE_MANAGER_STATE_DC,
  FAN_REASON,
  FAN_TEMPERATURE_INPUT,
  fanCurveDecision,
  isPackTemperaturePlausible,
  type FanCurveDecision,
} from "./curve.ts";
import { onSignalsChanged, refreshGate, runFunPass, type FunRunnerContext } from "./fun-runner.ts";
import { FUN_GATE, FUN_GATE_REFUSAL, FUN_WATCHDOG_MS, funGateAllows, type FunGate } from "./fun.ts";

// The half of automatic fan control that touches the world: it reads three signals off
// the bus, hands them to the pure curve in ./curve.ts, and drives ./control.ts with the
// answer. Nothing here decides a duty — that is all next door, so it can be replayed.
//
// ⚠️ AUTOMATIC IS THE DEFAULT ON EVERY START, and the mode is in memory only. It is
// never written to disk on purpose: the Pi loses power with the bike's 12 V rail, so
// "manual until the bike is switched off" is what not persisting it already means. Fun
// mode is held the same way and for a stronger reason — a mode that put the throttle on
// the fan and survived a reboot would be waiting for a rider who did not ask for it.
//
// Which three signals the curve reads, and why not the near-miss alternatives that would
// each be wrong in a way nothing on the bike would show: docs/fan-control.md §"What the
// curve reads". Fun mode's own three, and its gate, are §"Fun mode" in the same file.

export type FanMode = "automatic" | "manual" | "fun";

/**
 * The mode as `fan_auto_mode` carries it. 0 and 1 are what they have always been, so
 * every row already in a ride log keeps its meaning; 2 is new.
 *
 * ⚠️ public/lib/fan-display.js holds the browser's copy, because a browser cannot import
 * a .ts module and the code is the wire format. scripts/check-fan-fun.ts asserts the two
 * agree — written as a bare `2` on the page it would survive swapping fun with manual.
 */
export const FAN_MODE_CODE: Record<FanMode, number> = { manual: 0, automatic: 1, fun: 2 };

/**
 * How often the curve is re-evaluated.
 *
 * The pack's thermal time constant is minutes, so this is paced by the two inputs that
 * are not: the speed gate, which a rider crosses in a second, and how quickly a dead
 * sensor shows up on the dashboard. A tick that changes nothing writes nothing.
 */
export const AUTO_TICK_MS = 2_000;

/**
 * How old `speed_can_kmh` may be before the bike counts as not moving.
 *
 * 0x104 broadcasts at 100 Hz, so 3 s is 300 missed frames: the bus is asleep and the
 * bike is parked. ⚠️ Stale means "no speed", NOT "the last speed" — a 120 km/h reading
 * from ten minutes ago would hold the fan off over a hot pack in a garage.
 */
export const SPEED_MAX_AGE_MS = 3_000;

/**
 * How old `charge_manager_state` may be before the DC session counts as over. The same
 * 5 s src/vcu/write-runner.ts uses, so the fan and the charge-current write agree about
 * when there is a session to act on.
 */
export const CHARGE_SESSION_MAX_AGE_MS = 5_000;

export interface FanAutoState {
  mode: FanMode;
  /** The curve's last answer, or null while the slider is what is driving the fan. */
  decision: FanCurveDecision | null;
  /** Milliseconds since the last in-bounds `batt_temp_hi`, or since this loop started. */
  temperatureAgeMs: number;
  /** Whether the bike is provably parked, and if not, which condition said otherwise. */
  funGate: FunGate;
}

/**
 * The seam a check drives this through, defaulting to the real value so the service's
 * own call stays `startFanAutomatic(controller)`.
 */
export interface FanAutomaticOptions {
  /**
   * How often the curve is re-evaluated. scripts/check-fan-curve.ts turns it down to a
   * few milliseconds so a whole warm-up can be replayed inside one check, which is also
   * the only way "a steady curve commands once" can be asserted at all.
   */
  tickMs?: number;
  /**
   * The two staleness windows, turned down by the same check for the same reason: what
   * they guard is a bus that has gone quiet, and the alternative to overriding them is
   * eight seconds of `sleep` in every CI run to reproduce one.
   */
  speedMaxAgeMs?: number;
  chargeSessionMaxAgeMs?: number;
}

export interface FanAutomatic {
  mode: () => FanMode;
  /** Switches mode. Going automatic re-evaluates at once rather than waiting a tick. */
  setMode: (mode: FanMode) => Promise<FanCommandResult>;
  /** A duty from the slider. Switches to manual first, or the next tick would undo it. */
  commandManualDuty: (percent: number) => Promise<FanCommandResult>;
  state: () => FanAutoState;
  /** Stops the loop. Called from index.ts's shutdown BEFORE the controller is idled. */
  stop: () => void;
}

/**
 * Everything one running loop remembers, passed explicitly to the helpers below.
 *
 * Extends FunRunnerContext structurally rather than by declaration, so ./fun-runner.ts
 * can be handed this object without either file importing the other's state.
 */
interface AutoContext extends FunRunnerContext {
  controller: FanController;
  mode: FanMode;
  /** The last IN-BOUNDS `batt_temp_hi`. Sentinels never land here. */
  lastGoodTemperatureC: number | null;
  /** Monotonic mark of when that reading arrived, or of when the loop started. */
  lastGoodAt: number;
  lastDecision: FanCurveDecision | null;
  /** What the loop last got the controller to accept, so a steady curve writes nothing. */
  lastCommandedPercent: number | null;
  speedMaxAgeMs: number;
  chargeSessionMaxAgeMs: number;
  /** The automatic cadence, kept because fun mode re-arms the timer and has to put it back. */
  tickMs: number;
  timer: ReturnType<typeof setInterval> | null;
  /** Drops the change subscription. Called from stop(), so a stopped loop reacts to nothing. */
  unsubscribe: (() => void) | null;
}

/**
 * Starts the automatic loop over an already-built controller.
 *
 * Returns an inert loop — automatic in name, doing nothing — when the fan cannot be
 * driven at all, so index.ts and the endpoint need no second "is there a fan" branch.
 */
export function startFanAutomatic(controller: FanController, options: FanAutomaticOptions = {}): FanAutomatic {
  const tickMs = options.tickMs ?? AUTO_TICK_MS;
  const context: AutoContext = {
    controller,
    mode: "automatic",
    lastGoodTemperatureC: null,
    lastGoodAt: monotonicNow(),
    lastDecision: null,
    lastCommandedPercent: null,
    speedMaxAgeMs: options.speedMaxAgeMs ?? SPEED_MAX_AGE_MS,
    chargeSessionMaxAgeMs: options.chargeSessionMaxAgeMs ?? CHARGE_SESSION_MAX_AGE_MS,
    tickMs,
    timer: null,
    // The gate starts CLOSED and stays closed until a tick has read three fresh signals
    // off the bus, so nothing offers fun mode on the strength of never having looked.
    funGate: FUN_GATE.GO_UNKNOWN,
    funCommandInFlight: false,
    funPending: false,
    handBackToCurve: gate => handBackToCurve(context, gate),
    freshValue,
    unsubscribe: null,
  };

  if (!controller.configured || controller.fault !== null) {
    return inertAutomatic(context);
  }

  context.timer = setInterval(() => void runTick(context), tickMs);
  // ⚠️ Subscribed for the whole life of the loop rather than on entering fun mode: a
  // subscription taken out when the mode changes would have to be dropped again on every
  // path that leaves it, and one missed path leaves the throttle wired to the fan. The
  // listener's first line is the mode check, so outside fun mode this costs one string
  // comparison per batch.
  context.unsubscribe = onChange(changed => onSignalsChanged(context, changed));
  publishMode(context);
  console.log(
    `fan: automatic on ${tickMs} ms ticks — batt_temp_hi drives the curve, speed_can_kmh gates it, ` +
      `charge_manager_state 0x${CHARGE_MANAGER_STATE_DC.toString(16)} switches to the DC curve`
  );

  return {
    mode: () => context.mode,
    setMode: mode => switchMode(context, mode),
    commandManualDuty: percent => commandManual(context, percent),
    state: () => snapshotAutoState(context),
    stop: () => stopTicking(context),
  };
}

/** One evaluation, and the only place a failed one is turned back into a next tick. */
async function runTick(context: AutoContext): Promise<void> {
  try {
    await evaluate(context);
  } catch (error) {
    // ⚠️ setInterval() above discards this promise, so a rejection that got out of here
    // would be unhandled — which today ends the process, taking the CAN logging and the
    // WebSocket with it, and tomorrow leaves the fan at whatever it last commanded with
    // nothing on the dashboard saying the loop stopped. Same shape as ../can/link-status
    // .ts: the catch lives inside the async function, names what failed, and lets the
    // next tick retry. Nothing on today's paths rejects; that is a property of four
    // other files staying as they are, not of this one.
    console.warn("fan: automatic tick failed —", error);
    // Forgotten for the same reason a refused command is: what the bridge is holding is
    // now unknown, so the next tick must command rather than believe a match.
    context.lastCommandedPercent = null;
  }
}

/**
 * Sample, decide, and command only if the answer moved.
 *
 * ⚠️ The mode check and the setDutyPercent() call are in ONE synchronous run, and that
 * is what keeps a tick from overriding a slider drag. ./control.ts queues commands in
 * call order, so a manual command issued after this line is queued after it and wins;
 * one issued before was already queued before it. There is no window between them for a
 * mode change to land in, so nothing here needs a generation counter to notice one.
 *
 * ⚠️ And the sampling is ABOVE the mode check on purpose: the loop keeps watching
 * `batt_temp_hi` through a manual session, so /fan's `temperatureAgeMs` stays honest
 * while the slider is driving and a sensor that dies mid-session is remembered as having
 * died then rather than at the last automatic tick.
 */
async function evaluate(context: AutoContext): Promise<void> {
  sampleTemperature(context);
  // Above the mode check for the same reason sampling is: the page decides whether to
  // OFFER fun mode off `fan_fun_available`, so the answer has to keep arriving while
  // automatic or manual is what is driving the fan.
  refreshGate(context);
  if (context.mode === "fun") {
    // The watchdog beat. Events cover a moving throttle; this covers a bus that stopped.
    await runFunPass(context);
    return;
  }
  if (context.mode !== "automatic") {
    return;
  }

  const decision = fanCurveDecision({
    packTemperatureC: context.lastGoodTemperatureC,
    temperatureAgeMs: since(context.lastGoodAt),
    speedKmh: freshValue("speed_can_kmh", context.speedMaxAgeMs),
    chargeManagerState: freshValue("charge_manager_state", context.chargeSessionMaxAgeMs),
    // The physical fan, not the previous decision: a duty set by hand before the mode
    // went back to automatic is still a running fan, and the hysteresis is about the fan.
    previouslyRunning: context.controller.state().driverEnabled,
  });
  context.lastDecision = decision;
  publishDecision(decision);

  if (decision.dutyPercent === context.lastCommandedPercent) {
    return;
  }
  const outcome = await context.controller.setDutyPercent(decision.dutyPercent);
  // Forgotten on failure so the next tick retries rather than believing a command that
  // never reached the bridge. The controller has already logged why it did not.
  context.lastCommandedPercent = outcome.ok ? decision.dutyPercent : null;
}

/**
 * Refreshes the memory the grace period is measured against.
 *
 * ⚠️ The mark is `now − age`, not `now`: the signal store knows exactly when the reading
 * arrived, so a 2 s tick does not blur the age of a 20 Hz signal into 2 s buckets. And a
 * reading that fails the bounds check is not remembered at all — which is the whole point
 * of the check, since −242 °C would otherwise read as a very cold and very healthy pack.
 */
function sampleTemperature(context: AutoContext): void {
  const value = latestValue("batt_temp_hi");
  const age = ageMs("batt_temp_hi");
  if (age === null || !isPackTemperaturePlausible(value)) {
    return;
  }
  context.lastGoodTemperatureC = value;
  context.lastGoodAt = monotonicNow() - age;
}

/** A signal's value, or null when it is absent, stale, or not a finite number. */
function freshValue(key: string, maxAgeMs: number): number | null {
  const age = ageMs(key);
  if (age === null || age > maxAgeMs) {
    return null;
  }
  const value = latestValue(key);
  return value !== null && Number.isFinite(value) ? value : null;
}

async function switchMode(context: AutoContext, mode: FanMode): Promise<FanCommandResult> {
  if (mode === "fun") {
    return await enterFun(context);
  }
  context.mode = mode;
  // Back off the watchdog cadence, which only fun mode wants. A no-op unless fun mode is
  // what is being left.
  retick(context, context.tickMs);
  publishMode(context);
  if (mode === "manual") {
    context.lastDecision = null;
    publishDecision(null);
    const state = context.controller.state();
    return {
      ok: true,
      message: state.driverEnabled
        ? `Manual. The fan holds ${state.targetPercent} % until you move the slider.`
        : "Manual. The fan stays stopped until you move the slider.",
    };
  }
  // Re-evaluated now rather than up to AUTO_TICK_MS later, so the reply that answers the
  // tap already carries what the curve decided.
  context.lastCommandedPercent = null;
  await runTick(context);
  return { ok: true, message: `Automatic. The curve is commanding ${context.lastDecision?.dutyPercent ?? 0} %.` };
}

/**
 * Puts the throttle on the fan, or says why it will not.
 *
 * ⚠️ The gate is read from the bus HERE rather than from `context.funGate`, which the
 * last tick left behind and which may be up to a tick old. Entering is the one moment
 * where a stale answer would be acted on rather than merely displayed.
 */
async function enterFun(context: AutoContext): Promise<FanCommandResult> {
  const gate = refreshGate(context);
  if (!funGateAllows(gate)) {
    return { ok: false, message: `Not now — ${FUN_GATE_REFUSAL[gate]}.` };
  }
  context.mode = "fun";
  context.lastDecision = null;
  // Cleared for the reason commandManual() clears it: what the bridge is holding came
  // from the curve, and the first throttle reading has to command rather than match.
  context.lastCommandedPercent = null;
  publishMode(context);
  publishDecision(null);
  retick(context, FUN_WATCHDOG_MS);
  // ⚠️ Guarded, because this promise has a clear run all the way out of the process. It
  // is returned by switchMode() to setMode(), which src/http/fan.ts awaits inside
  // src/index.ts's `createServer(async …)` — and Node does not await a request listener,
  // so a rejection here would be unhandled and end the service. The sibling branches
  // cannot do this: "automatic" goes through runTick(), which catches, and commandManual
  // reaches setDutyPercent(), which by construction resolves.
  const failure = await runFunPass(context);
  if (failure !== null) {
    // The mode is kept rather than rolled back. The gate said the bike is parked, so fun
    // mode is what the rider asked for and may have; what failed is the bridge, and the
    // curve would only meet the same failure through the same controller. The watchdog
    // beat and the next throttle movement both retry, and runFunPass has already
    // forgotten the commanded duty so the retry commands rather than matches.
    return { ok: false, message: `Fun mode is on, but the fan did not take the first duty: ${failure.message}` };
  }
  return {
    ok: true,
    message:
      `Fun mode. The throttle is the fan's speed control, from ${MIN_RUNNING_DUTY_PERCENT} % closed to ` +
      `${MAX_DUTY_PERCENT} % wide open. It drops back to the curve the moment the bike can move.`,
  };
}

/**
 * The other way out of fun mode: the gate closed, so ./fun-runner.ts asked to be let go.
 *
 * Automatic rather than manual, because manual would leave the fan on whatever duty the
 * throttle happened to be holding for the rest of the ride, with nothing watching the
 * pack. The re-evaluation is immediate, so the curve has the fan back before the rider is
 * out of the bay — and it is what puts the fan on the road-speed gate rather than on a
 * duty chosen by a hand that has just let go of a throttle to ride away.
 */
async function handBackToCurve(context: AutoContext, gate: FunGate): Promise<void> {
  console.log(`fan: leaving fun mode — ${FUN_GATE_REFUSAL[gate]}. The temperature curve has the fan back.`);
  context.mode = "automatic";
  context.lastCommandedPercent = null;
  publishMode(context);
  retick(context, context.tickMs);
  await evaluate(context);
}

async function commandManual(context: AutoContext, percent: number): Promise<FanCommandResult> {
  context.mode = "manual";
  retick(context, context.tickMs);
  context.lastDecision = null;
  // Cleared, not set to `percent`: the loop's memory of what it commanded is now wrong
  // whatever this command does, and a stale match would make the first automatic tick
  // after the mode goes back skip its own command.
  context.lastCommandedPercent = null;
  publishMode(context);
  publishDecision(null);
  return await context.controller.setDutyPercent(percent);
}

/**
 * The two signals that say what automatic mode is doing, alongside `fan_duty_pct` and
 * `fan_target_pct` from ./control.ts. The words for each code live in
 * public/lib/fan-display.js, because that is where they have to stay live.
 *
 * In manual both fall back: MANUAL and NONE, which is "not applicable" rather than a
 * claim about a sensor — the dashboard hides the whole line while `fan_auto_mode` is 0.
 */
function publishDecision(decision: FanCurveDecision | null): void {
  record("fan_auto_reason", decision?.reason ?? FAN_REASON.MANUAL);
  record("fan_temp_input", decision?.temperatureInput ?? FAN_TEMPERATURE_INPUT.NONE);
}

function publishMode(context: AutoContext): void {
  record("fan_auto_mode", FAN_MODE_CODE[context.mode]);
}

/** Re-arms the loop at a new cadence: 2 s for the curve, FUN_WATCHDOG_MS for fun mode. */
function retick(context: AutoContext, intervalMs: number): void {
  if (context.timer === null) {
    // Never started, or already stopped. Re-arming a stopped loop would resurrect it
    // after index.ts's shutdown has torn the controller down underneath it.
    return;
  }
  clearInterval(context.timer);
  context.timer = setInterval(() => void runTick(context), intervalMs);
}

function stopTicking(context: AutoContext): void {
  if (context.timer !== null) {
    clearInterval(context.timer);
    context.timer = null;
  }
  if (context.unsubscribe !== null) {
    context.unsubscribe();
    context.unsubscribe = null;
  }
}

function snapshotAutoState(context: AutoContext): FanAutoState {
  return {
    mode: context.mode,
    decision: context.lastDecision,
    temperatureAgeMs: since(context.lastGoodAt),
    funGate: context.funGate,
  };
}

/** A loop for a fan that cannot be driven: no timer, no signals, and it says so. */
function inertAutomatic(context: AutoContext): FanAutomatic {
  return {
    mode: () => context.mode,
    setMode: async mode => {
      // ⚠️ Fun mode is refused WITHOUT being adopted, unlike the other two. Nothing here
      // ever consults the gate, so a loop that reported itself in fun mode would be
      // claiming the throttle is driving a fan that does not exist.
      if (mode !== "fun") {
        context.mode = mode;
      }
      return { ok: false, message: "there is no fan driver on this Pi to put in that mode" };
    },
    commandManualDuty: percent => context.controller.setDutyPercent(percent),
    state: () => snapshotAutoState(context),
    stop: () => {
      // Nothing was ever scheduled.
    },
  };
}
