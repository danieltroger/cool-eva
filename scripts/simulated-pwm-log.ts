import { simulatedSysfs, type SysfsCall } from "./simulated-pwm-sysfs.ts";

// Reading the simulated Pi's call log.
//
// Beside ./simulated-pwm-sysfs.ts rather than in either check, because the shape of a
// SysfsCall is that file's: a check that knew a write is `kind === "write"` with a target
// ending `/duty_cycle` would keep type-checking after the double stopped recording it that
// way, and its assertions would go green-and-vacuous rather than red. Same reason
// ./fan-banner-harness.ts owns batchIndexOf() rather than each banner check.
//
// `since` is a mark taken from calls.length, so an index is relative to it and two indices
// from the same mark are comparable. It defaults to 0 — the whole log — which is what a
// section that reset the simulator wants.

/** The call log from `since` on, so a failed assertion prints what actually happened. */
export function sequenceFrom(since = 0): string {
  return callsFrom(since)
    .map(call =>
      call.kind === "pinctrl" ? `${call.target}=${call.value}` : `${attributeOf(call.target)}=${call.value}`
    )
    .join(" → ");
}

/** Where an attribute was written with `value`, counting from `since`, or −1. */
export function writeIndex(attribute: string, value?: string, since = 0): number {
  return callsFrom(since).findIndex(
    call =>
      call.kind === "write" && attributeOf(call.target) === attribute && (value === undefined || call.value === value)
  );
}

/** Where a pin was driven to `level`, counting from `since`, or −1. */
export function pinIndex(gpio: number, level: string, since = 0): number {
  return callsFrom(since).findIndex(
    call => call.kind === "pinctrl" && call.target === `GPIO${gpio}` && call.value === level
  );
}

/** Which chip channel 0 was exported on, as the log saw it, or null. */
export function exportedChipName(): string | null {
  const at = writeIndex("export");
  return at < 0 ? null : (simulatedSysfs().calls[at].target.split("/").at(-2) ?? null);
}

/** How many calls have been recorded — a mark to pass back as `since`. */
export function callCount(): number {
  return simulatedSysfs().calls.length;
}

function callsFrom(since: number): readonly SysfsCall[] {
  return simulatedSysfs().calls.slice(since);
}

/** The last path segment, which is the attribute name for every path this models. */
function attributeOf(path: string): string {
  return path.split("/").at(-1) ?? path;
}
