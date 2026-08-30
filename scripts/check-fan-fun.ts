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
bus.go = 0;
bus.throttlePercent = 0;
const parkedBus = setInterval(() => {
  record("go", bus.go);
  record("speed_can_kmh", bus.speedKmh);
  record("throttle_pct", bus.throttlePercent);
}, TICK_MS);
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

// Re-entering, so the two tests below start from fun mode rather than from the curve.
bus.go = 0;
await settle(TICK_MS * 4);
const reentered = await automatic.setMode("fun");
check("it can be entered again once the bike is parked again", reentered.ok && automatic.mode() === "fun");

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

clearInterval(parkedBus);

// --- 7. It does not survive a restart -----------------------------------------
//
// ⚠️ In memory only, like manual, and for a stronger reason: a mode that put the throttle
// on the fan and came back after a reboot would be waiting for a rider who did not ask
// for it. Persist it and this goes red.

console.log("\n7. fun mode does not survive a restart");

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
  console.log("✓ the gate refuses a bike in Go and a bike whose bus has gone quiet, `go` going true takes the");
  console.log("  throttle off the fan inside 50 ms, the mapping never leaves the running band, and every one of");
  console.log("  the throttle's 1000 steps reaches the bridge as a different duty");
}
