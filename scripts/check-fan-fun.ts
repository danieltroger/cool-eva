import { boundsFor } from "../public/lib/bounds.js";
import {
  DUTY_STEP_PERCENT,
  FAN_MODE_CODE as PAGE_MODE_CODE,
  FUN_GATE_TEXT,
  dutyStops,
} from "../public/lib/fan-display.js";
import { SIGNALS } from "../src/can/registry.ts";
import { defineSignals, latestValue, onChange, record } from "../src/can/signals.ts";
import { FAN_MODE_CODE, startFanAutomatic } from "../src/fan/auto.ts";
import type { FanCommandResult, FanController, FanState } from "../src/fan/control.ts";
import { KICK_START_MS, MAX_DUTY_PERCENT, MIN_RUNNING_DUTY_PERCENT, startFanControl } from "../src/fan/control.ts";
import {
  FUN_GATE,
  FUN_GATE_MAX_AGE_MS,
  FUN_GATE_REFUSAL,
  FUN_WATCHDOG_MS,
  funDutyPercent,
  funGate,
  funGateAllows,
  type FunGateInputs,
} from "../src/fan/fun.ts";
import { PWM_PERIOD_NS, dutyToNanoseconds, type FanPwm } from "../src/fan/pwm.ts";

// Fun mode — the rider's throttle driving the radiator fan — checked with no bike, no Pi
// and no fan.
//
//   node --experimental-strip-types scripts/check-fan-fun.ts
//
// ⚠️ THIS IS A SAFETY GATE IN FRONT OF THE THROTTLE OF A 145 hp MOTORCYCLE. Every
// assertion below is about one of two things: that the gate refuses everything except a
// bike which is provably unable to move, and that the mapping never puts the fan
// somewhere the rest of src/fan/ does not expect. A gate that is wrong here is a rider
// twisting a throttle for a fan and getting a motorcycle.
//
// ⚠️ NO NEW SEAM. src/fan/fun.ts's two constants are used at their shipped values
// throughout, including the 500 ms staleness window §5 waits out for real, because this
// repo has twice added a test seam and moved production's default out of coverage
// (#125, #128). The only overrides used are src/fan/auto.ts's existing tickMs and
// staleness options, which belong to the temperature curve rather than to fun mode.

let failures = 0;

function check(what: string, condition: boolean) {
  if (condition) {
    console.log(`  ✓ ${what}`);
  } else {
    console.error(`  ✗ ${what}`);
    failures += 1;
  }
}

// --- 1. The mapping ----------------------------------------------------------
//
// Throttle 0…100 % onto duty 30…100 %. The endpoints and the midpoint are asserted as
// LITERALS rather than recomputed from the constants: an assertion that recomputes the
// thing it is checking passes for every value of it, which is not a check.

console.log("\n1. the throttle maps onto the fan's whole running range");

check(`a closed throttle is the floor, and the floor is 30 % (${funDutyPercent(0)})`, funDutyPercent(0) === 30);
check(`a wide-open throttle is the cap, and the cap is 100 % (${funDutyPercent(100)})`, funDutyPercent(100) === 100);
check(`half throttle is halfway up the running band (${funDutyPercent(50)})`, funDutyPercent(50) === 65);
check(
  "the endpoints are the constants src/fan/control.ts enforces, not a second copy of them",
  funDutyPercent(0) === MIN_RUNNING_DUTY_PERCENT && funDutyPercent(100) === MAX_DUTY_PERCENT
);

// ⚠️ THE ASSERTION THAT PINS THE WHOLE DESIGN. Nothing the throttle can do stops the fan:
// no duty in the range crosses src/fan/control.ts's stop threshold, so the bridge enables
// are set once on entry and cleared once on exit and `pinctrl` is never spawned by a
// wrist. Take the floor out of the mapping — start the ramp at 0 — and this goes red at
// the first sample.
let belowFloor = 0;
let notAscending = 0;
let previous = -1;
for (let step = 0; step <= 1000; step += 1) {
  const duty = funDutyPercent(step / 10);
  if (duty < MIN_RUNNING_DUTY_PERCENT) {
    belowFloor += 1;
  }
  if (duty < previous) {
    notAscending += 1;
  }
  previous = duty;
}
check(
  `⚠️  no throttle position in 0…100 % maps below the ${MIN_RUNNING_DUTY_PERCENT} % floor (1001 sampled)`,
  belowFloor === 0
);
check("…and the duty never goes down as the throttle goes up", notAscending === 0);
check(
  "a throttle outside 0…100 is clamped into the band rather than escaping it",
  funDutyPercent(-40) === MIN_RUNNING_DUTY_PERCENT && funDutyPercent(140) === MAX_DUTY_PERCENT
);
check(
  "and a throttle that is not a finite number lands on the FLOOR rather than on NaN or on full duty",
  funDutyPercent(Number.NaN) === MIN_RUNNING_DUTY_PERCENT &&
    funDutyPercent(Number.POSITIVE_INFINITY) === MIN_RUNNING_DUTY_PERCENT
);

// --- 2. The precision ---------------------------------------------------------
//
// `throttle_pct` is `u16le(b0,b1) / 10` off 0x109, and the archive shows it stepping by
// single raw units — 22, 23, 24, 25, 26, 27, 28, 29 consecutively — so its resolution is
// 0.1 %. Hearing where that runs out on the fan is the point of the mode, so a duty
// rounded to whole percent would throw away 14 of every 15 steps.

