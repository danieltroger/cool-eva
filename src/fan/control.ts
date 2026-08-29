import { record } from "../can/signals.ts";
import { monotonicNow, since } from "../monotonic.ts";
import { openFanPwm, type FanPwm } from "./pwm.ts";

// Cooling-fan policy: what duty the IBT-2 is actually given, and in what order the
// bridge is brought up. Every sysfs and pinctrl write is in ./pwm.ts.
//
// Three rules, all argued in docs/fan-control.md:
//   • from rest the fan gets KICK_START_MS at 100 % before it drops to the target, so a
//     stiff rotor breaks away at full torque. ⚠️ This was introduced as fuse protection
//     and that claim is RETRACTED — docs/fan-control.md §4 has the fuse curve and the
//     measurement that would settle it. Do not build anything on it as protection;
//   • anything under MIN_RUNNING_DUTY_PERCENT is a stop, not a crawl the fan may stall at;
//   • idling pulls BOTH enables LOW. Enables HIGH at duty 0 turns both low sides on,
//     which shorts the motor and brakes it — in a 270 km/h airstream.
//
// This is phase 1: manual duty from the dashboard, for debugging in the garage. There is
// no coolant-temperature curve here and nothing here is waiting for one.

/**
 * ⚠️ OPT IN — `=== "1"`, deliberately the opposite of COOLANT_ENABLED and OBD_ENABLED,
 * which are opt-out. Almost no Eva has this fan, so the default has to be a Pi that never
 * opens /sys/class/pwm and never spawns `pinctrl`. One of exactly two opt-in switches in
 * this repo; SERVICE_WRITE_ENABLED is the other, and README's Configuration table says so
 * on both rows.
 */
const FAN_ENABLED = process.env.FAN_ENABLED === "1";

/**
 * How long the fan is held at full duty from rest before it drops to the target.
 *
 * Anti-stiction: a rotor that is stiff gets full torque to break away with rather than a
 * duty it can sit and hum at. ⚠️ It is NOT fuse protection — a 10 A blade fuse needs
 * about 27 A to open inside 1500 ms, above the top of the estimated stall current, and
 * that current was never measured. The retraction, the fuse curve and the one measurement
 * that would settle it: docs/fan-control.md §4.
 */
export const KICK_START_MS = 1500;

/** Below this a command is a stop: a crawl the fan may not start from is worse than off. */
export const MIN_RUNNING_DUTY_PERCENT = 30;

/**
 * The most duty this will ever command.
 *
 * 100 today because the 12 V rail has not been measured yet. The SPAL VA69A is specified
 * at a nominal 12 V ±10 %, so this is where the average gets held to that once the real
 * rail voltage is known — a 13.8 V rail wants roughly 87 % to average 12 V.
 */
export const MAX_DUTY_PERCENT = 100;

/**
 * ⚠️ Deliberately NOT MAX_DUTY_PERCENT. Whatever a stiff rotor needs to break away, it
 * needs at full torque, so capping this to hold an average voltage would defeat the
 * reason it is there. It lasts KICK_START_MS, which no fan winding minds.
 */
const KICK_DUTY_PERCENT = 100;

export type FanPhase = "idle" | "kick-start" | "running";

export interface FanState {
  /** The duty the bridge is being given right now. 100 for the length of a kick-start. */
  dutyPercent: number;
  /** What was asked for, which a kick-start is briefly overriding. */
  targetPercent: number;
  /** Whether both IBT-2 enables are HIGH. False means standby: every FET off. */
  driverEnabled: boolean;
  phase: FanPhase;
}

export interface FanCommandResult {
  ok: boolean;
  /** What happened, or why nothing did. Shown verbatim on the dashboard. */
  message: string;
}

export interface FanController {
  /** FAN_ENABLED=1. index.ts routes /fan only when this is true. */
  readonly configured: boolean;
  /** Why the driver is unusable despite being configured, or null when it is fine. */
  readonly fault: string | null;
  setDutyPercent: (percent: number) => Promise<FanCommandResult>;
  state: () => FanState;
  /** Enables LOW, PWM disabled. Called from index.ts's shutdown. */
  stop: () => Promise<void>;
}

