import { promisify } from "util";
import { installFanIoFence } from "./fan-io-fence.ts";

// A stand-in for /sys/class/pwm and for `pinctrl`, so the REAL openFanPwm() can be run on
// a laptop. src/fan/control.ts already takes an `openPwm` seam, and using it means
// everything below FanPwm — the bring-up order that decides whether the fan works at all
// — is replaced rather than tested. This is the layer under that: the calls
// src/fan/pwm.ts makes on the world, with the kernel's own rejections modelled, so the
// shipped file runs unmodified and its write ORDER is what is under test.
//
// ⚠️ A REAL DIRECTORY WOULD NOT DO: a tmpfs accepts every write, so the bug this exists to
// catch would pass against one. What has to be simulated is the REJECTIONS.
//
// A TEST DOUBLE, not a check — the standing scripts/simulated-vcu-micro.ts has.
//
// ⚠️ IT ALSO MODELS AN ELECTRICAL HAZARD: both IBT-2 enables HIGH while the PWM is at 0 %
// shorts the motor across ground and brakes a rotor a 270 km/h airstream is driving.
// isBraked() is that state and noteBridge() evaluates it after EVERY change, because an
// index comparison passes a sequence that enters it and leaves again.
// docs/fan-control.md §3 has the electronics and the sequence.
//
// ⚠️ WHICH KERNEL: rpi-6.6.y's, where the rejections are UNCONDITIONAL. rpi-6.12.y gates
// them on `enabled` and accepts a duty write 6.6 refuses. The stricter one is modelled on
// purpose — docs/fan-control.md §5 quotes both and argues it.

/** The tree src/fan/pwm.ts looks in. Not configurable there, so not configurable here. */
const PWM_CLASS_DIR = "/sys/class/pwm";

/** One chip as the simulated tree presents it. */
export interface SimulatedChip {
  /** `npwm`. null makes the file unreadable — the "chip that will not say" branch. */
  channelCount: number | null;
  /** What `device` points at, or null for a link that cannot be read. */
  deviceLink: string | null;
}

/** What one section wants the Pi to look like before src/fan/pwm.ts opens it. */
export interface SimulatedSeed {
  /** The chips `/sys/class/pwm` lists — or **null** for a kernel with no PWM class at all,
   *  which is the no-overlay case. A boolean beside a populated `chips` would let a seed
   *  claim both at once. */
  chips: Record<string, SimulatedChip> | null;
  /** The chip whose channel 0 an earlier run left exported, or null for a cold tree. */
  exportedOn: string | null;
  periodNs: number;
  dutyNs: number;
  outputEnabled: boolean;
  /** Both enables. A restart after SIGKILL finds these HIGH — docs/fan-control.md §5. */
  bridgeLive: boolean;
  /** Make the channel directory answer EACCES, as a missing udev rule does. */
  channelUnreadable?: boolean;
}

/** Everything the bridge's electrical state is decided from. */
export interface BridgeState {
  outputEnabled: boolean;
  dutyNs: number;
  pin17High: boolean;
  pin27High: boolean;
}

export interface SysfsCall {
  kind: "readdir" | "readFile" | "readlink" | "write" | "pinctrl";
  /** The path, or `GPIO17` for a pinctrl call. */
  target: string;
  /** What was written, or the pinctrl level, or null for a read. */
  value: string | null;
}

/** What a check may read. Deliberately readonly — see simulatedSysfs(). */
export interface SimulatedView extends Readonly<BridgeState> {
  readonly periodNs: number;
  readonly calls: readonly SysfsCall[];
  readonly violations: readonly string[];
}

/** A `pinctrl` write parked mid-flight, and the two halves of releasing it. */
export interface HeldPinWrite {
  /** Resolves once the write has REACHED the gate — await this before racing against it. */
  engaged: Promise<void>;
  release: () => void;
}

/**
 * Redirects src/fan/'s view of `fs/promises` and `child_process` to this module.
 *
 * ⚠️ Call it before the first `import()` of anything under src/fan/ — ./fan-io-fence.ts
 * says why, and carries the three limits worth knowing.
 */
export function installSimulatedSysfs(): void {
  installFanIoFence(import.meta.url);
}