console.log("\n2. one raw throttle step is one visible step of PWM");

check(
  "the duty is a FRACTIONAL percent, not rounded to whole percent",
  !Number.isInteger(funDutyPercent(10.1)) && funDutyPercent(10.1) === 37.07
);
check(
  `one 0.1 % throttle step is 35 ns of a ${PWM_PERIOD_NS} ns period`,
  dutyToNanoseconds(funDutyPercent(10.1)) - dutyToNanoseconds(funDutyPercent(10.0)) === 35
);

let sameNanoseconds = 0;
let lastNs = -1;
for (let step = 0; step <= 1000; step += 1) {
  const nanoseconds = dutyToNanoseconds(funDutyPercent(step / 10));
  if (nanoseconds === lastNs) {
    sameNanoseconds += 1;
  }
  lastNs = nanoseconds;
}
check(
  "⚠️  every one of the 1000 raw throttle steps reaches the bridge as a different duty_cycle",
  sameNanoseconds === 0
);
check(
  "the full sweep spans 35 000 ns of the period — 70 % of it, which is the running band",
  dutyToNanoseconds(funDutyPercent(100)) - dutyToNanoseconds(funDutyPercent(0)) === 35_000
);

// --- 3. The gate, pure --------------------------------------------------------
//
// ⚠️ FAIL-CLOSED IS THE PROPERTY. The only way to READY is three signals present, fresh
// and reading the values that mean a stationary bike with the drive disabled; every other
// input, including ones nobody anticipated, is a refusal.

console.log("\n3. the gate refuses everything but a bike that cannot move");

function gateInputs(overrides: Partial<FunGateInputs> = {}): FunGateInputs {
  return { go: 0, speedKmh: 0, throttlePercent: 12.3, ...overrides };
}

check("a parked bike with a readable throttle is READY", funGate(gateInputs()) === FUN_GATE.READY);
check(
  "⚠️  `go` set is a refusal — the bike is in Go and the throttle belongs to the motor",
  funGate(gateInputs({ go: 1 })) === FUN_GATE.GO_SET
);
check(
  "⚠️  a MISSING or stale `go` is a refusal too, never a pass",
  funGate(gateInputs({ go: null })) === FUN_GATE.GO_UNKNOWN
);
check("…and so is a `go` that is not a number at all", funGate(gateInputs({ go: Number.NaN })) === FUN_GATE.GO_UNKNOWN);
check("a non-zero speed is a refusal", funGate(gateInputs({ speedKmh: 3 })) === FUN_GATE.MOVING);
check(
  "…with no tolerance band: 0.1 km/h is a bike being rolled, and that is moving",
  funGate(gateInputs({ speedKmh: 0.1 })) === FUN_GATE.MOVING
);
check(
  "a negative or absurd speed is a refusal rather than a rounding",
  funGate(gateInputs({ speedKmh: -1 })) === FUN_GATE.MOVING
);
check("a missing speed is a refusal", funGate(gateInputs({ speedKmh: null })) === FUN_GATE.SPEED_UNKNOWN);
check(
  "⚠️  …which is the OPPOSITE of src/fan/curve.ts's speed gate, where a missing speed opens it",
  funGate(gateInputs({ speedKmh: null })) !== FUN_GATE.READY
);
check(
  "a missing throttle is a refusal — there would be nothing to drive the fan with",
  funGate(gateInputs({ throttlePercent: null })) === FUN_GATE.THROTTLE_UNKNOWN
);
check(
  "`go` is reported ahead of everything else, because it is the one that means the bike can move",
  funGate({ go: 1, speedKmh: null, throttlePercent: null }) === FUN_GATE.GO_SET
);
check(
  "and only READY lets the throttle through",
  Object.values(FUN_GATE).every(code => funGateAllows(code) === (code === FUN_GATE.READY))
);

// --- 4. The codes, the words and the bounds -----------------------------------

console.log("\n4. every gate code has a bound, a refusal and a sentence");

const gateBounds = boundsFor("fan_fun_gate", "", "fan");
const availableBounds = boundsFor("fan_fun_available", "", "fan");
const modeBounds = boundsFor("fan_auto_mode", "", "fan");
check("fan_fun_gate is bounded at all", gateBounds !== null);
check(
  "fan_fun_available is bounded at all — blank unit in a non-boolean group falls through every rule",
  availableBounds !== null
);
for (const [name, code] of Object.entries(FUN_GATE)) {
  check(
    `FUN_GATE.${name} = ${code} is inside its bound, has a refusal and has words`,
    gateBounds !== null &&
      code >= gateBounds[0] &&
      code <= gateBounds[1] &&
      typeof FUN_GATE_REFUSAL[code] === "string" &&
      FUN_GATE_REFUSAL[code].length > 0 &&
      typeof FUN_GATE_TEXT[code] === "string" &&
      FUN_GATE_TEXT[code].length > 0
  );
}
check(
  "no sentence is left over from a gate code that has been removed",
  Object.keys(FUN_GATE_TEXT).every(code => Object.values(FUN_GATE).includes(Number(code) as never))
);

