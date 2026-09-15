import { registerHooks } from "node:module";
import { promisify } from "util";

// A stand-in for /sys/class/pwm and for `pinctrl`, so the REAL openFanPwm() can be run on
// a laptop. src/fan/control.ts already takes an `openPwm` seam, and using it means
// everything below FanPwm — the bring-up order that decides whether the fan works at all
// — is replaced rather than tested. This is the layer under that: the five calls
// src/fan/pwm.ts makes on the world, with the kernel's own rejections modelled, so the
// shipped file runs unmodified and its write ORDER is what is under test.
//
// Used by scripts/check-fan-pwm-bringup.ts and scripts/check-fan-ordering.ts. It is a
// TEST DOUBLE, not a check — the same standing as scripts/simulated-vcu-micro.ts.
//
// ⚠️ IT ALSO MODELS AN ELECTRICAL HAZARD, which is the reason it exists rather than a
// call-order recorder. Both IBT-2 enables HIGH while the PWM is at 0 % leaves both low
// sides of the BTS7960 on, shorting the motor across ground and braking a rotor that a
// 270 km/h airstream is driving. isBraked() below is that state, and it is evaluated
// after EVERY change rather than compared between call indices — an index comparison
// passes a sequence that enters the braked state and leaves it again.
// docs/fan-control.md §3.
//
// ⚠️ WHICH KERNEL THIS IS. The rejections are rpi-6.6.y's, read verbatim from
// drivers/pwm/core.c:501 in the Raspberry Pi fork, quoted in docs/fan-control.md §5. They
// are UNCONDITIONAL there. rpi-6.12.y gates both on `enabled` (core.c:151), so it accepts
// a duty write that 6.6 rejects. The stricter kernel is modelled on purpose: the shipped
// write order has to be right on the strictest kernel the Pi may boot, and a 6.12 mode
// would be a mode in which the mutation cannot die.

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
  chips: Record<string, SimulatedChip>;
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

/**
 * Redirects src/fan/'s view of `fs/promises` and `child_process` to this module.
 *
 * ⚠️ Call this BEFORE the first `import()` of anything under src/fan/, which means those
 * imports have to be dynamic in the check. A static import would be resolved before the
 * hook exists and would reach the real filesystem.
 */
export function installSimulatedSysfs(): void {
  registerHooks({ resolve: resolveFanImport });
}

/**
 * Puts the simulated Pi back to a known state. Every section calls this and then asserts
 * its OWN call count before asserting anything about order — sections share one module
 * instance, so a section reading a log another section filled is the failure to design
 * against.
 */
export function resetSimulatedSysfs(seed: SimulatedSeed): void {
  state.chips = new Map(Object.entries(seed.chips));
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
  state.held = null;
  if (isBraked(state)) {
    // A seed is a claim about a Pi that was running a moment ago, so a braked seed is a
    // mistake in the check rather than a finding about src/fan/.
    throw new Error("the seed is itself the braked state, so nothing below could be measured against it");
  }
}

/** The ordered call log, the violations, and the bridge as it stands. */
export function simulatedSysfs(): SimulatedSysfs {
  return state;
}

/**
 * The braked state: both enables HIGH while the PWM is not actually driving.
 *
 * Pure, and exported so the invariant can be mutation-tested in the check itself — an
 * invariant checker nobody has ever seen go red is the shape this repo keeps getting
 * caught by. ⚠️ BOTH pins, not either: with one enable LOW that half-bridge is off, so
 * there is no path across the winding and nothing to brake against.
 */
export function isBraked(bridge: BridgeState): boolean {
  if (!(bridge.pin17High && bridge.pin27High)) {
    return false;
  }
  return !bridge.outputEnabled || bridge.dutyNs === 0;
}

/** Makes one `pinctrl` call fail, the way a missing binary or a fork that ENOMEMs does. */
export function failPinWrite(gpio: number, level: string, message: string): void {
  state.pinFailures.set(`${gpio}:${level}`, message);
}

