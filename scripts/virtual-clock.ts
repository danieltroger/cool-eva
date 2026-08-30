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
 *   code under test may well care how far the clock is from zero, and 0 is the origin
 *   most likely to catch it out — check-fan-endpoint.ts §3 drives the fan queue from both
 *   0 and 10 s for that reason.
 */
export function createVirtualClock(startMs: number): VirtualClock {
  const state: ClockState = { nowMs: startMs, armed: [], nextSequence: 0, advancing: false };
  return {
    now: () => state.nowMs,
    setTimer: (callback, delayMs) => armTimer(state, callback, delayMs),
    sleep: delayMs => new Promise(resolve => armTimer(state, () => resolve(), delayMs)),
    advance: byMs => advance(state, byMs),
  };
}

/**
 * How many timers one advance() may fire before it is treated as a runaway.
 *
 * ⚠️ Virtual time does not move while same-instant timers keep arming each other, so a
 * self-rearming zero-delay timer never reaches `until` and spins for ever — measured at
 * 182 951 fires in 2.5 s with now() never leaving its start value. This is the one place
 * the model is WEAKER than what it stands in for: real setTimeout clamps to 1 ms, so the
 * same code makes progress against a real clock. run-checks.ts would eventually call it a
 * 120 s timeout, which is a far worse diagnosis than naming the callback that would not
 * stop re-arming.
 */
const MAX_TIMERS_PER_ADVANCE = 10_000;

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
  /** An advance() is in flight. Two at once would step on each other — see advance(). */
  advancing: boolean;
}

function armTimer(state: ClockState, callback: () => void, delayMs: number): void {
  // Math.max alone lets NaN through — Math.max(0, NaN) is NaN — and a NaN dueAt is never
  // greater than `until`, so the timer gets SELECTED and sets now() to NaN. Real
  // setTimeout coerces a non-finite delay to 0, so this does too rather than inventing
  // behaviour the oracle in check-virtual-clock.ts does not have.
  const delay = Number.isFinite(delayMs) ? Math.max(0, delayMs) : 0;
  state.armed.push({ dueAt: state.nowMs + delay, sequence: state.nextSequence, run: callback });
  state.nextSequence += 1;
}

async function advance(state: ClockState, byMs: number): Promise<void> {
  // `nowMs` and `armed` are shared while `until` is captured per call, so two advances in
  // flight together corrupt each other's window: measured, an advance(20) fired a timer
  // due 50 ms out because an advance(500) was still running. Every caller today awaits
  // one before starting the next; this is what keeps that a requirement rather than a
  // habit.
  if (state.advancing) {
    throw new Error("virtual clock: advance() called while another advance() is still running — await the first");
  }
  state.advancing = true;
  try {
    const until = state.nowMs + byMs;
    await drainMicrotasks();
    let fired = 0;
    for (let due = takeNextDue(state, until); due !== null; due = takeNextDue(state, until)) {
      fired += 1;
      if (fired > MAX_TIMERS_PER_ADVANCE) {
        const culprit = String(due.run).replace(/\s+/g, " ").slice(0, 120);
        throw new Error(
          `virtual clock: ${MAX_TIMERS_PER_ADVANCE} timers in one advance(${byMs}) with the clock stuck at ` +
            `${state.nowMs} — a timer is re-arming itself with no delay: ${culprit}`
        );
      }
      // The clock reads the timer's own deadline while it runs, never the caller's target:
      // a callback that asks what time it is must be told when it was due, not when the
      // step it happened to fall inside will end.
      state.nowMs = due.dueAt;
      due.run();
      await drainMicrotasks();
    }
    state.nowMs = until;
    await drainMicrotasks();
  } finally {
    state.advancing = false;
  }
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
