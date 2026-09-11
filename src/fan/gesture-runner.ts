import { freshValue, onChange, record } from "../can/signals.ts";
import { monotonicNow, since } from "../monotonic.ts";
import type { HoldGesture } from "../gestures/runner.ts";
import { type FanAutomatic } from "./auto.ts";
import { MAX_DUTY_PERCENT, type FanCommandResult } from "./control.ts";
import {
  FAN_GESTURE_BUTTON,
  FAN_HOLD_MS,
  FAN_OFF_CEILING_KMH,
  STATIONARY_MAX_AGE_MS,
  isBelowOffCeiling,
  nextFanGestureAction,
} from "./gesture.ts";

// The half of the fan gesture that touches the world: it reads the fan's state and the
// bike's speed, hands them to the pure cycle in ./gesture.ts, and commands the answer.
//
// ⚠️ It acts through ./auto.ts's FanAutomatic ONLY — never the controller — so every
// transition between the three modes stays in the one file that owns them, and the
// gesture cannot leave the loop believing something the fan is not doing.
//
// The cycle and its direction, what "stationary" means, and why *off* survives a silent bus:
// docs/fan-control.md §"The handlebar gesture".

/**
 * `fan_off_state` on the wire — whose *off* this is, and why it ended.
 *
 * ⚠️ One signal and not two, and an enum rather than a counter, because `record()` seals
 * only a value that MOVED: a hand-back the bridge refuses is retried every beat, and a
 * counter would have written a ride-log row at 2 Hz for as long as it kept failing. Two
 * hand-backs cannot collapse into one, because MOVED necessarily sits between them —
 * checkForMovement() disarms on success.
 */
export const FAN_OFF_STATE = { NOT_ARMED: 0, ARMED: 1, MOVED: 2 } as const;

/**
 * How long the bike must be ABOVE the ceiling before *off* is handed back.
 *
 * ⚠️ CHOSEN, NOT MEASURED — the same honesty ./curve.ts's road-speed gate carries. The
 * archive cannot settle it: over 898 excursions above 15 km/h in the ride log, filtering
 * to a "creep shape" (more than one sample, peaking under 25 km/h) still leaves 101 that
 * run past 2 s, the longest 25.9 s at 21.2 km/h. Peak speed does not separate a parking
 * manoeuvre from riding slowly down a lane, so no window length is derivable from it.
 *
 * What the data does say is that 562 of the 898 crossings are shorter than 2 s (336 of
 * those a single sample), so this discards the great majority of them. The tiebreaker is
 * the asymmetry, not the data: trip early and the fan comes back in automatic, one hold
 * away; trip late and a silent fan goes onto a road. docs/fan-control.md.
 */
export const FAN_OFF_REVERT_HOLD_MS = 2_000;

/**
 * How often *off* re-checks the bike's speed.
 *
 * ⚠️ 500 ms, and the old 2 s is not merely tightened — its argument was on the wrong
 * axis. It said the fan needs 1500 ms to kick-start so noticing faster buys nothing, which
 * is about how fast the FAN can respond. Since FAN_OFF_REVERT_HOLD_MS the beat no longer
 * answers a level question ("is the bike moving?", where any one sample does) but measures
 * a DURATION, and a 2 s sampler cannot measure a 2 s window at all — the hand-back would
 * land anywhere from 2 to 4 s and the constant would be decoration.
 *
 * 500 ms is also ../fan/gesture.ts's STATIONARY_MAX_AGE_MS, the freshness window of the
 * very signal this samples: sampling slower than a signal's own staleness window can miss
 * a stale→fresh transition entirely. The timer exists only while *off* is in force.
 */
export const FAN_OFF_BEAT_MS = 500;

export interface FanCycleOptions {
  /** The beat above. scripts/check-*.ts turn it down; nothing in src/ passes it. */
  revertBeatMs?: number;
  /**
   * The hold above. Its own seam for the reason ./auto.ts's speedMaxAgeMs has one: the
   * alternative is two real seconds of `sleep` in every assertion that exercises a
   * hand-back. ⚠️ At least one check must still run at the shipped value, or reverting
   * the beat stops being detectable.
   */
  revertHoldMs?: number;
}

