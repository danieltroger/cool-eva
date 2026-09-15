import { createVirtualClock } from "./virtual-clock.ts";
import { monotonicNow, since } from "../src/monotonic.ts";

// scripts/virtual-clock.ts, checked against the thing it stands in for.
//
//   node --experimental-strip-types scripts/check-virtual-clock.ts
//
// ⚠️ WHY A FAKE CLOCK NEEDS ITS OWN CHECK. check-fan-endpoint.ts §3 asserts an exact
// interval on this clock and nothing else, so a clock that reordered callbacks would leave
// that section green while proving nothing — a strictly worse failure than the flake it was
// written to remove. Both properties its header claims by name could be deleted without a
// single assertion noticing: same-instant timers firing in arm order, and the microtask
// drain between one timer and the next. Section 1 below pins them by DIFFERENTIAL TEST —
// the same scenario driven twice, once through real setTimeout and once through this clock,
// comparing the order of recorded events. Real timers are the oracle, so an assertion here
// cannot be satisfied by a model and a check that are wrong in the same direction.
//
// ⚠️ THE ORACLE IS WAITED OUT, NEVER TIMED, and each scenario runs a third time with the
// event loop deliberately blocked. Which orderings starvation can and cannot move, why it
// used to matter (#258), and the measurements: docs/diagnostics-and-checks.md §11.9.

let failures = 0;

function check(what: string, condition: boolean) {
  if (condition) {
    console.log(`  ✓ ${what}`);
  } else {
    console.error(`  ✗ ${what}`);
    failures += 1;
  }
}

/** What a scenario is given, so the same code can be driven by either clock. */
interface TimerHost {
  /** `unknown` so the real host can await an async callback's promise before calling it done. */
  setTimer(callback: () => unknown, delayMs: number): void;
  sleep(delayMs: number): Promise<void>;
  /**
   * Lets this host's time pass: `byMs` of it for the fake clock, all of it for the real one,
   * which waits for what it armed and IGNORES `byMs`. A scenario arming a timer past its own
   * window would therefore fire on the real side and not the fake one, and read as a clock
   * bug — none of the five below does, and a new one must not.
   */
  advance(byMs: number): Promise<void>;
}

type Scenario = (host: TimerHost, record: (label: string) => void) => Promise<void>;

// --- 1. the differential: this clock against real setTimeout ------------------

console.log("\n1. the same scenarios through real timers and through the fake clock");

/**
 * ⚠️ One accepted divergence, and it is why `zeroDelayFirst` arms in the order it does:
 * Node coerces `setTimeout(fn, 0)` to 1 ms and this clock does not. A scenario that armed
 * the 1 ms timer FIRST would order the two differently in real Node and here. Arming the
 * zero first is where the two agree, and that is the case the fan queue actually hits — its
 * first flush is armed with a wait of exactly 0.
 */
const SCENARIOS: Record<string, Scenario> = {
  sameInstantTimers: async (host, record) => {
    host.setTimer(() => record("armed first"), 10);
    host.setTimer(() => record("armed second"), 10);
    await host.advance(20);
  },
  promiseChainBetweenTimers: async (host, record) => {
    let openTheChain = () => {};
    const chain = new Promise<void>(resolve => {
      openTheChain = resolve;
    });
    void chain.then(() => record("the chain the first timer resumed"));
    host.setTimer(() => {
      record("first timer");
      openTheChain();
    }, 10);
    host.setTimer(() => record("second timer"), 20);
    await host.advance(30);
  },
  /**
   * ⚠️ 15 and not 5, and that is the only direction this can be asked in. A timer armed
   * INSIDE a callback is due from when that callback actually ran, so a stall can only
   * push it later — never earlier. At +15 it is due at 25 against the 20 armed up front,
   * by construction and at any stall; at +5 the two are 15 against 20 and an 18 ms stall
   * swaps them, which is issue #258. That a nested arm lands by DUE TIME rather than at
   * the back of the queue is the half no oracle can be asked, and §2 asserts it instead.
   */
  nestedArming: async (host, record) => {
    host.setTimer(() => {
      record("outer");
      host.setTimer(() => record("armed from inside the outer"), 15);
    }, 10);
    host.setTimer(() => record("armed up front for 20"), 20);
    await host.advance(40);
  },
  asyncCallbackAwaitingSleep: async (host, record) => {
    host.setTimer(async () => {
      record("callback entered");
      await host.sleep(10);
      record("callback resumed");
    }, 10);
    host.setTimer(() => record("a later timer, which must not wait for it"), 15);
    await host.advance(40);
  },
  zeroDelayFirst: async (host, record) => {
    host.setTimer(() => record("zero"), 0);
    host.setTimer(() => record("one millisecond"), 1);
    await host.advance(10);
  },
};

