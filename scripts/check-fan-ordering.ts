import { redirectsServed } from "./fan-io-fence.ts";
import { callCount, pinIndex, sequenceFrom, writeIndex } from "./simulated-pwm-log.ts";
import {
  clearPinFailures,
  coldPi,
  failPinWrite,
  holdPinWrite,
  installSimulatedSysfs,
  resetSimulatedSysfs,
  simulatedSysfs,
} from "./simulated-pwm-sysfs.ts";

// The order the cooling-fan bridge is brought up and taken down in, checked with no Pi.
//
//   node --experimental-strip-types scripts/check-fan-ordering.ts
//
// docs/fan-control.md §3 calls these orderings "the whole safety property of
// src/fan/control.ts", and until this file existed nothing enforced them: swapping two
// awaits in beginKickStart() left every check green, the service starting normally and
// the fault invisible on the bike, because THIS FAN HAS NO TACHO and no current sense.
//
// ⚠️ WHAT IS BEING PREVENTED IS A MECHANICAL BRAKE, NOT A LOGIC ERROR. Both IBT-2
// enables HIGH while the PWM sits at 0 % leaves both low sides of the BTS7960 on, which
// shorts the motor winding across ground. A shorted brushed DC motor is a generator into
// a dead short; it brakes hard and dumps the energy in its own windings — and this fan
// sits in a radiator duct on a motorcycle that does 270 km/h, so the airstream is what
// drives the rotor into that short.
//
// ⚠️ ASSERTED AS A STATE AFTER EVERY CALL, not as a comparison of call indices. The
// indices this file used until #119 compared FIRST occurrences, so
// `duty=100 → output=true → bridge=true → duty=0 → bridge=true` — which enters the braked
// state and leaves it again — passed all three of them. ./simulated-pwm-sysfs.ts evaluates
// isBraked() after every write and every pin change instead; scripts/check-fan-pwm-bringup
// .ts §1 is where that checker is itself mutation-tested.
//
// ⚠️ The imports of src/fan/ are DYNAMIC because installSimulatedSysfs() must register its
// resolve hook first. The REAL openFanPwm() runs here — nothing passes `openPwm` — so the
// production default in startFanControl() is exercised too.

let failures = 0;

function check(what: string, condition: boolean) {
  if (condition) {
    console.log(`  ✓ ${what}`);
  } else {
    console.error(`  ✗ ${what}`);
    failures += 1;
  }
}

