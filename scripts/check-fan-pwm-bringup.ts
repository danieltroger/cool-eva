import { promisify } from "util";
import { redirectsServed } from "./fan-io-fence.ts";
import { exportedChipName, pinIndex, sequenceFrom, writeIndex } from "./simulated-pwm-log.ts";
import {
  clearPinFailures,
  coldPi,
  execFile,
  failPinWrite,
  installSimulatedSysfs,
  isBraked,
  resetSimulatedSysfs,
  simulatedSysfs,
  writeFile,
} from "./simulated-pwm-sysfs.ts";

// How src/fan/pwm.ts brings the hardware PWM up, checked with no Pi.
//
//   node --experimental-strip-types scripts/check-fan-pwm-bringup.ts
//
// ⚠️ THE REAL openFanPwm() RUNS HERE. Every other fan check replaces it through
// src/fan/control.ts's `openPwm` seam, which is why issue #119 could report that reverting
// both of this file's write-order fixes left all seventeen assertions green. The sysfs
// tree and `pinctrl` are simulated instead, one layer further down
// (./simulated-pwm-sysfs.ts), so the shipped file runs unmodified.
//
// What that buys, and why the order is not a style point: on rpi-6.6.y a `duty_cycle`
// write against a freshly exported channel — whose `period` reads 0 — is rejected with
// EINVAL, `pwm-bcm2835` defines no `.get_state` so nothing ever refreshes that zero, and
// nothing here unexports, so the failure is PERMANENT rather than first-boot. The fan
// would be inert on every boot behind a service that starts normally, on a fan with no
// tacho. docs/fan-control.md §5 quotes the kernel.
//
// ⚠️ The imports of src/fan/ below are DYNAMIC on purpose: installSimulatedSysfs() has to
// register its resolve hook before the first one, and a static import is resolved before
// any statement in this file runs.

let failures = 0;

function check(what: string, condition: boolean) {
  if (condition) {
    console.log(`  ✓ ${what}`);
  } else {
    console.error(`  ✗ ${what}`);
    failures += 1;
  }
}

// --- 1. The invariant checker itself -----------------------------------------
//
// ⚠️ FIRST, because every section below reports "no braked state was constructed" and an
// invariant checker nobody has ever seen go red would make all of them vacuous. This is
// the one assertion in the file that is about the check rather than about src/fan/.

console.log("\n1. the braked state is recognised as braked");

check(
  "⚠️  both enables HIGH with the PWM output disabled IS the brake",
  isBraked({ pin17High: true, pin27High: true, outputEnabled: false, dutyNs: 50_000 })
);
check(
  "⚠️  …and so is both enables HIGH at a duty of 0",
  isBraked({ pin17High: true, pin27High: true, outputEnabled: true, dutyNs: 0 })
);
check(
  "a driving bridge is not braked",
  !isBraked({ pin17High: true, pin27High: true, outputEnabled: true, dutyNs: 25_000 })
);
check(
  "and ONE enable HIGH at duty 0 is not: that half-bridge is off, so there is no path across the winding",
  !isBraked({ pin17High: true, pin27High: false, outputEnabled: true, dutyNs: 0 }) &&
    !isBraked({ pin17High: false, pin27High: true, outputEnabled: false, dutyNs: 0 })
);

// ⚠️ …AND THE RECORDER AROUND IT, which is a separate thing from the predicate. Testing
// isBraked() alone leaves every `violations.length === 0` below asserting against a counter
// that nothing has ever incremented — switch noteBridge() off and they all stay green.
// So the sequence is driven through the simulator's OWN surface here.
//
// It is deliberately THE SEQUENCE THE OLD CHECK PASSED: duty 100 → output on → enables
// HIGH → duty 0 → still HIGH. Because `indexOfCall` compared FIRST occurrences, all three
// of its ordering assertions were satisfied by it, while the rotor spent the tail of it
// braked. docs/fan-control.md §3.
const CHANNEL = "/sys/class/pwm/pwmchip0/pwm0";
resetSimulatedSysfs(coldPi());
await writeFile("/sys/class/pwm/pwmchip0/export", "0");
await writeFile(`${CHANNEL}/period`, "50000");
await writeFile(`${CHANNEL}/duty_cycle`, "50000");
await writeFile(`${CHANNEL}/enable`, "1");
// ⚠️ Through promisify(execFile), which is the entry src/fan/pwm.ts itself takes — so the
// arming below goes through the same argument validation a real bring-up does.
const runPinctrl = promisify(execFile);
await runPinctrl("pinctrl", ["set", "17", "op", "dh"]);
await runPinctrl("pinctrl", ["set", "27", "op", "dh"]);
check("a bridge driving at full duty records no violation", simulatedSysfs().violations.length === 0);
await writeFile(`${CHANNEL}/duty_cycle`, "0");
check(
  `⚠️  …and dropping the duty UNDER the live enables records one (${simulatedSysfs().violations[0] ?? "none"})`,
  simulatedSysfs().violations.length === 1
);
await writeFile(`${CHANNEL}/duty_cycle`, "50000");
check(
  "⚠️  …which LEAVING the braked state does not undo — the whole reason this is a state and not an index",
  simulatedSysfs().violations.length === 1
);