/**
 * The seam a check drives this through. Both fields default to the real thing, so the
 * service's own call is `startFanControl()` with no arguments.
 */
export interface FanControlOptions {
  /**
   * How the hardware is opened. scripts/check-fan-ordering.ts passes a fake FanPwm that
   * records its call sequence, which is the only way the two orderings below — the whole
   * safety property of this file — can be asserted with no Pi and no bike.
   */
  openPwm?: () => Promise<FanPwm>;
  /** Overrides FAN_ENABLED, so a check needs no environment variable to reach the driver. */
  enabled?: boolean;
}

/** Everything one running driver remembers, passed explicitly to the helpers below. */
interface FanContext {
  pwm: FanPwm;
  phase: FanPhase;
  targetPercent: number;
  appliedPercent: number;
  bridgeEnabled: boolean;
  /** Monotonic mark of when the current kick-start began. */
  kickStartedAt: number;
  kickTimer: ReturnType<typeof setTimeout> | null;
  /** Tail of the command queue. See runExclusively(). */
  inFlight: Promise<unknown>;
}

/**
 * Brings the driver up, or explains why it did not come up.
 *
 * Never throws: a fan that cannot be driven must not stop the telemetry the rest of this
 * process exists for, so a failure here becomes a `fault` string the endpoint and the
 * dashboard show.
 */
export async function startFanControl(options: FanControlOptions = {}): Promise<FanController> {
  if (!(options.enabled ?? FAN_ENABLED)) {
    console.log("fan: disabled (set FAN_ENABLED=1 on a bike with the IBT-2 fan driver wired up)");
    return inertController(false, null);
  }

  let pwm: FanPwm;
  try {
    pwm = await (options.openPwm ?? openFanPwm)();
  } catch (error) {
    const detail = (error as Error).message;
    console.error("fan: bring-up failed — the fan cannot be driven this boot:", detail);
    return inertController(true, detail);
  }

  const context: FanContext = {
    pwm,
    phase: "idle",
    targetPercent: 0,
    appliedPercent: 0,
    bridgeEnabled: false,
    kickStartedAt: monotonicNow(),
    kickTimer: null,
    inFlight: Promise.resolve(),
  };
  // Published once at rest so the dashboard's tile has something to draw before anyone
  // touches the slider, rather than a pair of dashes that look like a dead sensor.
  publish(context);
  console.log(
    `fan: manual control ready — ${MIN_RUNNING_DUTY_PERCENT}…${MAX_DUTY_PERCENT} %, ` +
      `${KICK_START_MS} ms kick-start from rest, POST /fan?duty=N`
  );

  return {
    configured: true,
    fault: null,
    setDutyPercent: percent => runExclusively(context, () => commandDuty(context, percent)),
    state: () => snapshotState(context),
    stop: () => runExclusively(context, () => forceIdle(context)),
  };
}

/**
 * Runs one command at a time, in the order they arrive.
 *
 * ⚠️ Not tidiness. Every step below is an await on a file write or a spawned `pinctrl`, so
 * two commands left free to interleave would mix their steps — and the two ways that goes
 * wrong are both silent. A stop landing between a kick-start's "output on" and its
 * "enables HIGH" switches the fan ON right after being told to stop it. A kick-start
 * finishing after a stop marks the context "running" over a bridge that is off, and the
 * NEXT command then skips the kick-start and never spins the fan at all. Neither shows up
 * anywhere: this fan has no tacho.
 *
 * The tail is chained on settlement rather than on success, so one failed command cannot
 * wedge every command after it.
 */
function runExclusively<T>(context: FanContext, work: () => Promise<T>): Promise<T> {
  const result = context.inFlight.then(work, work);
  context.inFlight = result.catch(() => undefined);
  return result;
}

/**
 * The one entry point that changes what the fan is doing.
 *
 * A command arriving mid-kick only moves the target: the kick has to run its full length
 * or it is not a kick, so the timer lands on whatever the target is by then.
 */
