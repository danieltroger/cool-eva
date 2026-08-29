import { ageMs, latestValue, record } from "../can/signals.ts";
import { monotonicNow, since } from "../monotonic.ts";
import type { FanCommandResult, FanController } from "./control.ts";
import {
  CHARGE_MANAGER_STATE_DC,
  FAN_REASON,
  FAN_TEMPERATURE_INPUT,
  fanCurveDecision,
  isPackTemperaturePlausible,
  type FanCurveDecision,
} from "./curve.ts";

// The half of automatic fan control that touches the world: it reads three signals off
// the bus, hands them to the pure curve in ./curve.ts, and drives ./control.ts with the
// answer. Nothing here decides a duty — that is all next door, so it can be replayed.
//
// ⚠️ AUTOMATIC IS THE DEFAULT ON EVERY START, and the mode is in memory only. It is
// never written to disk on purpose: the Pi loses power with the bike's 12 V rail, so
// "manual until the bike is switched off" is what not persisting it already means.
//
// Which three signals, and why not the near-miss alternatives that would each be wrong
// in a way nothing on the bike would show: docs/fan-control.md §"What the curve reads".

export type FanMode = "automatic" | "manual";

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

/** Everything one running loop remembers, passed explicitly to the helpers below. */
interface AutoContext {
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
  timer: ReturnType<typeof setInterval> | null;
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
    timer: null,
  };

  if (!controller.configured || controller.fault !== null) {
    return inertAutomatic(context);
  }

  context.timer = setInterval(() => void runTick(context), tickMs);
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
  context.mode = mode;
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

async function commandManual(context: AutoContext, percent: number): Promise<FanCommandResult> {
  context.mode = "manual";
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
  record("fan_auto_mode", context.mode === "automatic" ? 1 : 0);
}

function stopTicking(context: AutoContext): void {
  if (context.timer !== null) {
    clearInterval(context.timer);
    context.timer = null;
  }
}

function snapshotAutoState(context: AutoContext): FanAutoState {
  return {
    mode: context.mode,
    decision: context.lastDecision,
    temperatureAgeMs: since(context.lastGoodAt),
  };
}

/** A loop for a fan that cannot be driven: no timer, no signals, and it says so. */
function inertAutomatic(context: AutoContext): FanAutomatic {
  return {
    mode: () => context.mode,
    setMode: async mode => {
      context.mode = mode;
      return { ok: false, message: "there is no fan driver on this Pi to put in that mode" };
    },
    commandManualDuty: percent => context.controller.setDutyPercent(percent),
    state: () => snapshotAutoState(context),
    stop: () => {
      // Nothing was ever scheduled.
    },
  };
}
