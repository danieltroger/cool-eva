import assert from "node:assert/strict";
import * as colors from "../public/lib/colors.js";
assert.equal(Object.hasOwn(colors, "power"), false, "The retired threshold-based power colour API must not return.");
import { powerPosition, ridePowerState } from "../public/lib/ride-power-state.js";
import type { ReadingStatus } from "../public/lib/reading-status.js";
import { POWER_SCALE_KW, limitKw } from "../public/lib/power-limits.js";
import { ridePowerDisplay } from "../public/lib/ride-power-display.js";

assert.deepEqual(POWER_SCALE_KW, { drive: 130, regen: 36 });
for (const [amps, volts, expected] of [
  [0, 340, 0],
  [210, 340, 71.4],
  [null, 340, null],
  [210, null, null],
  [210, 0, null],
  [-1, 340, null],
] as const) {
  assert.equal(limitKw(amps, volts), expected);
}

const readings: Record<string, number> = { pack_kw: -48.3, pack_v: 340, allowed_discharge_a: 210, allowed_regen_a: 55 };
const read = (key: string) => readings[key] ?? null;
const fresh = (_key: string): ReadingStatus => "fresh";
const normal = ridePowerState(read, fresh, false);
assert.equal(normal.drive.kilowatts, 71.4);
assert.equal(normal.regen.kilowatts, 18.7);
assert.equal(normal.value, -48.3);
const vcuLimited = ridePowerState(
  key => (key === "go" ? 1 : key === "current_max_out_a" ? 25 : read(key)),
  fresh,
  false
);
assert.equal(vcuLimited.drive.kilowatts, 8.5, "GO uses the applied VCU ceiling.");

assert.equal(normal.status, "");
assert.ok(Math.abs(powerPosition(0) * 372 - 80.67469879518073) < 1e-9);
assert.equal(powerPosition(36), 0);
assert.equal(powerPosition(-130), 1);
assert.ok(powerPosition(-48.3) > powerPosition(0));
assert.ok(powerPosition(8) < powerPosition(0));
for (const state of ["missing", "stale", "fault"] as const) {
  const unknown = ridePowerState(read, key => (key === "allowed_discharge_a" ? state : "fresh"), false);
  assert.equal(unknown.drive.kilowatts, null);
  assert.equal(unknown.regen.kilowatts, 18.7);
  assert.equal(unknown.status, `Drive limit ${state === "missing" ? "unavailable" : state}`);
  const power = ridePowerState(read, key => (key === "pack_kw" ? state : "fresh"), false);
  assert.equal(power.value, null);
  assert.equal(power.drive.kilowatts, 71.4);
}
const zero = ridePowerState(key => (key === "allowed_discharge_a" ? 0 : read(key)), fresh, false);
assert.equal(zero.drive.kilowatts, 0);
assert.equal(zero.status, "Over drive limit");
const mixedLimits = ridePowerState(
  key => (key === "allowed_discharge_a" ? 50 : read(key)),
  key => (key === "allowed_regen_a" ? "missing" : "fresh"),
  false
);
assert.equal(mixedLimits.excess, true);
assert.equal(mixedLimits.status, "Over drive limit", "An unknown opposite limit must not hide a known excess.");
const zeroVolts = ridePowerState(key => (key === "pack_v" ? 0 : read(key)), fresh, false);
assert.equal(zeroVolts.drive.kilowatts, null);
assert.equal(zeroVolts.regen.kilowatts, null);
const charge = ridePowerState(read, fresh, true);
assert.equal(charge.status, "Power out · riding limits off");
assert.equal(charge.excess, false);
assert.equal(charge.value, -48.3, "Charging must preserve signed measured power.");
assert.equal(
  ridePowerState(read, key => (key === "pack_kw" ? "fault" : "fresh"), true).status,
  "Charging · power fault · riding limits off"
);
console.log(
  "✓ Ride fixed scale, sign, measured voltage, zero, unknown/fault/stale states, opposite-limit retention and charging"
);

for (const [value, charging, moving, label, magnitude, color] of [
  [-48.3, false, true, "DRIVE", "48", "flow"],
  [8, false, true, "REGEN", "8.0", "good"],
  [0.2, false, true, "REGEN", "0.2", "good"],
  [0.2, false, false, "POWER IN", "0.2", "good"],
  [-0.2, false, true, "DRIVE", "0.2", "flow"],
  [0, false, true, "POWER", "0.0", "fg"],
  [-0.01, false, true, "POWER", "0.0", "fg"],
  [-0, false, true, "POWER", "0.0", "fg"],
  [15, true, false, "CHARGING", "15", "good"],
  [-5, true, false, "POWER OUT", "5.0", "flow"],
  [-0.2, false, false, "POWER OUT", "0.2", "flow"],
] as const) {
  const state = ridePowerState(key => (key === "pack_kw" ? value : read(key)), fresh, charging);
  assert.deepEqual(ridePowerDisplay(state, moving), { label, magnitude, color: `var(--${color})` });
}
for (const status of ["missing", "stale", "fault"] as const) {
  const state = ridePowerState(read, key => (key === "pack_kw" ? status : "fresh"), false);
  assert.deepEqual(ridePowerDisplay(state, true), {
    label: "POWER",
    magnitude: "—",
    color: status === "fault" ? "var(--bad)" : "var(--sub)",
  });
}
