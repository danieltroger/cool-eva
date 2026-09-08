import { ageMs, latestValue, onChange, type LiveValue } from "../can/signals.ts";
import { monotonicNow } from "../monotonic.ts";
import { HOLD_OUTCOME, isPressOpen, newHoldState, observeHold, type HoldState } from "./long-press.ts";

// The half of the handlebar gestures that touches the world: it reads button bits off
// the bus, hands them to the pure recogniser in ./long-press.ts, and runs whatever the
// gesture is for. Nothing here decides whether a hold happened — that is all next door,
// so a press sequence can be replayed. docs/handlebar-gestures.md.
//
// ⚠️ One subscription and one recogniser serving several gestures, each with its OWN
// hold length: 1200 ms on MODE ENTER for the fan, 1000 ms on indicator-cancel for a
// waypoint, because the second button lights the hazards if it is held to ~2 s and the
// first does not.

/** What a gesture's action did, so the runner can put one honest line in the journal. */
export interface GestureOutcome {
  ok: boolean;
  message: string;
}

export interface HoldGesture {
  /** The signal whose 0/1 the hold is measured on. */
  button: string;
  /** How long this button must be held. Argued per button in docs/handlebar-gestures.md. */
  holdMs: number;
  /** What the gesture is for, in the journal line. */
  description: string;
  /** Runs on the hold. Never throws for the runner — a refusal comes back as ok: false. */
  perform: () => Promise<GestureOutcome>;
}

export interface HoldGestureOptions {
  /**
   * How often an OPEN press is re-examined.
   *
   * The seam ../fan/auto.ts's tickMs is, and for its stated reason: the alternative to
   * overriding it is a check that sits still for three real holds. Defaults to the
   * shipped value, so the service's own call passes nothing.
   */
  beatMs?: number;
}

/**
 * How often an open press is re-examined, and the only cadence in this file.
 *
 * ⚠️ Why a beat exists at all: a held button raises NO change event. ../can/signals.ts
 * notifies only when a reading moves past its deadband, so between the two edges of a
 * 1.2 s hold the button's own signal never fires — and without this the hold could only
 * ever be learned about from the release, which is exactly the evidence the freshness
 * rule refuses to trust.
 *
 * 100 ms is one tenth of the shorter hold, so a gesture fires within a beat of its
 * threshold. It runs ONLY while a press is open — the median handlebar press is 0.18 s,
 * so nearly every press costs one beat and the timer does not exist the rest of the time.
 */
export const HOLD_BEAT_MS = 100;

interface GestureRun {
  gesture: HoldGesture;
  state: HoldState;
  timer: ReturnType<typeof setInterval> | null;
  /** Whether this gesture's action is still running. See fireGesture(). */
  inFlight: boolean;
}

interface RunnerContext {
  runs: GestureRun[];
  beatMs: number;
  unsubscribe: (() => void) | null;
}

/**
 * Starts watching every button in the list. Returns the handle index.ts stops it with.
 *
 * ⚠️ Stopped BEFORE the fan loop in src/index.ts's shutdown, for the reason the fan loop
 * is stopped before the controller: a gesture landing after the bridge has been idled
 * would re-command a fan that is about to lose its process.
 */
export function startHoldGestures(gestures: HoldGesture[], options: HoldGestureOptions = {}): { stop: () => void } {
  const context: RunnerContext = {
    runs: gestures.map(gesture => ({ gesture, state: newHoldState(), timer: null, inFlight: false })),
    beatMs: options.beatMs ?? HOLD_BEAT_MS,
    unsubscribe: null,
  };
  context.unsubscribe = onChange(changed => onSignalsChanged(context, changed));
  for (const run of context.runs) {
    console.log(`gesture: ${run.gesture.button} held ${run.gesture.holdMs} ms — ${run.gesture.description}`);
  }
  return { stop: () => stopWatching(context) };
}

/**
 * A button bit moved. The edge half: it catches the press that opens a hold and the
 * release that ends one, and the beat below covers the middle, where nothing changes.
 */