interface FanCycleContext {
  automatic: FanAutomatic;
  revertBeatMs: number;
  revertHoldMs: number;
  /**
   * The *off* watchdog, running only while THIS gesture is what stopped the fan.
   *
   * ⚠️ Its existence IS the state, which is why there is no second flag beside it. A
   * rider who stops the fan with the slider has said something deliberate that survives
   * until the bike is switched off — manual mode has always meant that — and riding away
   * must not quietly overrule it, so no timer is armed for that.
   *
   * ⚠️ Read again INSIDE the beat, not only at arming time: clearInterval() cannot recall
   * a callback that has already been queued, so a beat can land after disarmRevert() —
   * during the await in stepTheFan(), say — and would otherwise undo the hold the rider
   * has just made.
   */
  timer: ReturnType<typeof setInterval> | null;
  /**
   * Monotonic mark of when the bike FIRST went above the ceiling in the current
   * excursion, or null when it is not above it.
   *
   * ⚠️ monotonicNow()/since() and never a Date.now() difference: ../gps/clock.ts steps
   * this process's wall clock, and a step mid-excursion would either hand the fan back
   * instantly or never. ../monotonic.ts has the whole argument.
   */
  movingSince: number | null;
  /** Dropped in stop(). See the subscription in startFanCycleGesture(). */
  unsubscribe: (() => void) | null;
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
    revertBeatMs: options.revertBeatMs ?? FAN_OFF_BEAT_MS,
    revertHoldMs: options.revertHoldMs ?? FAN_OFF_REVERT_HOLD_MS,
    timer: null,
    movingSince: null,
    unsubscribe: null,
  };
  // Published at rest for the reason ./auto.ts publishes the mode at startup: the ride log
  // seals the first sample of every signal after a boot, so without this a session that
  // ended with *off* armed leaves the last logged value at ARMED and every reader stepping
  // the log carries it across a restart that put the fan back in automatic.
  record("fan_off_state", FAN_OFF_STATE.NOT_ARMED);
  // ⚠️ A WAKE-UP, not a payload reader. `fan_target_pct` moving is the only way this file
  // can learn that the slider or /fan took the fan off it — src/http/fan.ts calls the loop
  // directly and tells the gesture nothing — but the DECISION is made from
  // context.automatic.state(), because ../can/signals.ts is a process singleton and a
  // check that stands up several controllers would otherwise disarm this one on another's
  // duty. Same shape as ./auto.ts's own subscription.
  //
  // ⚠️ Speed deliberately stays on the beat below and does NOT move here: it carries a
  // 0.5 km/h deadband, so a bike settled at a steady speed raises no events at all.
  context.unsubscribe = onChange(changed => {
    if ("fan_target_pct" in changed) {
      disarmIfSomebodyElseHasTheFan(context);
    }
  });
  return {
    gesture: {
      button: FAN_GESTURE_BUTTON,
      holdMs: FAN_HOLD_MS,
      description: "step the fan round manual 100 % → off → automatic",
      perform: () => stepTheFan(context),
    },
    stop: () => stopWatching(context),
  };
}

/** Drops the beat and the subscription. src/index.ts's shutdown calls this. */
function stopWatching(context: FanCycleContext): void {
  disarmRevert(context);
  if (context.unsubscribe !== null) {
    context.unsubscribe();
    context.unsubscribe = null;
  }
}

/**
 * Lets go of *off* the moment somebody else commands a duty.
 *
 * ⚠️ THE BANNER DEPENDS ON THIS RUNNING EARLY. A slider drag from 0 up and back to 0
 * happens at up to seven commands a second, so before this existed the whole drag fitted
 * inside one beat: the fan sheet's key returned to `manual-stopped` with `fan_off_state`
 * still ARMED, the phone said "off until N km/h" over a duty a thumb had chosen — and
 * worse, the watchdog really did stay armed, because the beat's test is "target is 0" and
 * the drag ends at 0. The banner was accurately reporting a bug. #205.
 *
 * ⚠️ It reaches the phone ONE BATCH after the duty that woke it, never the same one:
 * ../can/signals.ts clears `pending` before it calls the listeners, so a record() made
 * from inside one always opens the next batch. That is still strictly before the drag's
 * return to zero, because the two commands serialise through ./control.ts's queue.
 */
function disarmIfSomebodyElseHasTheFan(context: FanCycleContext): void {
  if (context.timer === null) {
    return;
  }
  const state = context.automatic.state();
  if (state.mode !== "manual" || state.targetPercent !== 0) {
    disarmRevert(context);
  }
}

/** One hold: read where the fan is, decide the next step, command it. */
async function stepTheFan(context: FanCycleContext): Promise<string> {
  const state = context.automatic.state();
  const action = nextFanGestureAction({
    mode: state.mode,
    targetPercent: state.targetPercent,
    speedKmh: freshValue("speed_can_kmh", STATIONARY_MAX_AGE_MS),
  });
  // Disarmed before the command rather than after: whatever this hold does, the *off*
  // this file last commanded is over, and a revert landing between the two would be
  // reverting a state that no longer exists.
  disarmRevert(context);

  if (action === "automatic") {
    return line(await context.automatic.setMode("automatic"), "fan to automatic");
  }
  if (action === "full") {
    // MAX_DUTY_PERCENT rather than a literal 100: ./control.ts caps there today and the
    // cap moves the day the 12 V rail is measured.
    return line(await context.automatic.commandManualDuty(MAX_DUTY_PERCENT), `fan to manual ${MAX_DUTY_PERCENT} %`);
  }
  // ⚠️ BEFORE the awaited command, while armRevert() stays after it. The two are
  // deliberately on opposite sides: `fan_off_state` words the banner and `fan_target_pct`
  // MOVES it, so the wording has to be on the wire first or the phone says plain
  // "Fan: off" — the #199 tear, in a new place. The timer, meanwhile, must not exist
  // before the fan is actually stopped. scripts/check-fan-off-ceiling.ts pins the order.
  record("fan_off_state", FAN_OFF_STATE.ARMED);
  const outcome = await context.automatic.commandManualDuty(0);
  // ⚠️ Armed whatever the command SAID. ./control.ts's goIdle() sets the target to 0 and
  // drops the output before a failing sysfs write can throw, so a refusal can still leave
  // the fan stopped — and that is exactly the state that must not follow the rider onto a
  // road. Arming is free when it is wrong: checkForMovement() disarms itself the moment
  // the fan is not in the state this commanded.
  armRevert(context);
  return line(outcome, "fan off while the bike is stopped");
}

