import {
  clearPinFailures,
  failPinWrite,
  installSimulatedSysfs,
  isBraked,
  redirectsServed,
  resetSimulatedSysfs,
  simulatedSysfs,
  type SimulatedSeed,
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

/** A Zero 2 W's tree: one chip, one channel, an SoC `.pwm` device link, nothing exported. */
function coldPi(overrides: Partial<SimulatedSeed> = {}): SimulatedSeed {
  return {
    chips: { pwmchip0: { channelCount: 1, deviceLink: "../../devices/platform/soc/3f20c000.pwm" } },
    exportedOn: null,
    periodNs: 0,
    dutyNs: 0,
    outputEnabled: false,
    bridgeLive: false,
    ...overrides,
  };
}

/** Where a write to `name` sits in the call log, or −1. */
function writeAt(name: string, value?: string): number {
  return simulatedSysfs().calls.findIndex(
    call => call.kind === "write" && call.target.endsWith(`/${name}`) && (value === undefined || call.value === value)
  );
}

function pinAt(gpio: number, level: string): number {
  return simulatedSysfs().calls.findIndex(
    call => call.kind === "pinctrl" && call.target === `GPIO${gpio}` && call.value === level
  );
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
const { MIN_RUNNING_DUTY_PERCENT, MAX_DUTY_PERCENT } = await import("../src/fan/control.ts");
const { PWM_PERIOD_NS } = await import("../src/fan/pwm.ts");

const preferred = await startFanControl({ enabled: true });
check(
  `the simulated tree was reached at all (${simulatedSysfs().calls.length} calls)`,
  simulatedSysfs().calls.length > 0
);
check("bring-up succeeded", preferred.fault === null && preferred.configured);
check(
  "⚠️  the chip whose device is an SoC .pwm block wins over the LOWER-numbered one",
  writeAt("export") >= 0 && simulatedSysfs().calls[writeAt("export")].target.includes("pwmchip2")
);
await preferred.stop();

// A tree where nothing names a .pwm block: the lowest-numbered usable chip is taken, and
// it has to SAY so — picking somebody else's PWM silently is the failure being guarded.
const warnings: string[] = [];
const realWarn = console.warn;
console.warn = (...args: any[]): void => {
  warnings.push(args.map(part => String(part)).join(" "));
};
resetSimulatedSysfs(
  coldPi({
    chips: {
      pwmchip0: { channelCount: 0, deviceLink: null },
      pwmchip1: { channelCount: 1, deviceLink: null },
      pwmchip3: { channelCount: 1, deviceLink: null },
    },
  })
);
const guessed = await startFanControl({ enabled: true });
console.warn = realWarn;
check("a tree where no chip names a .pwm block still comes up", guessed.fault === null);
check(
  "…on the lowest-numbered chip that offers channel 0, skipping the one whose npwm is 0",
  writeAt("export") >= 0 && simulatedSysfs().calls[writeAt("export")].target.includes("pwmchip1")
);
check(
  `⚠️  …and it WARNS rather than picking silently (${warnings.length} line)`,
  warnings.some(line => line.includes("pwmchip1") && line.includes("lowest-numbered"))
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
  writeAt("period") >= 0 && writeAt("period") < writeAt("duty_cycle")
);
check(
  "⚠️  both enables were dropped before ANY of it, because a restart can begin under a live bridge",
  pinAt(17, "dl") >= 0 && pinAt(27, "dl") >= 0 && pinAt(17, "dl") < writeAt("export")
);
check("the channel was exported", writeAt("export", "0") >= 0);
check(`the period is the shipped ${PWM_PERIOD_NS} ns`, writeAt("period", String(PWM_PERIOD_NS)) >= 0);
check("the PWM output was left disabled", writeAt("enable", "0") >= 0);
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

const LIVE_BRIDGE: SimulatedSeed = {
  chips: { pwmchip0: { channelCount: 1, deviceLink: "../../devices/platform/soc/3f20c000.pwm" } },
  exportedOn: "pwmchip0",
  periodNs: 50_000,
  dutyNs: 25_000,
  outputEnabled: true,
  bridgeLive: true,
};
resetSimulatedSysfs(LIVE_BRIDGE);
const restarted = await startFanControl({ enabled: true });
check(`the section reached the simulator (${simulatedSysfs().calls.length} calls)`, simulatedSysfs().calls.length > 0);
check("bring-up succeeded over an already-exported channel", restarted.fault === null);
check(
  "⚠️  THE ENABLES WENT LOW FIRST, ahead of every read and every write",
  pinAt(17, "dl") === 0 && pinAt(27, "dl") === 1
);
check(
  "⚠️  …so no braked state was constructed, which is what this ordering is for",
  simulatedSysfs().violations.length === 0
);
check("the re-export's EBUSY was tolerated rather than fatal", writeAt("export") >= 0 && restarted.fault === null);
check(
  "the duty was zeroed and the period re-asserted",
  simulatedSysfs().dutyNs === 0 && simulatedSysfs().periodNs === PWM_PERIOD_NS
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

resetSimulatedSysfs({
  chips: { pwmchip0: { channelCount: 1, deviceLink: "../../devices/platform/soc/3f20c000.pwm" } },
  exportedOn: "pwmchip0",
  periodNs: 1_000_000,
  dutyNs: 500_000,
  outputEnabled: true,
  bridgeLive: true,
});
const shrunk = await startFanControl({ enabled: true });
check(`the section reached the simulator (${simulatedSysfs().calls.length} calls)`, simulatedSysfs().calls.length > 0);
check(
  `⚠️  bring-up succeeds against a period that has to SHRINK under a live duty (${shrunk.fault ?? "no fault"})`,
  shrunk.fault === null
);
check(
  "⚠️  …because the duty was zeroed BEFORE the period shrank — the other order is EINVAL on both kernels",
  writeAt("duty_cycle") >= 0 && writeAt("duty_cycle") < writeAt("period")
);
check("and it still went enables-first", pinAt(17, "dl") === 0 && simulatedSysfs().violations.length === 0);
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
failPinWrite(17, "dl", "spawn pinctrl ENOENT");
const noPinctrl = await startFanControl({ enabled: true });
clearPinFailures();
check("bring-up fails when the enables cannot be driven at all", noPinctrl.fault !== null);
check(
  `…and the message names GPIO17 rather than a bare failure (${(noPinctrl.fault ?? "").slice(0, 50)}…)`,
  (noPinctrl.fault ?? "").includes("GPIO17")
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
check(
  "the running band the bridge is driven over is the shipped one",
  MIN_RUNNING_DUTY_PERCENT === 30 && MAX_DUTY_PERCENT === 100
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