// --- 2. Which chip -----------------------------------------------------------

console.log("\n2. finding the chip the overlay landed on");

installSimulatedSysfs();
resetSimulatedSysfs(
  coldPi({
    chips: {
      pwmchip0: { channelCount: 1, deviceLink: "../../devices/platform/soc/some-other-block" },
      pwmchip2: { channelCount: 1, deviceLink: "../../devices/platform/soc/3f20c000.pwm" },
    },
  })
);
const { startFanControl } = await import("../src/fan/control.ts");
const { PWM_PERIOD_NS } = await import("../src/fan/pwm.ts");

const preferred = await startFanControl({ enabled: true });
check(
  `the simulated tree was reached at all (${simulatedSysfs().calls.length} calls)`,
  simulatedSysfs().calls.length > 0
);
check("bring-up succeeded", preferred.fault === null && preferred.configured);
check(
  "⚠️  the chip whose device is an SoC .pwm block wins over the LOWER-numbered one",
  exportedChipName() === "pwmchip2"
);
await preferred.stop();

// A tree where nothing names a .pwm block: the lowest-numbered usable chip is taken, and
// it has to SAY so — picking somebody else's PWM silently is the failure being guarded.
const warnings: string[] = [];
const realWarn = console.warn;
console.warn = (...args: any[]): void => {
  warnings.push(args.map(part => String(part)).join(" "));
};
// ⚠️ pwmchip12 and pwmchip2, so the sort has to be NUMERIC: a plain string sort puts
// pwmchip12 first and this picks the wrong chip — which on a kernel that numbered things
// differently means driving somebody else's PWM. pwmchip0's `npwm` cannot be read at all,
// which is the branch that skips a chip rather than failing the whole bring-up.
resetSimulatedSysfs(
  coldPi({
    chips: {
      pwmchip0: { channelCount: null, deviceLink: null },
      pwmchip12: { channelCount: 1, deviceLink: null },
      pwmchip2: { channelCount: 1, deviceLink: null },
    },
  })
);
const guessed = await startFanControl({ enabled: true });
console.warn = realWarn;
check("a tree where no chip names a .pwm block still comes up", guessed.fault === null);
check(
  "⚠️  …on the LOWEST-NUMBERED usable chip, sorted numerically — pwmchip2 before pwmchip12",
  exportedChipName() === "pwmchip2"
);
check(
  `⚠️  …and it WARNS rather than picking silently (${warnings.length} line)`,
  warnings.some(line => line.includes("pwmchip2") && line.includes("lowest-numbered"))
);
check(
  "a chip whose npwm cannot be read is skipped, not fatal",
  warnings.some(line => line.includes("pwmchip0"))
);
await guessed.stop();

// Nothing usable at all: the message has to name the config.txt line, because every
// failure here is a setup step nobody did rather than a hardware fault.
resetSimulatedSysfs(coldPi({ chips: { pwmchip0: { channelCount: 0, deviceLink: null } } }));
const noChip = await startFanControl({ enabled: true });
check("a tree with no usable chip does not come up", noChip.fault !== null);
check(
  `…and the fault names the overlay line to add (${(noChip.fault ?? "").slice(0, 60)}…)`,
  (noChip.fault ?? "").includes("dtoverlay=pwm,pin=18,func=2")
);
check("…and the driver reports itself configured-but-faulted, which is what the phone renders", noChip.configured);

