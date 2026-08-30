// A clock a check steps by hand, for modules that take `now` and `setTimer` as parameters
// — public/lib/fan-command-queue.js is the one that does today.
//
// ⚠️ Why it exists: an assertion about an INTERVAL cannot be made against the real clock.
// check-fan-endpoint.ts asserted that two coalesced POSTs land one 60 ms interval apart,
// with 1 ms of tolerance for the fact that setTimeout answers a wait up to a millisecond
// EARLY — libuv's loop time is whole milliseconds while performance.now() is not. That
// left about a tenth of a millisecond of headroom, split between two performance.now()
// reads with an async call between them, so the assertion went red about one run in a
// hundred on an idle laptop and more often than that on a busy CI runner. Nothing was
// ever wrong with the queue. Stepping the clock takes the machine out of the measurement,
// which widening the tolerance would not have done: it would have hidden the next real
// regression along with the noise.
//
// Real time still ORDERS the callbacks — advance() drains the microtask queue between one
// timer and the next, so a promise chain resumed by a fake timer has run to its next await
// before the following timer fires. It just no longer MEASURES anything.

/** Milliseconds that pass only when the check says so. */
export interface VirtualClock {
  now(): number;
  /** Arms a one-shot timer — the shape public/lib/fan-command-queue.js asks for. */
  setTimer(callback: () => void, delayMs: number): void;
  /** The same as a promise, for a stand-in that takes time to answer. */
  sleep(delayMs: number): Promise<void>;
  /** Runs every timer that comes due within `byMs`, in order, and settles what they resume. */
  advance(byMs: number): Promise<void>;
}

/**
 * @param startMs where the clock reads before anything happens. No default on purpose:
 *   code under test may well care how far the clock is from zero — the fan queue's first
 *   command goes without waiting precisely because its `lastSentAt` starts a whole
 *   interval behind any clock a real page reads.
 */
export function createVirtualClock(startMs: number): VirtualClock {
  const state: ClockState = { nowMs: startMs, armed: [], nextSequence: 0 };
  return {
    now: () => state.nowMs,
    setTimer: (callback, delayMs) => armTimer(state, callback, delayMs),
    sleep: delayMs => new Promise(resolve => armTimer(state, () => resolve(), delayMs)),
    advance: byMs => advance(state, byMs),
  };
}

interface ArmedTimer {
  dueAt: number;
  /** Order armed, so two timers due at the same instant fire in the order they were asked for. */
  sequence: number;
  run: () => void;
}

interface ClockState {
  nowMs: number;
  armed: ArmedTimer[];
  nextSequence: number;
}

function armTimer(state: ClockState, callback: () => void, delayMs: number): void {
  state.armed.push({ dueAt: state.nowMs + Math.max(0, delayMs), sequence: state.nextSequence, run: callback });
  state.nextSequence += 1;
}

async function advance(state: ClockState, byMs: number): Promise<void> {
  const until = state.nowMs + byMs;
  await drainMicrotasks();
  for (let due = takeNextDue(state, until); due !== null; due = takeNextDue(state, until)) {
    // The clock reads the timer's own deadline while it runs, never the caller's target:
    // a callback that asks what time it is must be told when it was due, not when the
    // step it happened to fall inside will end.
    state.nowMs = due.dueAt;
    due.run();
    await drainMicrotasks();
  }
  state.nowMs = until;
  await drainMicrotasks();
}

function takeNextDue(state: ClockState, until: number): ArmedTimer | null {
  let earliest: ArmedTimer | null = null;
  for (const timer of state.armed) {
    if (timer.dueAt > until) continue;
    const isEarlier =
      earliest === null ||
      timer.dueAt < earliest.dueAt ||
      (timer.dueAt === earliest.dueAt && timer.sequence < earliest.sequence);
    if (isEarlier) {
      earliest = timer;
    }
  }
  if (earliest !== null) {
    state.armed.splice(state.armed.indexOf(earliest), 1);
  }
  return earliest;
}

/**
 * Lets every promise continuation that can already run, run.
 *
 * setImmediate is a macrotask, so the whole microtask queue drains ahead of it — and it is
 * not a timer, so nothing here asks the real clock what time it is.
 */
function drainMicrotasks(): Promise<void> {
  return new Promise(resolve => setImmediate(() => resolve()));
}
