import { KICK_START_MS, MIN_RUNNING_DUTY_PERCENT, startFanControl } from "../src/fan/control.ts";
import type { FanPwm } from "../src/fan/pwm.ts";

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
// drives the rotor into that short. Hence: output on BEFORE the enables on the way up,
// enables off BEFORE the output on the way down, and — the case that produced this
// check's third section — no dropping the output at all when the enables could not be
// dropped, because doing it anyway CONSTRUCTS the braked state out of the error path.
//
// The fake below records every call in order and can be told to fail one of them. It is
// the whole test rig: src/fan/control.ts takes `openPwm` so this file, and only this
// file, decides what "the hardware" does. Nothing here opens /sys/class/pwm or spawns
// `pinctrl`; on a laptop neither exists.

let failures = 0;

function check(what: string, condition: boolean) {
  if (condition) {
    console.log(`  ✓ ${what}`);
  } else {
    console.error(`  ✗ ${what}`);
    failures += 1;
  }
}

/** One recorded call. The argument is kept because "enabled at 0 %" is about the pair. */
interface PwmCall {
  method: "duty" | "output" | "bridge";
  value: number | boolean;
}

interface RecordingPwm {
  pwm: FanPwm;
  calls: PwmCall[];
  /** Set to make the next setBridgeEnabled(false) throw, as a missing `pinctrl` does. */
  failBridgeOff: boolean;
}

function recordingPwm(): RecordingPwm {
  const calls: PwmCall[] = [];
  const rig: RecordingPwm = {
    calls,
    failBridgeOff: false,
    pwm: {
      channelPath: "/sys/class/pwm/pwmchipFAKE/pwm0",
      setDutyPercent: async percent => {
        calls.push({ method: "duty", value: percent });
      },
      setOutputEnabled: async on => {
        calls.push({ method: "output", value: on });
      },
      setBridgeEnabled: async on => {
        if (!on && rig.failBridgeOff) {
          // The real one: setEnablePins() is a loop with no rollback, so a failure on
          // GPIO27 leaves GPIO17 already driven and throws. execFile can also fail to
          // fork on a 512 MB Zero 2 W under memory pressure, with `pinctrl` present.
          throw new Error("could not drive GPIO27 dl: pinctrl exited 1");
        }
        calls.push({ method: "bridge", value: on });
      },
    },
  };
  return rig;
}

/** The call sequence as a string, so a failed assertion prints what actually happened. */
function sequence(calls: PwmCall[]): string {
  return calls.map(call => `${call.method}=${String(call.value)}`).join(" → ");
}

function indexOfCall(calls: PwmCall[], method: PwmCall["method"], value: number | boolean): number {
  return calls.findIndex(call => call.method === method && call.value === value);
}

// --- 1. Up: the output before the enables ------------------------------------
//
// Asserted as an ORDER between two indices rather than as a literal expected sequence.
// A literal would also go red for a harmless extra write, and this check has to survive
// phase 2 adding a temperature curve above it without becoming the thing people delete.

console.log("\n1. starting from rest");

const startRig = recordingPwm();
const starting = await startFanControl({ enabled: true, openPwm: async () => startRig.pwm });

check("bring-up drives nothing by itself", startRig.calls.length === 0);
check("and reports no fault", starting.fault === null && starting.configured);

const startOutcome = await starting.setDutyPercent(MIN_RUNNING_DUTY_PERCENT);
check(`commanding ${MIN_RUNNING_DUTY_PERCENT} % is accepted (${startOutcome.message})`, startOutcome.ok);

const bridgeUpAt = indexOfCall(startRig.calls, "bridge", true);
const outputUpAt = indexOfCall(startRig.calls, "output", true);
const kickDutyAt = indexOfCall(startRig.calls, "duty", 100);

console.log(`     sequence: ${sequence(startRig.calls)}`);
check("the bridge was enabled", bridgeUpAt >= 0);
check("the PWM output was enabled", outputUpAt >= 0);
check("the kick's full duty was written, not the commanded duty", kickDutyAt >= 0);
check("⚠️  the duty was written BEFORE the output was enabled", kickDutyAt >= 0 && kickDutyAt < outputUpAt);
check("⚠️  the output was enabled BEFORE the enables went HIGH", outputUpAt >= 0 && outputUpAt < bridgeUpAt);
check(
  "so the enables never went HIGH with the duty still at 0",
  bridgeUpAt >= 0 && startRig.calls.slice(0, bridgeUpAt).every(call => call.method !== "duty" || call.value !== 0)
);
check(
  `the driver reports itself running at 100 % during the ${KICK_START_MS} ms kick`,
  starting.state().dutyPercent === 100 && starting.state().driverEnabled
);