/** A Zero 2 W: one chip, one channel, an SoC `.pwm` link, nothing exported, bridge down. */
export function coldPi(overrides: Partial<SimulatedSeed> = {}): SimulatedSeed {
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

/**
 * Puts the simulated Pi back to a known state. Every section calls this and then asserts
 * its OWN call count before asserting anything about order — sections share one module
 * instance, so a section reading a log another section filled is the failure to design
 * against.
 */
export function resetSimulatedSysfs(seed: SimulatedSeed): void {
  if (state.held !== null) {
    // Left awaiting a promise nobody can resolve, the in-flight runPinctrl() would hang
    // until run-checks.ts SIGKILLs at 120 s and reports "no verdict" — which reads as a
    // hang rather than as the assertion that should have gone red.
    throw new Error(`reset while a \`pinctrl\` write on GPIO${state.held.gpio} was still held — release it first`);
  }
  state.chips = seed.chips === null ? null : { ...seed.chips };
  state.exportedOn = seed.exportedOn;
  state.periodNs = seed.periodNs;
  state.dutyNs = seed.dutyNs;
  state.outputEnabled = seed.outputEnabled;
  state.pin17High = seed.bridgeLive;
  state.pin27High = seed.bridgeLive;
  state.channelUnreadable = seed.channelUnreadable ?? false;
  state.calls = [];
  state.violations = [];
  state.pinFailures = new Map();
  if (isBraked(state)) {
    // A seed is a claim about a Pi that was running a moment ago, so a braked seed is a
    // mistake in the check rather than a finding about src/fan/.
    throw new Error("the seed is itself the braked state, so nothing below could be measured against it");
  }
}

/**
 * The bridge as it stands, the ordered call log and the violations.
 *
 * ⚠️ Readonly, and not as tidiness: nine assertions across the two checks are
 * `violations.length === 0`, and commit 970aa50 exists because those nine were once
 * asserting against a counter nothing incremented. A mutable handle to that counter leaves
 * the same failure one typo away, where `tsc` catches this for free.
 */
export function simulatedSysfs(): SimulatedView {
  return state;
}

/**
 * The braked state: both enables HIGH while the PWM is not actually driving.
 *
 * Pure, and exported so the invariant can be mutation-tested in the check itself.
 * ⚠️ BOTH pins, not either: with one enable LOW that half-bridge is off, so there is no
 * path across the winding and nothing to brake against.
 */
export function isBraked(bridge: BridgeState): boolean {
  if (!(bridge.pin17High && bridge.pin27High)) {
    return false;
  }
  return !bridge.outputEnabled || bridge.dutyNs === 0;
}

/**
 * Makes every `pinctrl` write to one pin fail, as a missing binary or a fork that ENOMEMs
 * does.
 *
 * ⚠️ `code` matters: src/fan/pwm.ts branches on ENOENT to name `raspi-utils` and the
 * config.txt standby backstop, and a failure with no code takes the generic arm instead.
 */
export function failPinWrite(gpio: number, message: string, code?: string): void {
  state.pinFailures.set(gpio, { message, code });
}

export function clearPinFailures(): void {
  state.pinFailures.clear();
}

/**
 * Parks the next `pinctrl set <gpio> op <level>` until `release()` is called.
 *
 * ⚠️ `engaged` is the half that makes a race test mean anything: await it before issuing
 * the command that is supposed to arrive DURING this one. Without it, a release that lands
 * before the write reaches the gate makes the gate a no-op, the two commands never overlap,
 * and the section passes having raced nothing.
 *
 * Resolved by hand rather than by a timer, because scripts/check-fan-ordering.ts measures
 * leaked `setTimeout`s and a double with a clock of its own would be counted.
 */
export function holdPinWrite(gpio: number, level: string): HeldPinWrite {
  let release = (): void => {};
  const blocked = new Promise<void>(resolve => {
    release = resolve;
  });
  let engage = (): void => {};
  const engaged = new Promise<void>(resolve => {
    engage = resolve;
  });
  state.held = { gpio, level, blocked, engage };
  return { engaged, release };
}

// --- the fs/promises surface -------------------------------------------------

export async function readdir(path: string): Promise<string[]> {
  state.calls.push({ kind: "readdir", target: path, value: null });
  if (state.chips === null || path !== PWM_CLASS_DIR) {
    throw posixError("ENOENT", `ENOENT: no such file or directory, scandir '${path}'`);
  }
  return Object.keys(state.chips);
}

export async function readFile(path: string, encoding: string): Promise<string> {
  state.calls.push({ kind: "readFile", target: path, value: null });
  if (encoding !== "utf-8") {
    throw new Error(`the simulated sysfs only answers utf-8 reads, not ${encoding}`);
  }
  const chip = chipFor(path, "npwm");
  if (chip !== null) {
    if (chip.channelCount === null) {
      throw posixError("EACCES", `EACCES: permission denied, open '${path}'`);
    }
    return `${chip.channelCount}\n`;
  }
  if (path === `${channelPath()}/period`) {
    requireExportedChannel(path);
    return `${state.periodNs}\n`;
  }
  throw posixError("ENOENT", `ENOENT: no such file or directory, open '${path}'`);
}

export async function readlink(path: string): Promise<string> {
  state.calls.push({ kind: "readlink", target: path, value: null });
  const chip = chipFor(path, "device");
  if (chip === null || chip.deviceLink === null) {
    throw posixError("ENOENT", `ENOENT: no such file or directory, readlink '${path}'`);
  }
  return chip.deviceLink;
}

export async function writeFile(path: string, data: string): Promise<void> {
  state.calls.push({ kind: "write", target: path, value: data });
  if (chipFor(path, "export") !== null) {
    exportChannel(path, data);
    return;
  }
  const attribute = CHANNEL_ATTRIBUTE.exec(path);
  if (attribute === null) {
    throw posixError("ENOENT", `ENOENT: no such file or directory, open '${path}'`);
  }
  requireExportedChannel(path);
  applyAttribute(attribute[1], data, path);
}

// --- the child_process surface -----------------------------------------------

/**
 * `execFile`, usable only through `promisify` — which is the only way src/fan/pwm.ts uses
 * it, and therefore the only way a check should drive a pin either. The callback form
 * throws rather than being quietly unimplemented.
 */
export const execFile = Object.assign(
  (): never => {
    throw new Error("the simulated execFile is only usable through promisify(), as src/fan/pwm.ts uses it");
  },
  { [promisify.custom]: runPinctrl }
);

// --- internals ----------------------------------------------------------------

interface PinFailure {
  message: string;
  code?: string;
}

interface HeldWriteState {
  gpio: number;
  level: string;
  blocked: Promise<void>;
  engage: () => void;
}

interface SimulatedSysfs extends BridgeState {
  chips: Record<string, SimulatedChip> | null;
  exportedOn: string | null;
  periodNs: number;
  channelUnreadable: boolean;
  calls: SysfsCall[];
  /** One line per time the bridge entered the braked state. Empty is the property. */
  violations: string[];
  pinFailures: Map<number, PinFailure>;
  held: HeldWriteState | null;
}

const state: SimulatedSysfs = {
  chips: null,
  exportedOn: null,
  periodNs: 0,
  dutyNs: 0,
  outputEnabled: false,
  pin17High: false,
  pin27High: false,
  channelUnreadable: false,
  calls: [],
  violations: [],
  pinFailures: new Map(),
  held: null,
};

// Built once rather than per call, and from PWM_CLASS_DIR so there is one spelling of it.
const CHIP_ATTRIBUTE = new RegExp(`^${PWM_CLASS_DIR}/(pwmchip\\d+)/(npwm|device|export)$`);
const CHANNEL_ATTRIBUTE = new RegExp(`^${PWM_CLASS_DIR}/pwmchip\\d+/pwm0/(period|duty_cycle|enable)$`);

function channelPath(): string {
  return `${PWM_CLASS_DIR}/${state.exportedOn}/pwm0`;
}

/** The chip `${PWM_CLASS_DIR}/pwmchipN/<name>` addresses, or null if that is not the path. */
function chipFor(path: string, name: string): SimulatedChip | null {
  const match = CHIP_ATTRIBUTE.exec(path);
  if (match === null || match[2] !== name || state.chips === null) {
    return null;
  }
  return state.chips[match[1]] ?? null;
}

function exportChannel(path: string, data: string): void {
  if (data.trim() !== "0") {
    throw posixError("EINVAL", "EINVAL: invalid argument, write");
  }
  if (state.exportedOn !== null) {
    // The routine restart case: nothing in src/fan/pwm.ts ever unexports.
    throw posixError("EBUSY", "EBUSY: resource busy or locked, write");
  }
  state.exportedOn = path.split("/").at(-2) ?? null;
}

function requireExportedChannel(path: string): void {
  if (state.exportedOn === null || !path.startsWith(channelPath())) {
    throw posixError("ENOENT", `ENOENT: no such file or directory, open '${path}'`);
  }
  if (state.channelUnreadable) {
    throw posixError("EACCES", `EACCES: permission denied, open '${path}'`);
  }
}

/**
 * One sysfs attribute write, as rpi-6.6.y performs it.
 *
 * period_store, duty_cycle_store and enable_store each read the current state, change
 * their own field and apply the whole thing (drivers/pwm/sysfs.c), so one predicate covers
 * all three: `!state->period || state->duty_cycle > state->period` → EINVAL, ahead of the
 * "nothing changed" early return. docs/fan-control.md §5 quotes it.
 */
function applyAttribute(attribute: string, data: string, path: string): void {
  const value = Number.parseInt(data.trim(), 10);
  if (!Number.isFinite(value) || value < 0) {
    throw posixError("EINVAL", `EINVAL: invalid argument, write '${data}' to '${path}'`);
  }
  const next = {
    periodNs: attribute === "period" ? value : state.periodNs,
    dutyNs: attribute === "duty_cycle" ? value : state.dutyNs,
    outputEnabled: attribute === "enable" ? value === 1 : state.outputEnabled,
  };
  if (next.periodNs === 0 || next.dutyNs > next.periodNs) {
    throw posixError(
      "EINVAL",
      `EINVAL: invalid argument, write '${data}' to '${path}' ` +
        `(period ${next.periodNs} ns, duty ${next.dutyNs} ns — __pwm_apply rejects it)`
    );
  }
  state.periodNs = next.periodNs;
  state.dutyNs = next.dutyNs;
  state.outputEnabled = next.outputEnabled;
  noteBridge(`${attribute}=${data.trim()}`);
}

async function runPinctrl(file: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  if (file !== "pinctrl") {
    throw posixError("ENOENT", `spawn ${file} ENOENT`);
  }
  const [verb, gpioText, mode, level] = args;
  if (verb !== "set" || mode !== "op" || (level !== "dh" && level !== "dl")) {
    throw new Error(`the simulated pinctrl does not understand \`${args.join(" ")}\``);
  }
  const gpio = Number.parseInt(gpioText, 10);
  if (gpio !== 17 && gpio !== 27) {
    throw new Error(`GPIO${gpioText} is not one of the IBT-2 enables (17 and 27)`);
  }
  state.calls.push({ kind: "pinctrl", target: `GPIO${gpio}`, value: level });

  if (state.held !== null && state.held.gpio === gpio && state.held.level === level) {
    const held = state.held;
    state.held = null;
    held.engage();
    await held.blocked;
  }
  const failure = state.pinFailures.get(gpio);
  if (failure !== undefined) {
    throw failure.code === undefined ? new Error(failure.message) : posixError(failure.code, failure.message);
  }
  // ⚠️ No rollback, exactly as setEnablePins()' loop has none: a failure on the second pin
  // leaves the first already driven. That is what makes the two failure cases differ.
  if (gpio === 17) {
    state.pin17High = level === "dh";
  } else {
    state.pin27High = level === "dh";
  }
  noteBridge(`GPIO${gpio} ${level}`);
  return { stdout: "", stderr: "" };
}

/** Records a braked bridge rather than throwing, so the check names which step built it. */
function noteBridge(step: string): void {
  if (isBraked(state)) {
    state.violations.push(
      `after ${step}: both enables HIGH with ` +
        `${state.outputEnabled ? `duty ${state.dutyNs} ns` : "the PWM output disabled"} — the rotor is braked`
    );
  }
}

function posixError(code: string, message: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(message);
  error.code = code;
  return error;
}