// A kernel with no PWM class at all — no overlay line, or it never applied.
resetSimulatedSysfs(coldPi({ chips: null }));
const noClassDir = await startFanControl({ enabled: true });
check("a kernel with no /sys/class/pwm at all does not come up either", noClassDir.fault !== null);
check(
  "…and that fault names the overlay too, rather than the errno alone",
  (noClassDir.fault ?? "").includes("dtoverlay=pwm,pin=18,func=2") && (noClassDir.fault ?? "").includes("no PWM chip")
);

// --- 3. A cold Pi ------------------------------------------------------------
//
// ⚠️ THE ORDER HERE IS THE WHOLE SECTION. A fresh export reads `period` as 0, and on
// rpi-6.6.y every duty_cycle write against a zero period is EINVAL — including `echo 0`.

console.log("\n3. a cold Pi: period before duty");

resetSimulatedSysfs(coldPi());
const cold = await startFanControl({ enabled: true });
check(`the section reached the simulator (${simulatedSysfs().calls.length} calls)`, simulatedSysfs().calls.length > 0);
check("bring-up succeeded", cold.fault === null);
check(
  "⚠️  the period was written BEFORE the duty — the other order is EINVAL on every boot, for ever",
  writeIndex("period") >= 0 && writeIndex("period") < writeIndex("duty_cycle")
);
check(
  "⚠️  both enables were dropped before ANY of it, because a restart can begin under a live bridge",
  pinIndex(17, "dl") >= 0 && pinIndex(27, "dl") >= 0 && pinIndex(17, "dl") < writeIndex("export")
);
check("the channel was exported", writeIndex("export", "0") >= 0);
check(`the period is the shipped ${PWM_PERIOD_NS} ns`, writeIndex("period", String(PWM_PERIOD_NS)) >= 0);
check("the PWM output was left disabled", writeIndex("enable", "0") >= 0);
check(
  "⚠️  bring-up leaves a bridge in standby that has been asked to do nothing: pins LOW, output off, duty 0",
  !simulatedSysfs().pin17High &&
    !simulatedSysfs().pin27High &&
    !simulatedSysfs().outputEnabled &&
    simulatedSysfs().dutyNs === 0 &&
    simulatedSysfs().periodNs === PWM_PERIOD_NS
);
check("and no braked state was constructed getting there", simulatedSysfs().violations.length === 0);
await cold.stop();

// --- 4. A restart over a live bridge -----------------------------------------
//
// ⚠️ THE CASE THE FIRST STATEMENT OF openFanPwm() EXISTS FOR. A SIGKILL skips the shutdown
// handler and `Restart=on-failure` brings the process back about five seconds later, so
// bring-up begins with both enables HIGH and the channel still driving. Dropping the duty
// first would pass through "enabled at 0 %", which is the brake.

console.log("\n4. a restart that finds the bridge still live");

resetSimulatedSysfs(
  coldPi({ exportedOn: "pwmchip0", periodNs: 50_000, dutyNs: 25_000, outputEnabled: true, bridgeLive: true })
);
const restarted = await startFanControl({ enabled: true });
check(`the section reached the simulator (${simulatedSysfs().calls.length} calls)`, simulatedSysfs().calls.length > 0);
check("bring-up succeeded over an already-exported channel", restarted.fault === null);
check(
  "⚠️  THE ENABLES WENT LOW FIRST, ahead of every read and every write",
  pinIndex(17, "dl") === 0 && pinIndex(27, "dl") === 1
);
check(
  "⚠️  …so no braked state was constructed, which is what this ordering is for",
  simulatedSysfs().violations.length === 0
);
check("the re-export's EBUSY was tolerated rather than fatal", writeIndex("export") >= 0 && restarted.fault === null);
check(
  "the duty was zeroed and the period re-ASSERTED — the write, not the seeded value it matches",
  simulatedSysfs().dutyNs === 0 && writeIndex("period", String(PWM_PERIOD_NS)) >= 0
);
await restarted.stop();

// --- 5. A channel left at a LONGER period -------------------------------------
//
// ⚠️ src/fan/pwm.ts's `else` arm — duty first — is justified by "the period may be
// SHRINKING under a live duty". Nothing reached that case until this section: a channel at
// the shipped 50 000 ns takes either order, so swapping the arm to period-first was green
// everywhere. It is reachable by this repo's own next edit — lower PWM_PERIOD_NS and the
// next restart finds exactly this — and by any other tool that exported the channel first.
// The shipped system cannot produce this state by itself today.