async function commandDuty(context: FanContext, requested: number): Promise<FanCommandResult> {
  if (!Number.isFinite(requested)) {
    return { ok: false, message: `duty must be a number, not ${requested}` };
  }
  const capped = Math.min(Math.max(requested, 0), MAX_DUTY_PERCENT);

  if (capped < MIN_RUNNING_DUTY_PERCENT) {
    try {
      // No retry on failure: goIdle already pulled every lever it has, so a second pass
      // would only repeat the same failing writes. Its message says which ones.
      await goIdle(context);
    } catch (error) {
      console.error("fan: could not return the bridge to standby:", (error as Error).message);
      return { ok: false, message: `could not stop the fan: ${(error as Error).message}` };
    }
    return {
      ok: true,
      message:
        capped <= 0
          ? "Fan stopped. Both enables LOW, so the bridge is in standby and the rotor freewheels."
          : `${capped} % is under the ${MIN_RUNNING_DUTY_PERCENT} % minimum, so the fan was stopped rather ` +
            `than left at a duty it may stall at.`,
    };
  }

  const fromRest = context.phase === "idle";
  context.targetPercent = capped;
  try {
    if (fromRest) {
      await beginKickStart(context);
    } else if (context.phase === "running") {
      await applyDuty(context, capped);
    }
  } catch (error) {
    console.error(`fan: commanding ${capped} % failed:`, (error as Error).message);
    await forceIdle(context);
    return { ok: false, message: `could not command ${capped} %: ${(error as Error).message}` };
  }

  // No "asked for N, capped at M" note: src/http/fan.ts rejects anything above the cap
  // with a 400 before this is reached, for every value of the cap since both read the
  // same constant. A message describing a capping that cannot happen would be a guard
  // that cannot fire. The clamp above stays as the last line of defence for a caller
  // that is not the endpoint.
  if (fromRest) {
    return { ok: true, message: `Kick-starting at ${KICK_DUTY_PERCENT} % for ${KICK_START_MS} ms, then ${capped} %.` };
  }
  if (context.phase === "kick-start") {
    return { ok: true, message: `Still kick-starting — it will settle at ${capped} % when the kick ends.` };
  }
  return { ok: true, message: `Fan at ${capped} %.` };
}

/**
 * Full duty, output on, then the enables.
 *
 * ⚠️ That order is the safety property. The bridge must never be enabled while the PWM
 * output is still at 0, because both enables HIGH at 0 % turns both low sides on, which
 * shorts the motor and brakes it. docs/fan-control.md §"Why idling pulls the enables low".
 */
async function beginKickStart(context: FanContext): Promise<void> {
  await context.pwm.setDutyPercent(KICK_DUTY_PERCENT);
  await context.pwm.setOutputEnabled(true);
  await context.pwm.setBridgeEnabled(true);
  context.bridgeEnabled = true;
  context.appliedPercent = KICK_DUTY_PERCENT;
  context.phase = "kick-start";
  context.kickStartedAt = monotonicNow();
  publish(context);
  armKickTimer(context, KICK_START_MS);
}

function armKickTimer(context: FanContext, delayMs: number): void {
  clearKickTimer(context);
  // Through the queue like every other command, so the drop out of the kick cannot
  // interleave with a stop that is already mid-flight. See runExclusively().
  context.kickTimer = setTimeout(() => void runExclusively(context, () => finishKickStart(context)), delayMs);
}

function clearKickTimer(context: FanContext): void {
  if (context.kickTimer !== null) {
    clearTimeout(context.kickTimer);
    context.kickTimer = null;
  }
}

/**
 * Drops from the kick to the target — but only once the kick has really had its time.
 *
 * ⚠️ Measured with since() rather than trusted from the timer, and never against a
 * Date.now() difference: this process steps its own wall clock (../monotonic.ts), and a
 * kick cut short may leave a rotor that never broke free sitting at low duty — which
 * nothing here can observe, because the fan has no tacho. docs/fan-control.md §4.
 */