/** One journal line, saying up front when the bridge refused what the hold asked for. */
function line(outcome: FanCommandResult, what: string): string {
  return `${outcome.ok ? "" : "REFUSED — "}${what} — ${outcome.message}`;
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
  context.timer = setInterval(() => void checkForMovement(context), context.revertBeatMs);
}

function disarmRevert(context: FanCycleContext): void {
  if (context.timer !== null) {
    clearInterval(context.timer);
    context.timer = null;
  }
  // Cleared whether or not a timer was running: after a hand-back this is what takes
  // `fan_off_state` back off MOVED, one batch behind the mode, so a later arrival at
  // automatic from somewhere else — ./auto.ts's handBackToCurve() when the fun gate
  // closes — reads a genuine 0 rather than a stale "the bike moved".
  context.movingSince = null;
  record("fan_off_state", FAN_OFF_STATE.NOT_ARMED);
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
    if (context.timer === null) {
      // A beat queued before disarmRevert() cleared the timer. What it was armed for is
      // gone, so acting on it now would undo whatever replaced it.
      return;
    }
    const state = context.automatic.state();
    if (state.mode !== "manual" || state.targetPercent !== 0) {
      // Somebody else has the fan — the slider, or the endpoint. The *off* this file
      // commanded is gone, so there is nothing left to take back.
      disarmRevert(context);
      return;
    }
    const speedKmh = freshValue("speed_can_kmh", STATIONARY_MAX_AGE_MS);
    if (speedKmh === null || isBelowOffCeiling(speedKmh)) {
      // ⚠️ A NULL CLEARS THE MARK rather than leaving it to accumulate. The hold measures
      // PROVEN sustained motion and silence proves nothing — the same polarity as the
      // staleness rule above. The cost is that a bus stuttering at the beat rate could
      // never accumulate the hold; that is theoretical against 0x104 at 100 Hz (one
      // standing-still capture, 89.996 s, 8 999 frames, longest gap 10.78 ms —
      // docs/fan-control.md) and its failure direction is the fan staying off a little
      // longer, which the next fresh sample bounds.
      context.movingSince = null;
      return;
    }
    if (context.movingSince === null) {
      context.movingSince = monotonicNow();
    }
    if (since(context.movingSince) < context.revertHoldMs) {
      // Above the ceiling, but not for long enough to be riding away rather than shunting
      // forward in a queue. docs/fan-control.md has why this is a duration and not a
      // second speed threshold.
      return;
    }
    console.log(
      `fan: the bike has been above ${FAN_OFF_CEILING_KMH} km/h for ${context.revertHoldMs} ms ` +
        `(${speedKmh} km/h) with the fan switched off by hand — that is the curve's job again`
    );
    // ⚠️ Recorded on the line BEFORE the call, and that is load-bearing rather than tidy.
    // switchMode() sets the mode and publishes it synchronously before its first await, so
    // this lands in the SAME batch as `fan_auto_mode` — which is what lets the phone say
    // "automatic (moving)" rather than a bare "automatic". A record() after the await
    // would arrive a batch late and the wording would silently degrade.
    record("fan_off_state", FAN_OFF_STATE.MOVED);
    const outcome = await context.automatic.setMode("automatic");
    if (outcome.ok) {
      disarmRevert(context);
      return;
    }
    // Kept armed on purpose: the fan is still stopped and the bike is still moving, so
    // the next beat retries rather than leaving a pack to cook behind one refusal.
    // The MOVED above stays on the wire through the retries: record() seals only a value
    // that moved, so re-recording it every beat writes one row rather than one per beat.
    console.warn(`fan: could not hand the fan back to the curve — ${outcome.message}`);
  } catch (error) {
    // setInterval discards this promise, so an escaped rejection would be unhandled and
    // would end the service. Same shape as ./auto.ts's runTick().
    console.warn("fan: the gesture's movement watchdog failed —", error);
  }
}