console.log("\n5. a channel something else left exported at 1 ms");

resetSimulatedSysfs(
  coldPi({ exportedOn: "pwmchip0", periodNs: 1_000_000, dutyNs: 500_000, outputEnabled: true, bridgeLive: true })
);
const shrunk = await startFanControl({ enabled: true });
check(`the section reached the simulator (${simulatedSysfs().calls.length} calls)`, simulatedSysfs().calls.length > 0);
check(
  `⚠️  bring-up succeeds against a period that has to SHRINK under a live duty (${shrunk.fault ?? "no fault"})`,
  shrunk.fault === null
);
check(
  "⚠️  …because the duty was zeroed BEFORE the period shrank — the other order is EINVAL on both kernels",
  writeIndex("duty_cycle") >= 0 && writeIndex("duty_cycle") < writeIndex("period")
);
check("and it still went enables-first", pinIndex(17, "dl") === 0 && simulatedSysfs().violations.length === 0);
await shrunk.stop();

// --- 6. The channel that is there but unreadable -------------------------------
//
// udev creates and chowns the per-channel directory a moment after the export, so "the
// files exist but belong to root" is the routine failure of an unprivileged run.

console.log("\n6. a channel the udev rule never chowned");

resetSimulatedSysfs(coldPi({ channelUnreadable: true }));
const unreadable = await startFanControl({ enabled: true });
check("bring-up fails rather than pretending", unreadable.fault !== null);
check(
  `…and the fault names the udev rule (${(unreadable.fault ?? "").slice(0, 70)}…)`,
  (unreadable.fault ?? "").includes("udev") && (unreadable.fault ?? "").includes("docs/fan-control.md")
);
check("no braked state was constructed on the failure path either", simulatedSysfs().violations.length === 0);

// --- 7. A `pinctrl` that is not installed ---------------------------------------

console.log("\n7. a Pi with no pinctrl");

resetSimulatedSysfs(coldPi());
// ⚠️ WITH the errno, or src/fan/pwm.ts takes its generic arm and the branch this section
// exists for — the one naming `raspi-utils` and the config.txt standby backstop — is never
// reached. A bare Error(message) passed here for exactly that reason.
failPinWrite(17, "spawn pinctrl ENOENT", "ENOENT");
const noPinctrl = await startFanControl({ enabled: true });
clearPinFailures();
check(`the section reached the simulator (${simulatedSysfs().calls.length} calls)`, simulatedSysfs().calls.length > 0);
check("bring-up fails when the enables cannot be driven at all", noPinctrl.fault !== null);
check(
  `…and the message names GPIO17 rather than a bare failure (${(noPinctrl.fault ?? "").slice(0, 50)}…)`,
  (noPinctrl.fault ?? "").includes("GPIO17")
);
check(
  "⚠️  …and it names the package to install and says the fan stays in standby, which is the safe failure",
  (noPinctrl.fault ?? "").includes("raspi-utils") && (noPinctrl.fault ?? "").includes("standby")
);
check(
  "⚠️  …and nothing was written to the channel after the enables could not be dropped",
  simulatedSysfs().calls.every(call => call.kind !== "write")
);

// --- 8. The redirect really was in force ----------------------------------------
//
// ⚠️ Without this the whole file could pass against the REAL /sys/class/pwm on a machine
// that happens to have one — which on the bike's Pi means driving the IBT-2 from a check.

console.log("\n8. nothing here went near the real filesystem");

check(
  `both module redirects were served (${redirectsServed().join(", ") || "none"})`,
  redirectsServed().includes("fs/promises") && redirectsServed().includes("child_process")
);

console.log("");
if (failures > 0) {
  console.error(`FAILED — ${failures} assertion${failures === 1 ? "" : "s"}`);
  process.exitCode = 1;
} else {
  console.log("✓ the real openFanPwm() discovers the overlay's chip, writes the period before the duty on a");
  console.log("  fresh export and the duty before the period on one that has to shrink, drops both enables");
  console.log("  ahead of everything else, and never constructs the braked state — over a simulated sysfs");
  console.log("  that rejects what rpi-6.6.y's __pwm_apply() rejects");
}
