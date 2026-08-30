import { createVirtualClock } from "./virtual-clock.ts";

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
// That costs about 150 ms of real sleeping, all of it in section 1. It is the only part of
// this file that consults a real clock, and it consults it for ORDER, never for duration.

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
  setTimer(callback: () => void, delayMs: number): void;
  sleep(delayMs: number): Promise<void>;
  /** Lets `byMs` of this host's time pass — stepped for the fake one, slept for the real. */
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
  nestedArming: async (host, record) => {
    host.setTimer(() => {
      record("outer");
      host.setTimer(() => record("armed from inside the outer"), 5);
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

for (const [name, scenario] of Object.entries(SCENARIOS)) {
  const throughRealTimers = await run(scenario, realTimerHost());
  const throughFakeClock = await run(scenario, fakeClockHost());
  const same = throughRealTimers.join(" | ") === throughFakeClock.join(" | ");
  check(`⚠️  ${name} fires in the same ORDER on both`, same);
  if (!same) {
    console.error(`      real: ${JSON.stringify(throughRealTimers)}`);
    console.error(`      fake: ${JSON.stringify(throughFakeClock)}`);
  }
}

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
  return { setTimer: clock.setTimer, sleep: clock.sleep, advance: clock.advance };
}

/**
 * The oracle. `advance` sleeps for real and overshoots by a margin, because the question
 * being asked is only what order the callbacks ran in — a scenario that needed the margin
 * to be tight would be the exact assertion this whole clock exists to abolish.
 */
function realTimerHost(): TimerHost {
  const sleep = (delayMs: number) => new Promise<void>(resolve => void setTimeout(resolve, delayMs));
  return {
    setTimer: (callback, delayMs) => void setTimeout(callback, delayMs),
    sleep,
    advance: byMs => sleep(byMs + 10),
  };
}