async function finishKickStart(context: FanContext): Promise<void> {
  context.kickTimer = null;
  if (context.phase !== "kick-start") {
    return;
  }
  const remainingMs = KICK_START_MS - since(context.kickStartedAt);
  if (remainingMs > 0) {
    armKickTimer(context, remainingMs);
    return;
  }
  try {
    await applyDuty(context, context.targetPercent);
  } catch (error) {
    console.error("fan: could not drop out of kick-start to the target duty:", (error as Error).message);
    await forceIdle(context);
  }
}

async function applyDuty(context: FanContext, percent: number): Promise<void> {
  await context.pwm.setDutyPercent(percent);
  context.appliedPercent = percent;
  context.phase = "running";
  publish(context);
}

/**
 * Back to standby.
 *
 * ⚠️ Enables FIRST, then the output. Both enables LOW is every FET off and the rotor
 * freewheeling; dropping the duty first would pass through "enabled at 0 %", which is the
 * electrical brake this whole file exists to avoid.
 */
async function goIdle(context: FanContext): Promise<void> {
  clearKickTimer(context);
  // A failure in one step does not abort the rest, and every failure is reported to the
  // caller rather than thrown at the first one. The context fields are only updated by
  // whatever actually succeeded, so a bridge we could not switch off keeps reporting
  // itself as enabled — which is what the dashboard renders as a fault.
  const failures: string[] = [];
  try {
    await context.pwm.setBridgeEnabled(false);
    context.bridgeEnabled = false;
  } catch (error) {
    failures.push(`enables: ${(error as Error).message}`);
  }
  // ⚠️ Only once the enables are genuinely LOW. Dropping the output while they are still
  // HIGH IS the brake — both low sides on across the winding — so a failed enable-drop
  // must leave the duty exactly where it is. A fan still running is strictly safer than
  // a fan braked in a 270 km/h airstream, and the failure is reported either way.
  if (context.bridgeEnabled) {
    failures.push(
      "left the PWM driving on purpose: with the enables still HIGH, a duty of 0 would brake the rotor rather " +
        "than release it. Cut power to the IBT-2."
    );
  } else {
    try {
      await context.pwm.setOutputEnabled(false);
      await context.pwm.setDutyPercent(0);
      context.appliedPercent = 0;
    } catch (error) {
      failures.push(`pwm: ${(error as Error).message}`);
    }
  }
  context.targetPercent = 0;
  // Idle whatever happened, so the next command re-drives the whole bring-up sequence
  // from a known start rather than trusting a half-torn-down state.
  context.phase = "idle";
  publish(context);
  if (failures.length > 0) {
    throw new Error(failures.join("; "));
  }
}

/** goIdle for the paths that have nowhere left to report to — loud, and never throws. */
async function forceIdle(context: FanContext): Promise<void> {
  try {
    await goIdle(context);
  } catch (error) {
    console.error(
      "fan: FAILED to return the bridge to standby — the fan may still be driven. Cut power to the IBT-2. Cause:",
      (error as Error).message
    );
  }
}

/**
 * The two signals the dashboard binds to. Log-on-change in ../can/signals.ts means a
 * steady duty is written once, which is why both are registered `onDemand`.
 */
function publish(context: FanContext): void {
  record("fan_duty_pct", context.appliedPercent);
  record("fan_driver_enabled", context.bridgeEnabled ? 1 : 0);
}

function snapshotState(context: FanContext): FanState {
  return {
    dutyPercent: context.appliedPercent,
    targetPercent: context.targetPercent,
    driverEnabled: context.bridgeEnabled,
    phase: context.phase,
  };
}

/** A controller that owns no hardware: FAN_ENABLED unset, or bring-up failed. */
function inertController(configured: boolean, fault: string | null): FanController {
  const refusal = fault ?? "fan control is switched off on this Pi (FAN_ENABLED is not 1)";
  return {
    configured,
    fault,
    setDutyPercent: async () => ({ ok: false, message: refusal }),
    state: () => ({ dutyPercent: 0, targetPercent: 0, driverEnabled: false, phase: "idle" }),
    stop: async () => {
      // Nothing was ever exported or driven, so there is nothing to put back.
    },
  };
}
