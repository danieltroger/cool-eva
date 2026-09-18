import { RATE_MIN_SPAN_MS, RATE_WINDOW_MS, type TemperatureSample } from "./rate.ts";

// When the controller is allowed to move again. Pure — samples and two facts about the last
// command in, a yes or no out. The half that decides WHAT to command is ./auto-curve.ts.
//
// ⚠️ THE LOOP ACTS TEN TIMES FASTER THAN IT MEASURES, and that is the second half of #276. A rate
// is fitted over RATE_WINDOW_MS and re-decided every AUTO_TICK_MS, so for the first ten ticks after
// a move the window still holds samples taken at the PREVIOUS current. Measured 2026-09-18: six
// cuts landed in five minutes, 80 → 35 A, while the pack moved one whole degree and the estimate
// collapsed 0.766 → 0.219 K/min the whole way down. Every one was sized from the current before it.
//
// ⚠️ AND YET ONLY RAISES WAIT. Waiting to cut is worse than cutting on a stale rate: over the
// frozen grid the wait applied to both directions crosses the cliff on 30 plants of 150 and to cuts
// alone on 51, against 16 for the rule this replaces and 15 for raises alone. ../../docs/charge-auto.md
// carries the table. The caller applies it to raises; this module only answers the question.
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
  if (readingFellSince(state, state.lastCommandAtMs)) {
    return false;
  }
  return state.nowMs - state.lastCommandAtMs < measurableAfterMs(state, state.lastCommandAtMs);
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
 * ⚠️ What this does NOT bound: a fitted slope that has not caught up with the last raise still
 * over-states the headroom five minutes later, so a raise can out-run its own measurement by one
 * step per interval. The frozen grid says the rule crosses the cliff no more often than the one it
 * replaces (15 plants against 16), and the setpoint guard and the cliff branch are what bound it.
 */
function measurableAfterMs(state: PaceState, lastCommandAtMs: number): number {
  if (state.rateIsNotRising && readingRoseSince(state, lastCommandAtMs)) {
    return RATE_WINDOW_MS;
  }
  return RATE_MIN_SPAN_MS;
}

/**
 * Whether the reading has FALLEN since the last command. Only raises wait, so this is the one
 * direction that matters: a pack that has cooled since we last touched the current is a pack with
 * room, whichever way that last command went. Measured 2026-09-18 at 17:21:14 — the reading came
 * back 52 → 51 fifty-six seconds after the descent reached the floor, and the bike's own next tick
 * gave current back. A wait through that is a wait through the evidence.
 *
 * ⚠️ No sample either side answers TRUE: with no evidence the shipped rule decides. A wait that can
 * suppress a move must fail towards acting.
 */
function readingFellSince(state: PaceState, lastCommandAtMs: number): boolean {
  const atCommand = newestSampleAtOrBefore(state.samples, lastCommandAtMs);
  const newest = newestSampleAtOrBefore(state.samples, state.nowMs);
  if (atCommand === undefined || newest === undefined) {
    return true;
  }
  return newest.celsius < atCommand.celsius;
}

/** Whether any reading since the last command is higher than the one it was commanded against. */
function readingRoseSince(state: PaceState, lastCommandAtMs: number): boolean {
  const atCommand = newestSampleAtOrBefore(state.samples, lastCommandAtMs);
  if (atCommand === undefined) {
    return false;
  }
  return state.samples.some(
    sample => sample.atMs > lastCommandAtMs && sample.atMs <= state.nowMs && sample.celsius > atCommand.celsius
  );
}

function newestSampleAtOrBefore(samples: TemperatureSample[], atMs: number): TemperatureSample | undefined {
  return samples.filter(sample => sample.atMs <= atMs).at(-1);
}
