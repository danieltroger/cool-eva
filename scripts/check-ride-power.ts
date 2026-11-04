import assert from "node:assert/strict";
import { powerPosition, ridePowerState } from "../public/lib/ride-power-state.js";
import type { ReadingStatus } from "../public/lib/reading-status.js";

const readings: Record<string, number> = { pack_kw: -48.3, pack_v: 340, allowed_discharge_a: 210, allowed_regen_a: 55 };
const read = (key: string) => readings[key] ?? null;
const fresh = (_key: string): ReadingStatus => "fresh";
const normal = ridePowerState(read, fresh, false);
assert.equal(normal.drive.kilowatts, 71.4);
assert.equal(normal.regen.kilowatts, 18.7);
assert.equal(normal.value, -48.3);
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
assert.equal(charge.status, "Charging · riding limits off");
assert.equal(charge.excess, false);
assert.equal(charge.value, -48.3, "Charging must preserve signed measured power.");
assert.equal(
  ridePowerState(read, key => (key === "pack_kw" ? "fault" : "fresh"), true).status,
  "Charging · power fault · riding limits off"
);
console.log(
  "✓ Ride fixed scale, sign, measured voltage, zero, unknown/fault/stale states, opposite-limit retention and charging"
);
