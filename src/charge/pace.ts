import { newestSampleAtOrBefore, RATE_MIN_SPAN_MS, RATE_WINDOW_MS, type TemperatureSample } from "./rate.ts";

// When the controller is allowed to move again. Pure — samples and two facts about the last
// command in, a yes or no out. The half that decides WHAT to command is ./auto-curve.ts.
//
// ⚠️ THE LOOP ACTS TEN TIMES FASTER THAN IT MEASURES, and that is the second half of #276. A rate
// is fitted over RATE_WINDOW_MS and re-decided every AUTO_TICK_MS, so for the first ten ticks after
// a move the window still holds samples taken at the PREVIOUS current. Measured 2026-09-18: six
// cuts landed in five minutes, 80 → 35 A, while the pack moved one whole degree and the estimate
// collapsed 0.766 → 0.219 K/min the whole way down. Every one was sized from the current before it.
//
// ⚠️ AND YET ONLY RAISES WAIT, which is measured rather than chosen — docs/charge-auto.md § "A
// move the estimator cannot see" has the table. The caller applies it; this module only answers.
//
// ⚠️ A GATE ON ACTING, NOT A TRIM OF THE RING, and the difference is not cosmetic: dropping samples
// older than the last move makes `estimateHeatingRate` answer `unknown` for RATE_MIN_SPAN_MS, and
// `unknown` at or above the setpoint is BLIND_DESCENT — which cuts every single tick. That is the
// ratchet #163 removed, reinstated at the one temperature where it costs most.

/** What `commandIsUnmeasured` needs to know. Explicit, so nothing here reaches into the rule. */
export interface PaceState {
  samples: TemperatureSample[];
  nowMs: number;
  /** When this controller last put a current on the bus this session, monotonic, or null. */
  lastCommandAtMs: number | null;
  /** Whether the present estimate is the "the reading did not rise" arm rather than a fitted slope. */
  rateIsNotRising: boolean;
  /**
   * The setpoint, passed in rather than imported: `./auto-curve.ts` owns it and imports this file,
   * so reaching back for it would close a cycle. ⚠️ `./step.ts` answers the same question the other
   * way and imports the constants back, which is the cycle #279 left named as follow-up — this is
   * the direction a shared tuning module would take both. The band below is relative to it.
   */
  setpointC: number;
}

/**
 * Whether the estimator still cannot see what the last command did.
 *
 * ⚠️ The caller applies this BELOW THE SETPOINT ONLY. At or above it a reading of 54 can be a true
 * 54.99, so "the reading has not moved" is compatible with sitting a hundredth of a degree from the
 * cliff — and 2026-09-11 measured a pack at the 35 A floor at that reading still reaching 55.
 * docs/charge-auto.md § "A move the estimator cannot see".
 */
export function commandIsUnmeasured(state: PaceState): boolean {
  if (state.lastCommandAtMs === null) {
    return false;
  }
  // What the sensor last said when the command went out — the reference BOTH questions below are
  // about, so it is resolved once here rather than twice from two different functions.
  const atCommand = newestSampleAtOrBefore(state.samples, state.lastCommandAtMs);
  if (cooledFromBelowSetpoint(state, atCommand)) {
    return false;
  }
  return state.nowMs - state.lastCommandAtMs < measurableAfterMs(state, atCommand);
}

/**
 * How long to wait before the estimator's present answer says anything about the current flowing.
 *
 * RATE_MIN_SPAN_MS is the estimator's own "enough history to say anything at all" threshold
 * (`rate.ts`), so it is the shortest interval over which any statement about a new current can be
 * made, and it is what a raise waits by default. ⚠️ The exception is the case that would otherwise
 * read as evidence and is not: `not-rising` compares the WINDOW's endpoints, and the window is
 * anchored on the newest sample from BEFORE it — so a ring of 53, 52, a raise, then 53 again reads
 * `not-rising` on a pack that has demonstrably risen since that raise. There the wait is the whole
 * window, which is how long it takes for the anchor to leave and the answer to be about this
 * current alone.
 *
 * ⚠️ What it does NOT bound is in docs/charge-auto.md § "A move the estimator cannot see": a
 * fitted slope can still out-run itself by one step per interval.
 */
function measurableAfterMs(state: PaceState, atCommand: TemperatureSample | undefined): number {
  if (state.rateIsNotRising && readingRoseSince(state, atCommand)) {
    return RATE_WINDOW_MS;
  }
  return RATE_MIN_SPAN_MS;
}

/**
 * Whether the reading has fallen since the last command **from below the setpoint** — a pack that
 * has cooled is a pack with room, whichever way that last command went. Measured 2026-09-18 at
 * 17:21:14: the reading came back 52 → 51 fifty-six seconds after the descent reached the floor,
 * and the bike's own next tick gave current back.
 *
 * ⚠️ A FALL OUT OF THE SETPOINT BAND IS NOT A FALL, and that is #280: 31 of the 50 charging
 * crossings in the archive return 55 → 54 inside a minute with ~50 A still flowing, which is the
 * hottest cell's saw-tooth and not cooling. The measurements and what a train costs:
 * docs/charge-auto.md § "Riding the setpoint: what the whole archive says".
 *
 * ⚠️ The no-sample arm is UNREACHABLE and kept as the fail-safe default, so a mutation flipping
 * it SURVIVES the check on purpose — same as `sessionEndsFirst`'s guard, same doc § "The taper".
 */
function cooledFromBelowSetpoint(state: PaceState, atCommand: TemperatureSample | undefined): boolean {
  const newest = newestSampleAtOrBefore(state.samples, state.nowMs);
  if (atCommand === undefined || newest === undefined) {
    return true;
  }
  if (atCommand.celsius >= state.setpointC) {
    return false;
  }
  return newest.celsius < atCommand.celsius;
}

/** Whether any reading since the last command is higher than the one it was commanded against. */
function readingRoseSince(state: PaceState, atCommand: TemperatureSample | undefined): boolean {
  if (atCommand === undefined) {
    return false;
  }
  return state.samples.some(
    sample => sample.atMs > atCommand.atMs && sample.atMs <= state.nowMs && sample.celsius > atCommand.celsius
  );
}