export function clearPinFailures(): void {
  state.pinFailures.clear();
}

/**
 * Blocks the next `pinctrl set <gpio> op <level>` until the returned function is called.
 *
 * ⚠️ Resolved by hand rather than by a timer, because scripts/check-fan-ordering.ts
 * measures leaked `setTimeout`s and a double with a clock of its own would be counted.
 */
export function holdPinWrite(gpio: number, level: string): () => void {
  let release = (): void => {};
  const blocked = new Promise<void>(resolve => {
    release = resolve;
  });
  state.held = { key: `${gpio}:${level}`, blocked };
  return release;
}

/** Which redirected specifiers the hook actually served. Never cleared by a reset. */
export function redirectsServed(): string[] {
  return [...served];
}

// --- the fs/promises surface ------------------------------------------------

export async function readdir(path: string): Promise<string[]> {
  state.calls.push({ kind: "readdir", target: path, value: null });
  if (path !== PWM_CLASS_DIR) {
    throw posixError("ENOENT", `ENOENT: no such file or directory, scandir '${path}'`);
  }
  return [...state.chips.keys()];
}

export async function readFile(path: string, encoding: string): Promise<string> {
  state.calls.push({ kind: "readFile", target: path, value: null });
  if (encoding !== "utf-8") {
    throw new Error(`the simulated sysfs only answers utf-8 reads, not ${encoding}`);
  }
  const chipName = matchChipAttribute(path, "npwm");
  if (chipName !== null) {
    const chip = state.chips.get(chipName);
    if (chip === undefined || chip.channelCount === null) {
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
  const chipName = matchChipAttribute(path, "device");
  const chip = chipName === null ? undefined : state.chips.get(chipName);
  if (chip === undefined || chip.deviceLink === null) {
    throw posixError("ENOENT", `ENOENT: no such file or directory, readlink '${path}'`);
  }
  return chip.deviceLink;
}

export async function writeFile(path: string, data: string): Promise<void> {
  state.calls.push({ kind: "write", target: path, value: data });
  const exportChip = matchChipAttribute(path, "export");
  if (exportChip !== null) {
    exportChannel(exportChip, data);
    return;
  }
  const attribute = matchChannelAttribute(path);
  if (attribute === null) {
    throw posixError("ENOENT", `ENOENT: no such file or directory, open '${path}'`);
  }
  requireExportedChannel(path);
  applyAttribute(attribute, data, path);
}

// --- the child_process surface ----------------------------------------------

/**
 * `execFile`, usable only through `promisify` — which is the only way src/fan/pwm.ts uses
 * it. The callback form throws rather than being quietly unimplemented.
 */
export const execFile = definePromisified();

// --- internals ---------------------------------------------------------------

interface HeldPinWrite {
  key: string;
  blocked: Promise<void>;
}

interface SimulatedSysfs extends BridgeState {
  chips: Map<string, SimulatedChip>;
  exportedOn: string | null;
  periodNs: number;
  channelUnreadable: boolean;
  calls: SysfsCall[];
  /** One line per time the bridge entered the braked state. Empty is the property. */
  violations: string[];
  pinFailures: Map<string, string>;
  held: HeldPinWrite | null;
}

const state: SimulatedSysfs = {
  chips: new Map(),
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

const REDIRECTED = new Set(["fs/promises", "child_process"]);
/** Bare specifiers src/fan/ may reach that touch nothing outside the process. */
const ALLOWED_BARE = new Set(["util"]);
const served = new Set<string>();
const DOUBLE_URL = import.meta.url;

interface ResolveContext {
  parentURL?: string;
}
interface ResolveResult {
  url: string;
  shortCircuit?: boolean;
}
type NextResolve = (specifier: string, context: ResolveContext) => ResolveResult;

/**
 * ⚠️ An ALLOW-LIST, and the deny arm throws. Keyed on the whole of src/fan/ rather than on
 * pwm.ts, so splitting openFanPwm() into its own file — which is exactly the move this
 * repo makes — cannot silently re-open the hole. What the hole is: with the real
 * `fs/promises` in hand this check WRITES TO /sys/class/pwm and spawns `pinctrl`, and on
 * the bike's Pi that drives the actual IBT-2. `npm test` claims to need no bike
 * (docs/diagnostics-and-checks.md §11.1) and this is what keeps that true of the code
 * rather than of whichever machine happens to run it.
 */
function resolveFanImport(specifier: string, context: ResolveContext, nextResolve: NextResolve): ResolveResult {
  if (!(context.parentURL ?? "").includes("/src/fan/")) {
    return nextResolve(specifier, context);
  }
  if (REDIRECTED.has(specifier)) {
    served.add(specifier);
    return { url: DOUBLE_URL, shortCircuit: true };
  }
  if (specifier.startsWith(".") || ALLOWED_BARE.has(specifier)) {
    return nextResolve(specifier, context);
  }
  throw new Error(
    `${context.parentURL} imports \`${specifier}\`, which scripts/simulated-pwm-sysfs.ts does not simulate. ` +
      `Nothing under src/fan/ may reach the real world while this check runs — a real write here drives the ` +
      `IBT-2 on the bike's Pi. Fix it by adding \`${specifier}\` to REDIRECTED there and simulating it, or to ` +
      `ALLOWED_BARE if it touches nothing outside the process.`
  );
}

function channelPath(): string {
  return `${PWM_CLASS_DIR}/${state.exportedOn}/pwm0`;
}

/** `pwmchipN` out of `${PWM_CLASS_DIR}/pwmchipN/<name>`, or null. */
function matchChipAttribute(path: string, name: string): string | null {
  const match = new RegExp(`^${PWM_CLASS_DIR}/(pwmchip\\d+)/${name}$`).exec(path);
  return match === null ? null : match[1];
}

function matchChannelAttribute(path: string): string | null {
  const match = new RegExp(`^${PWM_CLASS_DIR}/pwmchip\\d+/pwm0/(period|duty_cycle|enable)$`).exec(path);
  return match === null ? null : match[1];
}

function exportChannel(chipName: string, data: string): void {
  if (data.trim() !== "0") {
    throw posixError("EINVAL", `EINVAL: invalid argument, write`);
  }
  if (state.exportedOn !== null) {
    // The routine restart case: nothing in src/fan/pwm.ts ever unexports.
    throw posixError("EBUSY", `EBUSY: resource busy or locked, write`);
  }
  state.exportedOn = chipName;
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
 * Each of period_store, duty_cycle_store and enable_store reads the current state, changes
 * its own field and applies the whole thing (drivers/pwm/sysfs.c), so one predicate covers
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
  const [verb, gpio, mode, level] = args;
  if (verb !== "set" || mode !== "op" || (level !== "dh" && level !== "dl")) {
    throw new Error(`the simulated pinctrl does not understand \`${args.join(" ")}\``);
  }
  state.calls.push({ kind: "pinctrl", target: `GPIO${gpio}`, value: level });
  const key = `${gpio}:${level}`;
  if (state.held !== null && state.held.key === key) {
    const blocked = state.held.blocked;
    state.held = null;
    await blocked;
  }
  const failure = state.pinFailures.get(key);
  if (failure !== undefined) {
    throw new Error(failure);
  }
  // ⚠️ No rollback, exactly as setEnablePins()' loop has none: a failure on the second pin
  // leaves the first already driven. That is what makes the two failure cases differ.
  if (gpio === "17") {
    state.pin17High = level === "dh";
  } else if (gpio === "27") {
    state.pin27High = level === "dh";
  } else {
    throw new Error(`GPIO${gpio} is not one of the IBT-2 enables (17 and 27)`);
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

/** `execFile` with only its promisified form implemented. */
function definePromisified(): () => never {
  const stub = (): never => {
    throw new Error("the simulated execFile is only usable through promisify(), as src/fan/pwm.ts uses it");
  };
  Object.defineProperty(stub, promisify.custom, { value: runPinctrl });
  return stub;
}