/**
 * Starves the event loop on purpose, the way a loaded laptop does by accident.
 *
 * Longer than the longest delay any scenario arms up front, so EVERY pre-armed timer comes
 * due inside it and Node runs them back to back — which is the condition that inverted an
 * ordering in #258, and what the assertion after the differential keeps true.
 */
const STALL_MS = 30;

/** The longest delay any scenario armed up front, which is what STALL_MS has to cover. */
let longestPreArmedMs = 0;

for (const [name, scenario] of Object.entries(SCENARIOS)) {
  const throughFakeClock = (await run(scenario, fakeClockHost())).join(" | ");
  for (const stallMs of [0, STALL_MS]) {
    const realHost: RealHostState = { outstanding: 0, releaseAdvance: null, longestPreArmedMs: 0 };
    const throughRealTimers = (await run(scenario, realTimerHost(stallMs, realHost))).join(" | ");
    longestPreArmedMs = Math.max(longestPreArmedMs, realHost.longestPreArmedMs);
    const same = throughRealTimers === throughFakeClock;
    const how = stallMs === 0 ? "" : ` — with the event loop blocked for ${stallMs} ms first`;
    check(`⚠️  ${name} fires in the same ORDER on both${how}`, same);
    if (!same) {
      console.error(`      real: ${throughRealTimers}`);
      console.error(`      fake: ${throughFakeClock}`);
    }
  }
}

// ⚠️ MEASURED FROM THE RUN, not restated from the table above. The stalled pass only proves
// what it claims while every pre-armed timer comes due INSIDE the stall; a sixth scenario
// arming for longer would quietly downgrade it to a second copy of the unstalled pass, with
// docs/diagnostics-and-checks.md §11.9 still saying otherwise.
check(
  `⚠️  the ${STALL_MS} ms stall still covers every delay the scenarios arm up front (longest: ${longestPreArmedMs} ms)`,
  longestPreArmedMs > 0 && STALL_MS > longestPreArmedMs
);

// --- 2. what the fake clock does that no real one can ------------------------

console.log("\n2. the deliberate divergence, and the boundaries");

const deadlineClock = createVirtualClock(100);
const readings: number[] = [];
deadlineClock.setTimer(() => readings.push(deadlineClock.now()), 10);
deadlineClock.setTimer(() => readings.push(deadlineClock.now()), 25);
await deadlineClock.advance(40);
check(
  "⚠️  a callback is told when it was DUE, not when the step it fell inside ends — the whole reason the file exists",
  readings[0] === 110 && readings[1] === 125
);
check("…and the clock lands on the caller's target once the step is over", deadlineClock.now() === 140);

const edgeClock = createVirtualClock(0);
let firedAtTheEdge = 0;
edgeClock.setTimer(() => (firedAtTheEdge += 1), 10);
await edgeClock.advance(10);
check("a timer due exactly at the window's edge fires inside it, not after it", firedAtTheEdge === 1);