// ⚠️ The bound is what would have hidden fun mode entirely: at [0, 1] the mode signal's
// new code 2 is rejected as a sentinel, public/lib/store.js keeps the PREVIOUS value, and
// the sheet says "Manual" over a fan taking its orders from a throttle.
check(
  `fan_auto_mode's bound reaches the fun code (${modeBounds?.[1]})`,
  modeBounds !== null && modeBounds[1] >= FAN_MODE_CODE.fun
);
check(
  "⚠️  the dashboard's copy of FAN_MODE_CODE is the server's, code for code",
  PAGE_MODE_CODE.MANUAL === FAN_MODE_CODE.manual &&
    PAGE_MODE_CODE.AUTOMATIC === FAN_MODE_CODE.automatic &&
    PAGE_MODE_CODE.FUN === FAN_MODE_CODE.fun
);
check(
  "…and the three codes are distinct, so no mode reads as another",
  new Set(Object.values(FAN_MODE_CODE)).size === 3
);

// The shipped windows, pinned as literals — nothing below overrides them, so a value
// changed here would otherwise only show up as a slower check.
check("the gate calls a signal stale after 500 ms — 50 missed frames at 100 Hz", FUN_GATE_MAX_AGE_MS === 500);
check("and the watchdog re-checks it every 250 ms", FUN_WATCHDOG_MS === 250);

// --- 5. The slider's stops at the finer grid ----------------------------------

console.log("\n5. the slider offers every whole percent the Pi will take");

const stops = dutyStops(MIN_RUNNING_DUTY_PERCENT, MAX_DUTY_PERCENT);
check(`the step is 1 % (${DUTY_STEP_PERCENT})`, DUTY_STEP_PERCENT === 1);
check(`stop, then every percent from 30 to 100 — 72 positions (${stops.length})`, stops.length === 72);
check(
  "no stop lies between 0 and the floor",
  stops.every(duty => duty === 0 || duty >= MIN_RUNNING_DUTY_PERCENT)
);
check(
  "the stops still ascend and never repeat",
  stops.every((duty, index) => index === 0 || duty > stops[index - 1])
);

// --- 6. End to end: the gate, the throttle and the bridge ---------------------
//
// The recording fake scripts/check-fan-ordering.ts and scripts/check-fan-curve.ts use,
// driven by a fake bus rather than by a curve.

console.log("\n6. the loop, end to end, against a recording bridge");

defineSignals(SIGNALS);

// ⚠️ FIRST, because everything below depends on it. src/can/signals.ts held ONE change
// listener that each onChange() call replaced, and src/fan/auto.ts is the second
// subscriber after src/ws.ts. With one slot, whichever registered last silently switched
// the other off: either a dashboard that never updates again, or a fun mode that never
// sees the throttle. Neither is visible from inside the other's tests, so it is pinned
// here rather than left to the end-to-end section to imply.
const heard: string[] = [];
const dropFirst = onChange(() => heard.push("first"));
const dropSecond = onChange(() => heard.push("second"));
record("fan_fun_gate", 4);
await new Promise(resolve => setTimeout(resolve, 5));
check("⚠️  two subscribers to onChange() BOTH hear a change — one does not replace the other", heard.length === 2);
dropSecond();
heard.length = 0;
record("fan_fun_gate", 5);
await new Promise(resolve => setTimeout(resolve, 5));
check("…and unsubscribing drops exactly the one that unsubscribed", heard.length === 1 && heard[0] === "first");
dropFirst();

// ⚠️ …AND ONE OF THE TWO MUST NOT BE ABLE TO STARVE THE OTHER. Widening the slot to a list
// is what created this: with one subscriber a throw was a self-inflicted wound, with two
// it is src/ws.ts and src/fan/auto.ts able to take each other down. The loop runs inside a
// queueMicrotask callback, so an escaped throw is an uncaughtException with no handler
// registered anywhere in src/index.ts — the process ends, and the CAN logging and the
// WebSocket go with it. Listened for rather than left to Node for the reason
// scripts/check-fan-curve.ts §11 gives: a dead process reads as "the check crashed"
// rather than as the named assertion below going red.
let uncaught: unknown = null;
const noteUncaught = (error: unknown): void => {
  uncaught = error;
};
process.on("uncaughtException", noteUncaught);
const survived: string[] = [];
const dropThrower = onChange(() => {
  throw new Error("a change listener that throws");
});
const dropSurvivor = onChange(() => survived.push("survivor"));
record("fan_fun_gate", 3);
await new Promise(resolve => setTimeout(resolve, 5));
process.off("uncaughtException", noteUncaught);
dropThrower();
dropSurvivor();
check("⚠️  a change listener that throws does not end the process", uncaught === null);
check("…and the subscriber after it still gets the batch", survived.length === 1);

interface PwmCall {
  method: "duty" | "output" | "bridge";
  value: number | boolean;
}

const calls: PwmCall[] = [];
const recording: FanPwm = {
  channelPath: "/sys/class/pwm/pwmchipFAKE/pwm0",
  setDutyPercent: async percent => {
    calls.push({ method: "duty", value: percent });
  },
  setOutputEnabled: async on => {
    calls.push({ method: "output", value: on });
  },
  setBridgeEnabled: async on => {
    calls.push({ method: "bridge", value: on });
  },
};

const TICK_MS = 20;
const STALE_MS = 400;