function onSignalsChanged(context: RunnerContext, changed: Record<string, LiveValue>): void {
  for (const run of context.runs) {
    if (run.gesture.button in changed) {
      foldInSample(context, run);
    }
  }
}

/** One reading through the recogniser, plus whatever the answer implies for the beat. */
function foldInSample(context: RunnerContext, run: GestureRun): void {
  const key = run.gesture.button;
  const value = latestValue(key);
  const { state, outcome } = observeHold(run.state, {
    pressed: value !== null && Number.isFinite(value) ? value : null,
    sampleAgeMs: ageMs(key),
    nowMs: monotonicNow(),
    holdMs: run.gesture.holdMs,
  });
  run.state = state;
  if (outcome === HOLD_OUTCOME.ABANDONED) {
    console.log(
      `gesture: ${key} was down and the bus stopped saying so — the hold is abandoned rather than assumed ` +
        `(${run.gesture.description})`
    );
  }
  if (outcome === HOLD_OUTCOME.FIRED) {
    fireGesture(run);
  }
  // After the fold, not before: a press that has just opened wants a beat and one that
  // has just fired or been abandoned does not.
  if (isPressOpen(run.state)) {
    armBeat(context, run);
  } else {
    clearBeat(run);
  }
}

/** Re-examines an open press, since a held button produces no events of its own. */
function armBeat(context: RunnerContext, run: GestureRun): void {
  if (run.timer !== null) {
    return;
  }
  run.timer = setInterval(() => foldInSample(context, run), context.beatMs);
}

function clearBeat(run: GestureRun): void {
  if (run.timer !== null) {
    clearInterval(run.timer);
    run.timer = null;
  }
}

/**
 * Runs the gesture's action and reports what it did.
 *
 * ⚠️ The promise is DISCARDED by both callers — a change-listener callback and a timer —
 * so an escaped rejection would be unhandled, which today ends the process and takes the
 * CAN logging and the WebSocket with it. Same shape as ../fan/fun-runner.ts's runFunPass.
 *
 * ⚠️ And a REFUSAL is not a rejection. ../fan/control.ts returns `{ok: false}` rather
 * than throwing when it will not do something, so a catch alone would leave the one
 * outcome that actually happens silent.
 */
function fireGesture(run: GestureRun): void {
  if (run.inFlight) {
    // Unreachable while two holds cannot be 100 ms apart, and guarded anyway because the
    // state it would read is briefly inconsistent: ../fan/auto.ts's commandManual() sets
    // the mode synchronously and only clears the target inside its awaited stop, so a
    // second fire landing in that window would pick its next step from half a change.
    console.warn(`gesture: ${run.gesture.button} fired while the last one was still running — ignoring the second`);
    return;
  }
  run.inFlight = true;
  // ⚠️ perform() is called INSIDE the try, not merely awaited: a synchronous throw — from
  // a helper that runs before the async function's first await — would never become a
  // rejected promise, so it would escape into a setInterval callback with nothing above
  // it, end the process, and leave the flag latched so nothing fired again either.
  let running: Promise<GestureOutcome>;
  try {
    running = run.gesture.perform();
  } catch (error) {
    run.inFlight = false;
    console.warn(`gesture: ${run.gesture.button} — ${run.gesture.description} threw:`, error);
    return;
  }
  void running
    .then(outcome => {
      const verdict = outcome.ok ? "" : "REFUSED — ";
      console.log(`gesture: ${run.gesture.button} held ${run.gesture.holdMs} ms — ${verdict}${outcome.message}`);
    })
    .catch(error => {
      console.warn(`gesture: ${run.gesture.button} — ${run.gesture.description} threw:`, error);
    })
    .finally(() => {
      run.inFlight = false;
    });
}

function stopWatching(context: RunnerContext): void {
  if (context.unsubscribe !== null) {
    context.unsubscribe();
    context.unsubscribe = null;
  }
  for (const run of context.runs) {
    clearBeat(run);
  }
}