// ⚠️ THE HALF §1 GAVE UP. A timer armed from inside a callback has to land by its DUE TIME
// against timers already waiting, not at the back of the queue — and §1 can only ask that
// in the direction a stall cannot move (see `nestedArming`). Here there is no stall to
// worry about, so the clock is asked the other way round: the nested 5 ms lands BEFORE the
// 20 ms that was armed up front, and each callback's own now() says when. A clock that
// appended nested timers would pass every scenario in §1 and fail here.
const nestedDueClock = createVirtualClock(0);
const nestedDueOrder: string[] = [];
nestedDueClock.setTimer(() => {
  nestedDueOrder.push(`outer at ${nestedDueClock.now()}`);
  nestedDueClock.setTimer(() => nestedDueOrder.push(`nested at ${nestedDueClock.now()}`), 5);
}, 10);
nestedDueClock.setTimer(() => nestedDueOrder.push(`armed up front at ${nestedDueClock.now()}`), 20);
await nestedDueClock.advance(40);
check(
  "⚠️  a timer armed from inside a callback is queued by its DEADLINE, ahead of one armed earlier for later",
  nestedDueOrder.join(" | ") === "outer at 10 | nested at 15 | armed up front at 20"
);

const alreadyDueClock = createVirtualClock(0);
let firedWithoutMoving = 0;
alreadyDueClock.setTimer(() => (firedWithoutMoving += 1), 0);
await alreadyDueClock.advance(0);
check("advance(0) runs a timer that is already due", firedWithoutMoving === 1);

// --- 3. the three ways to corrupt it, all of them refused --------------------

console.log("\n3. the hazards");

const oddDelayClock = createVirtualClock(1000);
const oddDelayOrder: string[] = [];
oddDelayClock.setTimer(() => oddDelayOrder.push(`negative at ${oddDelayClock.now()}`), -50);
oddDelayClock.setTimer(() => oddDelayOrder.push(`NaN at ${oddDelayClock.now()}`), NaN);
oddDelayClock.setTimer(() => oddDelayOrder.push(`five at ${oddDelayClock.now()}`), 5);
await oddDelayClock.advance(10);
check(
  "⚠️  a NaN delay is treated as zero rather than setting now() to NaN for every later reader",
  oddDelayOrder[1] === "NaN at 1000"
);
check(
  "a negative delay is clamped to the current instant, as Node clamps one to 1 ms",
  oddDelayOrder[0] === "negative at 1000"
);
check("…and the ordinary timer behind them is unharmed", oddDelayOrder[2] === "five at 1005");
check("…and the clock itself is still a number", oddDelayClock.now() === 1010);

const spinClock = createVirtualClock(0);
let spinFires = 0;
let spinFailure: Error | null = null;
try {
  spinClock.setTimer(rearmForever, 0);
  await spinClock.advance(100);
} catch (error) {
  spinFailure = error instanceof Error ? error : new Error(String(error));
}
check(
  "⚠️  a self-rearming zero-delay timer is refused rather than spinning until the suite times out",
  spinFailure !== null
);
check(
  "…and the message names the callback that would not stop, which `check timed out after 120 s` never would",
  spinFailure !== null && spinFailure.message.includes("rearmForever")
);
check(
  "…and says where the clock got stuck, so the diagnosis is that time stopped rather than that the machine did",
  spinFailure !== null && spinFailure.message.includes("stuck at 0")
);
check("…and it did stop, rather than being merely slow", spinFires < 20_000);

const overlappingClock = createVirtualClock(0);
let overlapFailure: Error | null = null;
const longStep = overlappingClock.advance(500);
try {
  await overlappingClock.advance(20);
} catch (error) {
  overlapFailure = error instanceof Error ? error : new Error(String(error));
}
await longStep;
check(
  "⚠️  a second advance() while one is still running is refused rather than corrupting its window",
  overlapFailure !== null && overlapFailure.message.includes("await the first")
);
check("…and the refusal leaves the clock usable — the guard is cleared on the way out", overlappingClock.now() === 500);
const afterOverlap: string[] = [];
overlappingClock.setTimer(() => afterOverlap.push("still works"), 5);
await overlappingClock.advance(10);
check("…and a timer armed afterwards still fires", afterOverlap.length === 1);

console.log("");
if (failures > 0) {
  console.error(`FAILED — ${failures} assertion${failures === 1 ? "s" : ""}`);
  process.exitCode = 1;
} else {
  console.log("✓ the fake clock orders callbacks the way real timers do, reports each callback's own deadline, and");
  console.log("  refuses the three inputs that would silently corrupt it");
}

/** A named declaration and not an arrow, so the runaway message can quote a name. */
function rearmForever(): void {
  spinFires += 1;
  spinClock.setTimer(rearmForever, 0);
}