async function settle(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

function timeoutCount(): number {
  return process.getActiveResourcesInfo().filter(resource => resource === "Timeout").length;
}

installSimulatedSysfs();
resetSimulatedSysfs(coldPi());
const { KICK_START_MS, MIN_RUNNING_DUTY_PERCENT, startFanControl } = await import("../src/fan/control.ts");
const { dutyToNanoseconds } = await import("../src/fan/pwm.ts");

// --- 1. Up: the output before the enables ------------------------------------

console.log("\n1. starting from rest");

const starting = await startFanControl({ enabled: true });
check("bring-up reports no fault", starting.fault === null && starting.configured);
check(
  "⚠️  bring-up leaves a bridge in standby: both enables LOW, output off, duty 0",
  !simulatedSysfs().pin17High &&
    !simulatedSysfs().pin27High &&
    !simulatedSysfs().outputEnabled &&
    simulatedSysfs().dutyNs === 0
);

const kickFrom = callCount();
const startOutcome = await starting.setDutyPercent(MIN_RUNNING_DUTY_PERCENT);
check(`commanding ${MIN_RUNNING_DUTY_PERCENT} % is accepted (${startOutcome.message})`, startOutcome.ok);
check(`the command reached the simulator`, callCount() > kickFrom);

const kickDutyAt = writeIndex("duty_cycle", String(dutyToNanoseconds(100)), kickFrom);
const outputUpAt = writeIndex("enable", "1", kickFrom);
const firstEnableAt = pinIndex(17, "dh", kickFrom);
const secondEnableAt = pinIndex(27, "dh", kickFrom);

console.log(`     sequence: ${sequenceFrom(kickFrom)}`);
check("the kick's full duty was written, not the commanded duty", kickDutyAt >= 0);
check("⚠️  the duty was written BEFORE the output was enabled", kickDutyAt >= 0 && kickDutyAt < outputUpAt);
check("⚠️  the output was enabled BEFORE either enable went HIGH", outputUpAt >= 0 && outputUpAt < firstEnableAt);
check("both enables went HIGH", firstEnableAt >= 0 && secondEnableAt > firstEnableAt);
check("⚠️  …so the bridge was never live with the PWM not driving", simulatedSysfs().violations.length === 0);
check(
  `the driver reports itself running at 100 % during the ${KICK_START_MS} ms kick`,
  starting.state().dutyPercent === 100 && starting.state().driverEnabled
);
check(
  "…and the hardware agrees, which is the half state() cannot tell you",
  simulatedSysfs().dutyNs === dutyToNanoseconds(100) && simulatedSysfs().outputEnabled
);

// --- 2. Down: the enables before the output ----------------------------------

console.log("\n2. going back to standby");

const stopFrom = callCount();
const stopOutcome = await starting.setDutyPercent(0);
check(`commanding 0 % is accepted (${stopOutcome.message})`, stopOutcome.ok);

const firstDownAt = pinIndex(17, "dl", stopFrom);
const secondDownAt = pinIndex(27, "dl", stopFrom);
const outputDownAt = writeIndex("enable", "0", stopFrom);
const zeroDutyAt = writeIndex("duty_cycle", "0", stopFrom);

console.log(`     sequence: ${sequenceFrom(stopFrom)}`);
check("the enables were dropped", firstDownAt >= 0 && secondDownAt >= 0);
check("⚠️  BOTH enables were dropped BEFORE the output was", firstDownAt < outputDownAt && secondDownAt < outputDownAt);
check("⚠️  and before the duty was zeroed", secondDownAt >= 0 && secondDownAt < zeroDutyAt);
check("⚠️  so the rotor was never braked on the way down", simulatedSysfs().violations.length === 0);
check("the driver reports standby", !starting.state().driverEnabled && starting.state().dutyPercent === 0);
check("…and so does the hardware", !simulatedSysfs().outputEnabled && simulatedSysfs().dutyNs === 0);

// stop() is the shutdown path and must obey the same order.
const shutdownFrom = callCount();
await starting.stop();
console.log(`     stop() sequence: ${sequenceFrom(shutdownFrom)}`);
check(
  "stop() drops the enables before the output too",
  pinIndex(17, "dl", shutdownFrom) >= 0 && pinIndex(17, "dl", shutdownFrom) < writeIndex("enable", "0", shutdownFrom)
);

// --- 3. When the enables CANNOT be dropped -----------------------------------
//
// ⚠️ The duties asserted here are the KICK's 100 %, so this section is inside the 1500 ms
// window and the phase is asserted alongside them: a machine that stalled past the kick
// would otherwise red on the duty with nothing saying why. Nothing here waits — §4 is the
// section that spends the kick.
//
// ⚠️ TWO failures, not one, and only the second can trip the invariant. A `pinctrl` that
// fails on GPIO27 leaves GPIO17 already LOW — a half-down bridge, which is not a brake
// however wrong the state is. One that fails on GPIO17 throws before 27 is touched, so
// BOTH enables are still HIGH, and that is the case where pressing on and zeroing the duty
// would construct the brake out of the error path.

console.log("\n3. the enables failed to drop");

resetSimulatedSysfs(coldPi());
const stuck = await startFanControl({ enabled: true });
await stuck.setDutyPercent(MIN_RUNNING_DUTY_PERCENT);
check("(setting up) the fan is mid-kick, which is what the 100 % below is", stuck.state().phase === "kick-start");

const secondPinFrom = callCount();
failPinWrite(27, "could not drive GPIO27 dl: pinctrl exited 1");
const refusedSecond = await stuck.setDutyPercent(0);
console.log(`     GPIO27 fails: ${sequenceFrom(secondPinFrom) || "(nothing)"}`);
check("the failure is reported rather than swallowed", !refusedSecond.ok);
check(
  `the message names the bridge (${refusedSecond.message.slice(0, 60)}…)`,
  /IBT-2|enable/i.test(refusedSecond.message)
);
check(
  "⚠️  the PWM output was NOT dropped while an enable was still HIGH",
  writeIndex("enable", "0", secondPinFrom) < 0
);
check("⚠️  and the duty was NOT zeroed", writeIndex("duty_cycle", "0", secondPinFrom) < 0);
// ⚠️ `phase` is "idle" here even though the bridge is not: goIdle() sets it unconditionally
// so the next command re-drives the whole bring-up from a known start. It is
// `driverEnabled` that stays true, and that is what the dashboard renders as a fault.
check(
  "the driver still reports the bridge enabled, so the dashboard renders a fault",
  stuck.state().driverEnabled && stuck.state().dutyPercent === 100
);

// A retry once pinctrl works must still complete the teardown — the refusal is a hold,
// not a latch.
clearPinFailures();
const retryFrom = callCount();
const retried = await stuck.setDutyPercent(0);
console.log(`     retry sequence: ${sequenceFrom(retryFrom)}`);
check(`a retry once pinctrl works completes the stop (${retried.message.slice(0, 50)}…)`, retried.ok);
check(
  "and it still went enables-first",
  pinIndex(17, "dl", retryFrom) >= 0 && pinIndex(17, "dl", retryFrom) < writeIndex("enable", "0", retryFrom)
);
check("the bridge really is in standby afterwards", !simulatedSysfs().pin17High && !simulatedSysfs().pin27High);
await stuck.stop();

// ⚠️ THE DANGEROUS ONE, and it needs its own live bridge: the sub-case above has already
// pulled GPIO17 LOW, so re-using that controller would assert "both enables HIGH" against a
// bridge that is half down and pass for the wrong reason.
resetSimulatedSysfs(coldPi());
const half = await startFanControl({ enabled: true });
await half.setDutyPercent(MIN_RUNNING_DUTY_PERCENT);
check(
  "(setting up) the bridge is live with both enables HIGH",
  simulatedSysfs().pin17High &&
    simulatedSysfs().pin27High &&
    simulatedSysfs().outputEnabled &&
    half.state().phase === "kick-start"
);
const firstPinFrom = callCount();
failPinWrite(17, "could not drive GPIO17 dl: pinctrl exited 1");
const refusedFirst = await half.setDutyPercent(0);
console.log(`     GPIO17 fails: ${sequenceFrom(firstPinFrom) || "(nothing)"}`);
check("a failure on the FIRST enable is reported too", !refusedFirst.ok);
check(
  "⚠️  both enables are still HIGH here — and the PWM was left driving rather than zeroed",
  simulatedSysfs().pin17High && simulatedSysfs().pin27High && simulatedSysfs().outputEnabled
);
check(
  "⚠️  …so no brake was constructed out of the error path, which is what this case is for",
  simulatedSysfs().violations.length === 0
);

clearPinFailures();
await half.stop();
check(
  "and it too can be torn down once pinctrl works again",
  !simulatedSysfs().pin17High && !simulatedSysfs().pin27High
);

// --- 4. Through the kick and out the other side ------------------------------
//
// ⚠️ Waits out the shipped KICK_START_MS rather than injecting a shorter one, the way
// scripts/check-fan-curve.ts §10 does. What is asserted here that nothing else asserts is
// the HARDWARE side of the drop-out, and that a post-kick duty change touches the duty and
// NOTHING ELSE — no enable, no `pinctrl`. A future edit re-enabling the bridge per duty
// change would spawn a process per throttle event and is invisible from state().

console.log("\n4. the kick ends and the duty follows, at the register");

resetSimulatedSysfs(coldPi());
const running = await startFanControl({ enabled: true });
await running.setDutyPercent(50);
await settle(60);
check(
  "a sample 60 ms into a 1500 ms kick still finds the bridge at full duty",
  simulatedSysfs().dutyNs === dutyToNanoseconds(100) && running.state().phase === "kick-start"
);

await settle(KICK_START_MS + 250);
check("the kick ended and the phase is running", running.state().phase === "running");
check(`the driver reports the target (${running.state().dutyPercent} %)`, running.state().dutyPercent === 50);
check(
  "⚠️  …and the REGISTER holds it — state() moving without the write is the mutation this catches",
  simulatedSysfs().dutyNs === dutyToNanoseconds(50)
);
check("the enables stayed HIGH across the drop-out", simulatedSysfs().pin17High && simulatedSysfs().pin27High);
check("and nothing was braked getting there", simulatedSysfs().violations.length === 0);

const movedFrom = callCount();
const moved = await running.setDutyPercent(70);
console.log(`     post-kick move: ${sequenceFrom(movedFrom)}`);
check(`a duty change while running is accepted (${moved.message})`, moved.ok);
check("it reached the register", simulatedSysfs().dutyNs === dutyToNanoseconds(70));
check(
  `⚠️  and it was ONE duty write — no enable, no pinctrl, nothing else (${simulatedSysfs().calls.length - movedFrom})`,
  simulatedSysfs().calls.length - movedFrom === 1 &&
    simulatedSysfs()
      .calls.slice(movedFrom)
      .every(call => call.kind === "write" && call.target.endsWith("/duty_cycle"))
);
await running.stop();

// --- 5. Two commands that would otherwise interleave --------------------------
//
// ⚠️ runExclusively() is not tidiness. Every step of a command is an await on a file write
// or a spawned `pinctrl`, so a stop landing between a kick-start's "output on" and its
// "enables HIGH" switches the fan ON right after being told to stop it — and leaves both
// enables HIGH over a duty the stop has already zeroed, which is the brake. Neither shows
// up anywhere on the bike: this fan has no tacho.

console.log("\n5. a stop that lands inside a kick-start");

resetSimulatedSysfs(coldPi());
const racing = await startFanControl({ enabled: true });
const raceFrom = callCount();
const held = holdPinWrite(17, "dh");
// ⚠️ NOT awaited: with runExclusively the stop is QUEUED behind the held kick, so awaiting
// the kick here would deadlock rather than fail an assertion.
const kicking = racing.setDutyPercent(50);
// ⚠️ AND THE STOP IS NOT ISSUED UNTIL THE KICK HAS REACHED THE GATE. Two sleeps used to
// stand in for this, and a release landing before the write arrived would have made the
// gate a no-op: the commands never overlap, the section passes having raced nothing, and
// the runExclusively mutant survives — the exact shape of the bug 970aa50 fixed elsewhere
// in this file. Raced against a deadline so a gate that is never reached is a RED
// assertion rather than a 120 s "no verdict".
const engaged = await Promise.race([held.engaged.then(() => true), settle(500).then(() => false)]);
// ⚠️ NOT asserted on phase: beginKickStart() sets "kick-start" only AFTER setBridgeEnabled()
// resolves, and that is precisely what is parked — so mid-flight the phase is still "idle".
// The log is what says where we are: the duty and the output are already written.
check(
  "(setting up) the kick is parked mid-flight, with the duty and output up and GPIO17 in the air",
  engaged && writeIndex("enable", "1", raceFrom) >= 0 && pinIndex(17, "dh", raceFrom) >= 0
);
const stopping = racing.setDutyPercent(0);
// Long enough for the UNSERIALISED variant to run its whole teardown, which awaits nothing
// but resolved promises. With runExclusively nothing happens here at all.
await settle(5);
held.release();
await kicking;
await stopping;
console.log(`     sequence: ${sequenceFrom(raceFrom)}`);
check(
  "⚠️  the kick finished before the stop started — the commands did not interleave",
  pinIndex(27, "dh", raceFrom) >= 0 && pinIndex(27, "dh", raceFrom) < pinIndex(17, "dl", raceFrom)
);
check(
  "⚠️  …so the stop never re-raised the enables over a duty it had already zeroed",
  simulatedSysfs().violations.length === 0
);
check(
  "and the fan ends in standby, not half-commanded",
  !simulatedSysfs().pin17High &&
    !simulatedSysfs().pin27High &&
    !simulatedSysfs().outputEnabled &&
    !racing.state().driverEnabled
);
await racing.stop();

// --- 6. The kick timer is not left behind -------------------------------------
//
// ⚠️ A LEAK CHECK, NOT A SAFETY PROPERTY, and it is labelled so nobody reads it as one.
// Removing clearKickTimer() from goIdle() has no behavioural consequence: the stale timer
// fires into finishKickStart(), which returns early on `phase !== "kick-start"`, and where
// a new kick is already running armKickTimer() re-arms on the new mark so the kick still
// ends on time. src/index.ts calls process.exit(0) right after the controller is stopped,
// so it never fires into a torn-down controller either. What is left is a timer that
// outlives the command. docs/fan-control.md §4 records the negative result.
//
// This section owns no timer of its own — no settle() — because a pending one would be
// counted. The simulator resolves on microtasks for the same reason.

console.log("\n6. a stop mid-kick leaves no timer behind");

resetSimulatedSysfs(coldPi());
const timed = await startFanControl({ enabled: true });
const baseline = timeoutCount();
await timed.setDutyPercent(50);
const armed = timeoutCount();
check(`a kick-start arms exactly one timer (${baseline} → ${armed})`, armed === baseline + 1);
await timed.setDutyPercent(0);
const afterStop = timeoutCount();
check(`⚠️  …and the stop disarms it rather than leaving it to fire (${armed} → ${afterStop})`, afterStop === baseline);
await timed.stop();

// --- 7. The redirect really was in force --------------------------------------

console.log("\n7. nothing here went near the real filesystem");

check(
  `both module redirects were served (${redirectsServed().join(", ") || "none"})`,
  redirectsServed().includes("fs/promises") && redirectsServed().includes("child_process")
);

console.log("");
if (failures > 0) {
  console.error(`FAILED — ${failures} assertion${failures === 1 ? "" : "s"}`);
  process.exitCode = 1;
} else {
  console.log("✓ the fan bridge is brought up output-first and taken down enables-first, a failed enable-drop");
  console.log("  leaves the PWM alone rather than braking the rotor, the kick's drop-out reaches the register,");
  console.log("  a stop landing inside a kick-start is queued rather than interleaved, and the braked state");
  console.log("  was never entered at any point in any of it");
}