// --- 2. Down: the enables before the output ----------------------------------

console.log("\n2. going back to standby");

startRig.calls.length = 0;
const stopOutcome = await starting.setDutyPercent(0);
check(`commanding 0 % is accepted (${stopOutcome.message})`, stopOutcome.ok);

const bridgeDownAt = indexOfCall(startRig.calls, "bridge", false);
const outputDownAt = indexOfCall(startRig.calls, "output", false);
const zeroDutyAt = indexOfCall(startRig.calls, "duty", 0);

console.log(`     sequence: ${sequence(startRig.calls)}`);
check("the enables were dropped", bridgeDownAt >= 0);
check("⚠️  the enables were dropped BEFORE the output was", bridgeDownAt >= 0 && bridgeDownAt < outputDownAt);
check("⚠️  and before the duty was zeroed", bridgeDownAt >= 0 && bridgeDownAt < zeroDutyAt);
check("the driver reports standby", !starting.state().driverEnabled && starting.state().dutyPercent === 0);

// stop() is the shutdown path and must obey the same order. It runs from an idle
// driver here, which is the state src/index.ts's shutdown usually finds.
startRig.calls.length = 0;
await starting.stop();
const stopBridgeAt = indexOfCall(startRig.calls, "bridge", false);
const stopOutputAt = indexOfCall(startRig.calls, "output", false);
console.log(`     stop() sequence: ${sequence(startRig.calls)}`);
check("stop() drops the enables before the output too", stopBridgeAt >= 0 && stopBridgeAt < stopOutputAt);

// --- 3. When the enables CANNOT be dropped -----------------------------------
//
// The failure that made this section exist: goIdle() used to pull "every remaining
// lever" after a failed enable-drop, which with the enables still HIGH means writing
// duty 0 under a live bridge — i.e. building the brake out of the error path. It is the
// MORE likely pinctrl failure of the two, since a missing binary is caught at bring-up
// and this one is not.

console.log("\n3. the enables failed to drop");

const stuckRig = recordingPwm();
const stuck = await startFanControl({ enabled: true, openPwm: async () => stuckRig.pwm });
await stuck.setDutyPercent(MIN_RUNNING_DUTY_PERCENT);

stuckRig.failBridgeOff = true;
stuckRig.calls.length = 0;
const refused = await stuck.setDutyPercent(0);

console.log(`     sequence: ${sequence(stuckRig.calls) || "(nothing was written)"}`);
check("the failure is reported rather than swallowed", !refused.ok);
check(`the message names the bridge (${refused.message})`, /IBT-2|enable/i.test(refused.message));
check(
  "⚠️  the PWM output was NOT dropped while the enables were still HIGH",
  indexOfCall(stuckRig.calls, "output", false) < 0
);
check("⚠️  and the duty was NOT zeroed under a live bridge", indexOfCall(stuckRig.calls, "duty", 0) < 0);
check(
  "the driver still reports the bridge enabled, so the dashboard renders a fault",
  stuck.state().driverEnabled && stuck.state().dutyPercent === 100
);

// A second stop, with `pinctrl` working again, must still complete the teardown —
// the refusal above is a hold, not a latch.
stuckRig.failBridgeOff = false;
stuckRig.calls.length = 0;
const retried = await stuck.setDutyPercent(0);
console.log(`     retry sequence: ${sequence(stuckRig.calls)}`);
check(`a retry once pinctrl works completes the stop (${retried.message})`, retried.ok);
check(
  "and it still went enables-first",
  indexOfCall(stuckRig.calls, "bridge", false) >= 0 &&
    indexOfCall(stuckRig.calls, "bridge", false) < indexOfCall(stuckRig.calls, "output", false)
);

console.log("");
if (failures > 0) {
  console.error(`FAILED — ${failures} assertion${failures === 1 ? "" : "s"}`);
  process.exitCode = 1;
} else {
  console.log("✓ the fan bridge is brought up output-first and taken down enables-first, and a failed");
  console.log("  enable-drop leaves the PWM alone rather than braking the rotor");
}