// A bus that behaves like the real one: 0x102, 0x104 and 0x109 at 50 Hz here rather than
// 100, which is still eight refreshes inside the shipped 500 ms window. Recording the
// same value twice raises no change event and refreshes the age anyway, exactly as
// src/can/signals.ts does on the bike.
const bus = { go: 0, speedKmh: 0, throttlePercent: 0 };
const busTimer = setInterval(() => {
  record("go", bus.go);
  record("speed_can_kmh", bus.speedKmh);
  record("throttle_pct", bus.throttlePercent);
  record("batt_temp_hi", 20);
}, TICK_MS);

async function settle(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

/** The parked bus, restartable, and with the throttle leg switchable on its own. */
function startParkedBus(): ReturnType<typeof setInterval> {
  return setInterval(() => {
    record("go", bus.go);
    record("speed_can_kmh", bus.speedKmh);
    if (throttleOnBus) {
      record("throttle_pct", bus.throttlePercent);
    }
  }, TICK_MS);
}

const controller = await startFanControl({ enabled: true, openPwm: async () => recording });
const automatic = startFanAutomatic(controller, {
  tickMs: TICK_MS,
  speedMaxAgeMs: STALE_MS,
  chargeSessionMaxAgeMs: STALE_MS,
});

check("a fresh loop starts in automatic, whatever the bike is doing", automatic.mode() === "automatic");

// The bike in Go, which is the case the whole gate exists for.
bus.go = 1;
await settle(TICK_MS * 4);
const refusedInGo = await automatic.setMode("fun");
check(
  `⚠️  fun mode is REFUSED while the bike is in Go (${refusedInGo.message})`,
  !refusedInGo.ok && automatic.mode() !== "fun"
);
check(
  "…and nothing was commanded on the way to refusing",
  !calls.some(call => call.method === "bridge" && call.value === true)
);
check(
  "the page is told not to offer it",
  latestValue("fan_fun_available") === 0 && latestValue("fan_fun_gate") === FUN_GATE.GO_SET
);

// A bus that has stopped talking. ⚠️ Waited out at the SHIPPED 500 ms rather than at an
// injected window, because a fun-mode staleness seam is exactly the coverage hole #125
// and #128 opened twice.
clearInterval(busTimer);
await settle(FUN_GATE_MAX_AGE_MS + TICK_MS * 4);
const refusedStale = await automatic.setMode("fun");
check(
  `⚠️  fun mode is REFUSED on a stale \`go\`, never granted on the last one seen (${refusedStale.message})`,
  !refusedStale.ok && automatic.mode() !== "fun"
);
check("and the reason says so rather than blaming the bike", latestValue("fan_fun_gate") === FUN_GATE.GO_UNKNOWN);

// The bike parked, which is what the mode is for.
//
// ⚠️ `throttleOnBus` exists so ONE of the three gate signals can be taken off the bus
// while the other two keep arriving, and the whole bus can be stopped and started again.
// Both are what the wiring assertions further down need: a gate leg that goes stale on
// its own, and a bus that goes silent with nothing else changing.
bus.go = 0;
bus.throttlePercent = 0;
let throttleOnBus = true;
let parkedBus = startParkedBus();
await settle(TICK_MS * 4);
check("with the bike parked the page is told to offer it", latestValue("fan_fun_available") === 1);

calls.length = 0;
const entered = await automatic.setMode("fun");
check(`the throttle takes the fan (${entered.message})`, entered.ok && automatic.mode() === "fun");
check("and the mode reaches the dashboard as code 2", latestValue("fan_auto_mode") === FAN_MODE_CODE.fun);
check(
  "⚠️  entering from rest kick-starts like every other start — duty, then output, then the enables",
  calls[0]?.method === "duty" &&
    calls[0]?.value === 100 &&
    calls[1]?.method === "output" &&
    calls[1]?.value === true &&
    calls[2]?.method === "bridge" &&
    calls[2]?.value === true
);
check(
  "a closed throttle is holding the fan at the floor, not stopping it",
  controller.state().targetPercent === MIN_RUNNING_DUTY_PERCENT
);

// ⚠️ A throttle moved DURING the kick moves the target only. The kick has to run its full
// length or it is not a kick, so src/fan/control.ts leaves the applied duty at 100 % and
// lands on whatever the target is by the time it ends — which is why the sweep below
// waits it out rather than measuring the bridge through it.
bus.throttlePercent = 40;
record("throttle_pct", 40);
await settle(60);
check(
  "a throttle moved mid-kick moves the target and NOT the applied duty",
  controller.state().targetPercent === funDutyPercent(40) && controller.state().dutyPercent === 100
);

await settle(KICK_START_MS + 250);
check(
  "…and the kick ends on whatever the throttle is holding by then",
  controller.state().dutyPercent === funDutyPercent(40)
);

// The throttle sweeping. Each write is a distinct value, so each raises a change event
// the way the bus does.
calls.length = 0;
for (const percent of [4.2, 17.9, 51.5, 88.8]) {
  bus.throttlePercent = percent;
  record("throttle_pct", percent);
  await settle(30);
}
check(
  `a throttle sweep moves the duty at once, without waiting for a tick (${controller.state().targetPercent} %)`,
  controller.state().targetPercent === funDutyPercent(88.8)
);
check(
  "⚠️  and the duty is fractional, so the throttle's own resolution survives to the bridge",
  !Number.isInteger(controller.state().targetPercent)
);
check(
  "⚠️  no enable was touched by any of it — the bridge is set once on entry, not per movement",
  !calls.some(call => call.method === "bridge")
);
check(
  `the whole sweep is duty writes and nothing else (${calls.length} of them)`,
  calls.length >= 4 && calls.every(call => call.method === "duty")
);
check(
  "…and the applied duty follows the target rather than lagging a tick behind it",
  controller.state().dutyPercent === controller.state().targetPercent
);

// ⚠️ THE DROP-OUT. `go` going true has to take the fan off the throttle AT ONCE, and the
// 250 ms watchdog must not be what does it: this waits a fifth of that. Delete the change
// subscription in src/fan/auto.ts and the mode is still "fun" when this runs.
//
// The pack is put at 45 °C first so the curve has something to say when it gets the fan
// back: a rider leaving a charger has a warm pack, and it is also what lets the re-entry
// below start from a running fan rather than from another kick-start.
record("batt_temp_hi", 45);
bus.go = 1;
record("go", 1);
await settle(50);
check(
  "⚠️  `go` going true drops fun mode IMMEDIATELY — inside 50 ms, a fifth of the watchdog",
  automatic.mode() === "automatic"
);
check(
  "…and the fan is back on the temperature curve rather than on a duty a wrist left behind",
  latestValue("fan_auto_mode") === FAN_MODE_CODE.automatic
);
check("the page stops offering it in the same breath", latestValue("fan_fun_available") === 0);

check(
  "…and the curve really did take over rather than the fan simply being left where it was",
  controller.state().driverEnabled && controller.state().targetPercent === 84
);

// ⚠️ AND ONCE IT IS HANDED BACK THE THROTTLE IS INERT, even with the bike parked again and
// the gate reopened. Fun mode is a mode, not a standing subscription: src/fan/fun-runner
// .ts's listener checks the mode before it does anything, and the subscription itself is
// held for the whole life of the loop precisely so no path out of the mode can forget to
// drop it. Delete that check and a wrist moves the fan while the curve believes it owns it.
bus.go = 0;
await settle(TICK_MS * 4);
check("the gate reopens with the bike parked again", latestValue("fan_fun_available") === 1);
// Asserted on the BRIDGE WRITES rather than on the duty that survives: without the mode
// check the throttle's duty is commanded and the very next curve tick takes it back, so a
// reading taken a moment later shows 84 % either way. What differs is that a write happened
// at all — and on the bike it happens at ~100 Hz for as long as a wrist keeps moving.
calls.length = 0;
bus.throttlePercent = 5.5;
record("throttle_pct", bus.throttlePercent);
await settle(60);
check(
  `⚠️  …but the throttle does not touch the fan outside fun mode — the curve still owns it (${calls.length} writes)`,
  calls.length === 0 && automatic.mode() === "automatic" && controller.state().targetPercent === 84
);

// Re-entering, so the tests below start from fun mode rather than from the curve.
bus.throttlePercent = 88.8;
record("throttle_pct", bus.throttlePercent);
const reentered = await automatic.setMode("fun");
check("it can be entered again once the bike is parked again", reentered.ok && automatic.mode() === "fun");

// ⚠️ THE GATE'S SECOND WITNESS, ON THE WIRE. §3 proves funGate() refuses a moving bike.
// It does NOT prove refreshGate() hands it the bike's actual speed — replace that argument
// with a hard-coded `speedKmh: 0` in src/fan/fun-runner.ts and every assertion in §3 still
// passes. The whole of "an independently-framed second witness, so one stalled frame
// cannot manufacture a pass" rests on these two lines and on nothing else in the file.
bus.speedKmh = 3;
record("speed_can_kmh", 3);
await settle(60);
check(
  "⚠️  a bike that STARTS MOVING drops fun mode — the second witness is read off the bus, not assumed",
  automatic.mode() === "automatic"
);
check("…and the gate names the speed as what ended it", latestValue("fan_fun_gate") === FUN_GATE.MOVING);

// The same witness UNDER THE LOG'S OWN DEADBAND. `speed_can_kmh` carries `deadband: 0.5`
// in src/can/registry.ts, so a bike being pushed at 0.4 km/h changes the live value and
// raises no change event at all — src/can/signals.ts notifies only on a reading that moved
// far enough to log. The gate has no tolerance band, and this is the case where the
// watchdog beat rather than an event is what applies it.
bus.speedKmh = 0;
record("speed_can_kmh", 0);
await settle(TICK_MS * 4);
const forRolling = await automatic.setMode("fun");
check("fun mode is available again once the bike is stopped", forRolling.ok && automatic.mode() === "fun");
bus.speedKmh = 0.4;
record("speed_can_kmh", 0.4);
await settle(FUN_WATCHDOG_MS * 2);
check(
  "⚠️  a bike ROLLED BY HAND at 0.4 km/h — under the signal's own 0.5 km/h deadband — drops it too",
  automatic.mode() === "automatic"
);
check(
  "…and it is reported as MOVING rather than as a signal nobody could read",
  latestValue("fan_fun_gate") === FUN_GATE.MOVING
);

// ⚠️ THE THROTTLE LEG, ON THE WIRE — the same hole in the same shape. Hard-code
// `throttlePercent: 1` in refreshGate() and THROTTLE_UNKNOWN becomes unreachable with §3
// none the wiser. `go` and the speed keep arriving throughout, so the throttle is the only
// thing that goes stale; and because neither of the other two is CHANGING, no event fires
// either, so the watchdog beat is what notices.
bus.speedKmh = 0;
record("speed_can_kmh", 0);
await settle(TICK_MS * 4);
const forThrottle = await automatic.setMode("fun");
check("fun mode is entered again for the throttle leg", forThrottle.ok && automatic.mode() === "fun");
throttleOnBus = false;
await settle(FUN_GATE_MAX_AGE_MS + FUN_WATCHDOG_MS * 2);
check(
  "⚠️  a throttle that goes stale under a live `go` and a live speed drops fun mode",
  automatic.mode() === "automatic"
);
check("…and the gate blames the THROTTLE, not the bike", latestValue("fan_fun_gate") === FUN_GATE.THROTTLE_UNKNOWN);
throttleOnBus = true;

// ⚠️ THE WATCHDOG BEAT ITSELF, which until now had only the literal in §4 behind it.
// Delete the `context.mode === "fun"` branch from evaluate() in src/fan/auto.ts and every
// other assertion in this file stays green — while on the bike a bus that drops mid-session
// leaves the mode "fun" for ever, the fan on whatever duty a wrist last asked for, and
// `fan_fun_gate` publishing GO_UNKNOWN beside it, because refreshGate() above the mode
// check still runs. Nothing else can end this session: a SILENT bus raises no event, which
// is the whole reason the beat exists. Waited out at the shipped constants, ~750 ms.
await settle(TICK_MS * 4);
const forWatchdog = await automatic.setMode("fun");
check("fun mode is entered again for the watchdog", forWatchdog.ok && automatic.mode() === "fun");
clearInterval(parkedBus);
await settle(FUN_GATE_MAX_AGE_MS + FUN_WATCHDOG_MS * 2);
check(
  "⚠️  a bus that goes SILENT ends the session — silence raises no event, so the beat is what ends it",
  automatic.mode() === "automatic"
);
check("…and it hands the fan to the CURVE, never to manual", latestValue("fan_auto_mode") === FAN_MODE_CODE.automatic);
check("…and the page is told to stop offering it", latestValue("fan_fun_available") === 0);

// Back in fun mode for the two tests below, which need it running.
parkedBus = startParkedBus();
await settle(TICK_MS * 4);
const backInFun = await automatic.setMode("fun");
check("and once the bus comes back it can be entered again", backInFun.ok && automatic.mode() === "fun");

// ⚠️ A STOPPED LOOP IS DEAF. index.ts's shutdown calls automatic.stop() and only then
// idles the controller, so a change subscription that outlived stop() would re-command a
// fan whose bridge has just been torn down — the same failure the timer's own "a stopped
// loop stops ticking" assertion covers in scripts/check-fan-curve.ts. The fan is past its
// kick-start here on purpose: mid-kick a throttle move writes nothing anyway, which would
// make this pass for the wrong reason.
automatic.stop();
calls.length = 0;
bus.throttlePercent = 12.7;
record("throttle_pct", 12.7);
await settle(60);
check(`⚠️  a stopped loop ignores the throttle entirely (${calls.length} bridge calls)`, calls.length === 0);

// ⚠️ Leaving stops the fan the way everything else does: enables LOW FIRST, then the
// output, then the duty. The mirror rule — dropping the duty under live enables is the
// electrical brake docs/fan-control.md §3 is about.
calls.length = 0;
const stopped = await automatic.commandManualDuty(0);
const bridgeAt = calls.findIndex(call => call.method === "bridge" && call.value === false);
const outputAt = calls.findIndex(call => call.method === "output" && call.value === false);
check(`the slider takes it back and stops the fan (${stopped.message})`, stopped.ok && automatic.mode() === "manual");
check(
  "⚠️  and the stop drops the ENABLES before the output — never a duty of 0 under a live bridge",
  bridgeAt >= 0 && outputAt > bridgeAt && !controller.state().driverEnabled
);

// ⚠️ THE BEAT'S INTERVAL, not merely that a beat exists. enterFun() re-arms the timer at
// FUN_WATCHDOG_MS; leave it on the curve's own tickMs and everything above stays green,
// because this loop ticks at 20 ms and a mutant beating FASTER than 250 ms ends a session
// sooner rather than later. Only a loop SLOWER than the watchdog can tell them apart, so
// this one ticks at 3 s: on the bike that is AUTO_TICK_MS = 2 s, and a silent bus would
// hold the fan on a wrist's last duty for up to 2.5 s instead of 0.75 s.
const slowLoop = startFanAutomatic(controller, { tickMs: 3_000 });
const slowEntered = await slowLoop.setMode("fun");
check(
  `a loop whose own tick is slower than the watchdog still enters fun mode (3000 ms tick, ${FUN_WATCHDOG_MS} ms beat)`,
  slowEntered.ok && slowLoop.mode() === "fun"
);
clearInterval(parkedBus);
await settle(FUN_GATE_MAX_AGE_MS + FUN_WATCHDOG_MS * 2);
check(
  "⚠️  …and a bus that goes silent ends it on the WATCHDOG's 250 ms, not on the loop's own 3 s tick",
  slowLoop.mode() === "automatic"
);
slowLoop.stop();

// --- 7. A pass that throws, and a write that never settles --------------------
//
// ⚠️ Fun mode has TWO entry points that the timer path does not, and neither of them has
// anything above it to catch a rejection: the change listener DISCARDS its promise at
// ~100 Hz, and enterFun's travels out through switchMode → setMode → src/http/fan.ts into
// src/index.ts's `createServer(async …)`, which Node does not await either. An escaped
// rejection on either ends the service. The argument is scripts/check-fan-curve.ts §11's,
// word for word: nothing on today's paths rejects, but that is a property of src/fan/
// control.ts rather than of these two files.
//
// The hang is the other half. `funCommandInFlight` keeps ~100 Hz of throttle events from
// queueing writes without bound, and a setDutyPercent() that HANGS rather than rejects
// would — with that flag checked before the gate is read — wedge every route out of the
// session, the 250 ms watchdog included.

console.log("\n7. a fun-mode pass that throws, and a bridge write that never settles");

const brokenState: FanState = { dutyPercent: 0, targetPercent: 0, driverEnabled: false, phase: "idle" };
let brokenAttempts = 0;
let brokenFailures = 0;
let throwNext = false;
const throwingController: FanController = {
  configured: true,
  fault: null,
  setDutyPercent: async percent => {
    brokenAttempts += 1;
    if (throwNext) {
      brokenFailures += 1;
      throw new Error("pinctrl vanished mid-throttle-sweep");
    }
    brokenState.targetPercent = percent;
    brokenState.dutyPercent = percent;
    brokenState.driverEnabled = percent > 0;
    brokenState.phase = percent > 0 ? "running" : "idle";
    return { ok: true, message: `commanded ${percent} %` };
  },
  state: () => brokenState,
  stop: async () => {},
};

// A bus that holds the gate open for the whole section. `go` and the throttle come from
// variables rather than literals, so a change made below is not undone 20 ms later.
let funThrottle = 12;
let funGoBit = 0;
const funBus = setInterval(() => {
  record("go", funGoBit);
  record("speed_can_kmh", 0);
  record("throttle_pct", funThrottle);
  record("batt_temp_hi", 45);
}, TICK_MS);

const throwingLoop = startFanAutomatic(throwingController, {
  tickMs: TICK_MS,
  speedMaxAgeMs: STALE_MS,
  chargeSessionMaxAgeMs: STALE_MS,
});
await settle(TICK_MS * 4);

// ⚠️ THE JOURNAL IS THE OTHER HALF OF THE GUARD, and this path is not runTick. That one
// warns off a 2 s tick; this one is driven by `throttle_pct` events at ~100 Hz, so a bridge
// that starts refusing would write a hundred lines a second onto a Pi that is also writing
// a ride log, and the message you went looking for is the one that scrolled past. Captured
// from here to the end of the throwing section so both halves are asserted: the FIRST
// failure is still named and still loud, and a burst is still ONE line rather than one each.
const funWarnings: string[] = [];
const realWarn = console.warn;
console.warn = (...args: any[]): void => {
  const line = args.map(part => (part instanceof Error ? part.message : String(part))).join(" ");
  if (line.startsWith("fan: a fun-mode pass failed")) {
    funWarnings.push(line);
    return;
  }
  realWarn(...args);
};

// The ENTRY path. Caught here rather than left to reject, because an escaped rejection at
// a top-level await reads as "the check crashed" rather than as a named assertion.
let entryError: unknown = null;
let enteredBroken: FanCommandResult | null = null;
throwNext = true;
try {
  enteredBroken = await throwingLoop.setMode("fun");
} catch (error) {
  entryError = error;
}
throwNext = false;
check(
  "⚠️  entering fun mode against a throwing bridge REPLIES rather than rejecting into the request listener",
  entryError === null && enteredBroken !== null
);
check(
  "…and the reply is a refusal that names the call that failed",
  enteredBroken?.ok === false && (enteredBroken?.message ?? "").includes("pinctrl vanished")
);
check("…and the mode the gate granted is kept, so the next pass retries", throwingLoop.mode() === "fun");
check(
  `…and the very first failure is in the journal at once, naming the call (${funWarnings.length} line)`,
  funWarnings.length === 1 && funWarnings[0].includes("pinctrl vanished")
);

// The EVENT path, which is the one that runs at ~100 Hz with its promise discarded.
let escaped: unknown = null;
const noteRejection = (reason: unknown): void => {
  escaped = reason;
};
process.on("unhandledRejection", noteRejection);
throwNext = true;
funThrottle = 33.3;
record("throttle_pct", funThrottle);
await settle(80);
throwNext = false;
check("⚠️  a throttle event whose duty THROWS does not escape as an unhandled rejection", escaped === null);

funThrottle = 44.4;
record("throttle_pct", funThrottle);
await settle(120);
process.off("unhandledRejection", noteRejection);
check(
  `…and the session is still driving the fan afterwards (${brokenAttempts} writes, ${brokenFailures} of them thrown)`,
  brokenFailures >= 2 && brokenState.targetPercent === funDutyPercent(44.4)
);

// A wrist sweeping the throttle while the bridge is refusing — the flood this rate limit
// exists for. Forty distinct readings, so forty change events and forty failed passes,
// inside a fraction of the interval.
const warningsBeforeBurst = funWarnings.length;
const failuresBeforeBurst = brokenFailures;
throwNext = true;
for (let step = 0; step < 40; step += 1) {
  funThrottle = 20 + step * 0.7;
  record("throttle_pct", funThrottle);
  await settle(1);
}
throwNext = false;
const burstFailures = brokenFailures - failuresBeforeBurst;
const burstWarnings = funWarnings.length - warningsBeforeBurst;
check(
  `⚠️  ${burstFailures} failing passes inside one interval write ${burstWarnings} journal line(s), not one each`,
  burstFailures >= 20 && burstWarnings <= 1
);
check(
  "…and coalesced rather than dropped — every line says how many failures it stands for",
  funWarnings.length > 0 && funWarnings.every(line => /\(\d+ since the last line\)/.test(line))
);
console.warn = realWarn;
throwingLoop.stop();

// The HANG. ⚠️ A write that never settles used to wedge the session: `funCommandInFlight`
// stayed true for ever and every gate re-check returned at driveFun's first line — the
// throttle events and the watchdog beat alike, since the beat is also just driveFun. The
// gate is therefore read INSIDE the in-flight branch, below the early return's own
// condition, because handing the fan back does not need the bridge to be free. Delete that
// read and these two go red (2 ✗).
//
// ⚠️ HOISTING IT ABOVE THE IN-FLIGHT CHECK INSTEAD — the tidy-up this looks like it wants
// — is measured at 0 ✗ here, and it costs the file its best mutation: one read covering
// the whole pass makes the in-loop re-check invisible, taking that deletion from 12 ✗ to
// 0. One read per command is the shape, and docs/fan-control.md §"Dropping out is
// immediate, not at the next tick" is the argument for it.
const hangingState: FanState = { dutyPercent: 0, targetPercent: 0, driverEnabled: false, phase: "idle" };
let hangingWrites = 0;
let hangNext = false;
let releaseHang: (() => void) | undefined;
const hangingController: FanController = {
  configured: true,
  fault: null,
  setDutyPercent: async percent => {
    if (hangNext) {
      hangNext = false;
      hangingWrites += 1;
      await new Promise<void>(resolve => {
        releaseHang = resolve;
      });
      hangingWrites -= 1;
    }
    hangingState.targetPercent = percent;
    hangingState.dutyPercent = percent;
    hangingState.driverEnabled = percent > 0;
    hangingState.phase = percent > 0 ? "running" : "idle";
    return { ok: true, message: `commanded ${percent} %` };
  },
  state: () => hangingState,
  stop: async () => {},
};

const hangingLoop = startFanAutomatic(hangingController, {
  tickMs: TICK_MS,
  speedMaxAgeMs: STALE_MS,
  chargeSessionMaxAgeMs: STALE_MS,
});
await settle(TICK_MS * 4);
// Not awaited: the entry's own write is the one that hangs, so setMode() never settles.
// enterFun adopts the mode synchronously before it, which is what makes this observable.
hangNext = true;
void hangingLoop.setMode("fun");
await settle(TICK_MS * 4);
check("fun mode is entered with a bridge write still in the air", hangingLoop.mode() === "fun" && hangingWrites === 1);

funGoBit = 1;
record("go", funGoBit);
await settle(FUN_WATCHDOG_MS * 2);
check(
  "⚠️  a write that NEVER SETTLES does not wedge the session — `go` still takes the fan back",
  hangingLoop.mode() === "automatic"
);
// ⚠️ NOT asserted on `fan_fun_gate`, and not on the duty either. refreshGate() runs in
// evaluate() ABOVE the mode check, so a wedged session publishes GO_SET to the dashboard
// perfectly well while the fan goes on taking orders from a throttle; and the curve was
// already holding 84 % before the session started, so the duty is unchanged either way.
// `fan_auto_mode` is the one of the three that moves only when the mode really does.
check(
  "…and the dashboard is told the fan is back on the curve",
  latestValue("fan_auto_mode") === FAN_MODE_CODE.automatic
);
releaseHang?.();
hangingLoop.stop();
clearInterval(funBus);

// --- 8. It does not survive a restart -----------------------------------------
//
// ⚠️ In memory only, like manual, and for a stronger reason: a mode that put the throttle
// on the fan and came back after a reboot would be waiting for a rider who did not ask
// for it. Persist it and this goes red.

console.log("\n8. fun mode does not survive a restart");

const restarted = startFanAutomatic(controller, { tickMs: TICK_MS });
check("a loop started after a fun-mode session is in AUTOMATIC", restarted.mode() === "automatic");
check("…and reports no fun-mode state carried over", restarted.state().mode === "automatic");
restarted.stop();
await controller.stop();

console.log("");
if (failures > 0) {
  console.error(`FAILED — ${failures} assertion${failures === 1 ? "" : "s"}`);
  process.exitCode = 1;
} else {
  console.log("✓ the gate refuses a bike in Go and a bike whose bus has gone quiet, all three of its legs are");
  console.log("  wired to the bus and not to constants, `go` going true takes the throttle off the fan inside");
  console.log("  50 ms, a silent bus ends the session on the watchdog beat, a throw on either of fun mode's two");
  console.log("  promise paths is logged rather than fatal, and every one of the throttle's 1000 steps reaches");
  console.log("  the bridge as a different duty");
}
