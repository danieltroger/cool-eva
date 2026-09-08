import { ageMs, latestValue } from "../can/signals.ts";
import { SAMPLE_MAX_AGE_MS } from "../gestures/long-press.ts";
import type { GestureOutcome, HoldGesture } from "../gestures/runner.ts";
import { AUTO_TICK_MS, type FanAutomatic } from "./auto.ts";
import { MAX_DUTY_PERCENT } from "./control.ts";
import { FAN_GESTURE_BUTTON, FAN_HOLD_MS, STATIONARY_MAX_KMH, isStationary, nextFanGestureAction } from "./gesture.ts";

// The half of the fan gesture that touches the world: it reads the fan's state and the
// bike's speed, hands them to the pure cycle in ./gesture.ts, and commands the answer.
//
// ⚠️ It acts through ./auto.ts's FanAutomatic ONLY — never the controller — so every
// transition between the three modes stays in the one file that owns them, and the
// gesture cannot leave the loop believing something the fan is not doing.
//
// The cycle, what "stationary" means and why *off* survives a silent bus:
// docs/fan-control.md §"The handlebar gesture".

export interface FanCycleOptions {
  /**
   * How often *off* re-checks the bike's speed. The seam ./auto.ts's tickMs is, and the
   * same 2 s by default: the fan needs 1500 ms just to kick-start, so re-examining
   * faster than that buys a rider nothing.
   */
  revertBeatMs?: number;
}

interface FanCycleContext {
  automatic: FanAutomatic;
  revertBeatMs: number;
  /**
   * Whether THIS gesture is what stopped the fan, and so whether movement should undo it.
   *
   * ⚠️ Load-bearing, and not the same question as "is the fan off". A rider who stops the
   * fan with the slider has said something deliberate that survives until the bike is
   * switched off — the fan's manual mode has always meant that — and riding away must not
   * quietly overrule it. Only the duty this file commanded is taken back.
   *
   * ⚠️ It is also not merely a restatement of "the timer is running". clearInterval()
   * cannot recall a callback that has already been queued, so a beat can land AFTER
   * disarmRevert() — during the await in stepTheFan(), say — and undo the hold the rider
   * just made. This flag is what that beat reads.
   */
  revertWhenMoving: boolean;
  timer: ReturnType<typeof setInterval> | null;
}

/**
 * The fan's entry in src/index.ts's gesture list, plus the handle that stops its beat.
 */
export function startFanCycleGesture(
  automatic: FanAutomatic,
  options: FanCycleOptions = {}
): { gesture: HoldGesture; stop: () => void } {
  const context: FanCycleContext = {
    automatic,
    revertBeatMs: options.revertBeatMs ?? AUTO_TICK_MS,
    revertWhenMoving: false,
    timer: null,
  };
  return {
    gesture: {
      button: FAN_GESTURE_BUTTON,
      holdMs: FAN_HOLD_MS,
      description: "step the fan round manual 100 % → automatic → off",
      perform: () => stepTheFan(context),
    },
    stop: () => disarmRevert(context),
  };
}

/** One hold: read where the fan is, decide the next step, command it. */
async function stepTheFan(context: FanCycleContext): Promise<GestureOutcome> {
  const state = context.automatic.state();
  const action = nextFanGestureAction({
    mode: state.mode,
    targetPercent: state.targetPercent,
    speedKmh: freshSpeedKmh(),
  });
  // Disarmed before the command rather than after: whatever this hold does, the *off*
  // this file last commanded is over, and a revert landing between the two would be
  // reverting a state that no longer exists.
  disarmRevert(context);

  if (action === "automatic") {
    const outcome = await context.automatic.setMode("automatic");
    return { ok: outcome.ok, message: `fan to automatic — ${outcome.message}` };
  }
  if (action === "full") {
    // MAX_DUTY_PERCENT rather than a literal 100: ./control.ts caps there today and the
    // cap moves the day the 12 V rail is measured.
    const outcome = await context.automatic.commandManualDuty(MAX_DUTY_PERCENT);
    return { ok: outcome.ok, message: `fan to manual ${MAX_DUTY_PERCENT} % — ${outcome.message}` };
  }
  const outcome = await context.automatic.commandManualDuty(0);
  if (outcome.ok) {
    armRevert(context);
  }
  return { ok: outcome.ok, message: `fan off while the bike is stopped — ${outcome.message}` };
}