async function run(scenario: Scenario, host: TimerHost): Promise<string[]> {
  const order: string[] = [];
  await scenario(host, label => order.push(label));
  return order;
}

function fakeClockHost(): TimerHost {
  const clock = createVirtualClock(10_000);
  return {
    setTimer: (callback, delayMs) => clock.setTimer(() => void callback(), delayMs),
    sleep: clock.sleep,
    advance: clock.advance,
  };
}

/** What one real-timer run is still waiting for. */
interface RealHostState {
  /** Timers armed and sleeps started that have not finished. advance() ends when this is 0. */
  outstanding: number;
  /** Resolves the advance() in flight, or null when nobody is waiting. */
  releaseAdvance: (() => void) | null;
  /** The longest delay armed before the first advance(), so STALL_MS can be checked against it. */
  longestPreArmedMs: number;
}

/**
 * The oracle: real setTimeout, asked only what ORDER its callbacks ran in.
 *
 * ⚠️ `advance` WAITS FOR WHAT IT ARMED rather than sleeping a window. It used to sleep
 * `byMs + 10`, and a timer armed from inside a callback could then be due after the window
 * closed — the run was simply short an event and the comparison failed on a busy laptop
 * (#258, reproduced in `nestedArming` and `asyncCallbackAwaitingSleep` both). A count can
 * only take longer under load; it cannot come out wrong.
 */
function realTimerHost(stallMs: number, state: RealHostState): TimerHost {
  const sleep = (delayMs: number) =>
    new Promise<void>(resolve => {
      state.outstanding += 1;
      setTimeout(() => {
        resolve();
        finishOne(state);
      }, delayMs);
    });
  return {
    sleep,
    setTimer: (callback, delayMs) => armRealTimer(state, callback, delayMs),
    advance: async () => {
      blockTheEventLoop(stallMs);
      await waitForQuiescence(state);
    },
  };
}

function armRealTimer(state: RealHostState, callback: () => unknown, delayMs: number): void {
  state.outstanding += 1;
  state.longestPreArmedMs = Math.max(state.longestPreArmedMs, delayMs);
  setTimeout(() => {
    // Awaited, so an async callback is outstanding until its body finishes rather than
    // until it first suspends — `asyncCallbackAwaitingSleep` would otherwise be counted
    // done at its first await and lose the record after it.
    void Promise.resolve(callback()).then(
      () => finishOne(state),
      error => {
        // Counted, not only logged: the order this scenario recorded may well still match,
        // and a run that ends green with one line on stderr is what a harness grepping
        // stdout reads as a pass.
        failures += 1;
        console.error("check-virtual-clock: a scenario callback threw on the real host —", error);
        finishOne(state);
      }
    );
  }, delayMs);
}

function finishOne(state: RealHostState): void {
  state.outstanding -= 1;
  if (state.outstanding === 0 && state.releaseAdvance !== null) {
    const release = state.releaseAdvance;
    state.releaseAdvance = null;
    release();
  }
}

/**
 * Resolves once nothing is outstanding.
 *
 * ⚠️ The zero case is checked FIRST and is not a formality: waiting on a count that is
 * already 0 waits for a decrement that will never come, and the diagnosis run-checks.ts
 * would then print is a 120 s timeout — on the file whose own header sells that timeout as
 * the good diagnosis. The only hang left is a timer Node never delivered, which is the
 * failure CHECK_TIMEOUT_MS is for.
 *
 * The `setImmediate` is what `virtual-clock.ts`'s advance() does between timers: it lets
 * every continuation that can already run, run, so both hosts end a scenario the same way
 * and a record made one microtask after the last timer is not lost.
 */
async function waitForQuiescence(state: RealHostState): Promise<void> {
  if (state.outstanding > 0) {
    await new Promise<void>(resolve => {
      state.releaseAdvance = resolve;
    });
  }
  await new Promise<void>(resolve => void setImmediate(resolve));
}

function blockTheEventLoop(stallMs: number): void {
  const startedAt = monotonicNow();
  while (since(startedAt) < stallMs) {
    // Deliberately nothing: the point is that no callback can run.
  }
}