/**
 * Starts watching for the bike moving again, so *off* cannot follow the rider onto a road.
 *
 * ⚠️ A BEAT AND NOT A CHANGE SUBSCRIPTION, for a reason that only shows up after a
 * failure: `speed_can_kmh` carries a 0.5 km/h deadband, so a bike that has settled at a
 * steady speed raises no change events at all. An event-driven revert is therefore
 * one-shot — if the setMode() below is refused, nothing would ever try again — while a
 * beat re-reads the live value and retries for as long as the fan is still stopped.
 */
function armRevert(context: FanCycleContext): void {
  if (context.timer !== null) {
    return;
  }
  context.revertWhenMoving = true;
  context.timer = setInterval(() => void checkForMovement(context), context.revertBeatMs);
}

function disarmRevert(context: FanCycleContext): void {
  context.revertWhenMoving = false;
  if (context.timer !== null) {
    clearInterval(context.timer);
    context.timer = null;
  }
}

/**
 * One beat of the *off* watchdog.
 *
 * ⚠️ STALENESS DOES NOT REVERT, which is the opposite polarity to ./fun.ts's gate and is
 * chosen rather than inherited. Fun mode must PROVE the bike cannot move before wiring a
 * throttle to a fan; *off* claims nothing and merely declines to spin one. And an AC
 * charge silences the whole bus for up to 23.7 minutes (docs/fan-control.md) — which is
 * exactly the dinner this state exists for, so failing closed here would start the fan in
 * the middle of the one situation it was built for. A bike that has stopped broadcasting
 * 0x104 is a bike that is not moving, which is how ./curve.ts already reads the same
 * silence.
 */
async function checkForMovement(context: FanCycleContext): Promise<void> {
  try {
    if (!context.revertWhenMoving) {
      return;
    }
    const state = context.automatic.state();
    if (state.mode !== "manual" || state.targetPercent !== 0) {
      // Somebody else has the fan — the slider, or the endpoint. The *off* this file
      // commanded is gone, so there is nothing left to take back.
      disarmRevert(context);
      return;
    }
    const speedKmh = freshSpeedKmh();
    if (speedKmh === null || isStationary(speedKmh)) {
      return;
    }
    console.log(
      `fan: the bike is moving at ${speedKmh} km/h with the fan switched off by hand — above ` +
        `${STATIONARY_MAX_KMH} km/h that is the curve's job again`
    );
    const outcome = await context.automatic.setMode("automatic");
    if (outcome.ok) {
      disarmRevert(context);
      return;
    }
    // Kept armed on purpose: the fan is still stopped and the bike is still moving, so
    // the next beat retries rather than leaving a pack to cook behind one refusal.
    console.warn(`fan: could not hand the fan back to the curve — ${outcome.message}`);
  } catch (error) {
    // setInterval discards this promise, so an escaped rejection would be unhandled and
    // would end the service. Same shape as ./auto.ts's runTick().
    console.warn("fan: the gesture's movement watchdog failed —", error);
  }
}

/** Fresh `speed_can_kmh`, or null when absent, stale or not finite. */
function freshSpeedKmh(): number | null {
  const age = ageMs("speed_can_kmh");
  if (age === null || age > SAMPLE_MAX_AGE_MS) {
    return null;
  }
  const value = latestValue("speed_can_kmh");
  return value !== null && Number.isFinite(value) ? value : null;
}
