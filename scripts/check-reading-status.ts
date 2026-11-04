import assert from "node:assert/strict";
import { SIGNALS } from "../src/can/registry.ts";
import { ON_DEMAND_KEYS } from "../public/lib/generated-bounds.js";
import { FAULT_MEMORY_MS, readingHasFault, readingIsStale, readingStatus } from "../public/lib/reading-status.js";
import { apply, connection, signalState } from "../public/lib/store.js";

assert.deepEqual(
  [...ON_DEMAND_KEYS].sort(),
  SIGNALS.filter(signal => signal.onDemand)
    .map(signal => signal.key)
    .sort()
);
connection.val = "live";
apply({
  type: "snapshot",
  ts: 100_000,
  signals: {
    fan_target_pct: { value: 68, unit: "%", group: "fan", ts: 1 },
    coolant_in: { value: 36.5, unit: "°C", group: "coolant", ts: 1 },
  },
});
assert.equal(readingStatus("fan_target_pct"), "fresh");
assert.equal(readingStatus("coolant_in"), "stale");
signalState("fan_measured_rpm").val = { value: 1200, unit: "rpm", group: "fan", ts: 1 };
assert.equal(
  readingIsStale("fan_measured_rpm"),
  true,
  "A future measured fan sensor must not inherit a prefix exemption."
);
connection.val = "offline";
assert.equal(readingStatus("fan_target_pct"), "stale");
connection.val = "live";
signalState("fan_target_pct").val = null;
assert.equal(readingStatus("fan_target_pct"), "missing");
apply({
  type: "patch",
  ts: 100_001,
  signals: { fan_target_pct: { value: 150, unit: "%", group: "fan", ts: 100_001 } },
});
assert.equal(readingStatus("fan_target_pct"), "fault");
assert.equal(FAULT_MEMORY_MS, 60_000);
for (const [timestamp, value, expected] of [
  [200_000, -242, "fault"],
  [200_100, 36.5, "fault"],
  [200_000 + FAULT_MEMORY_MS - 1, 36.5, "fault"],
  [200_000 + FAULT_MEMORY_MS, 36.5, "fresh"],
] as const) {
  apply({
    type: "patch",
    ts: timestamp,
    signals: { coolant_in: { value, unit: "°C", group: "coolant", ts: timestamp } },
  });
  assert.equal(readingStatus("coolant_in"), expected);
  assert.equal(readingStatus("coolant_in", true), expected);
}
apply({
  type: "patch",
  ts: 300_000,
  signals: { coolant_in: { value: -242, unit: "°C", group: "coolant", ts: 300_000 } },
});
apply({ type: "patch", ts: 300_000 + FAULT_MEMORY_MS + 1, signals: {} });
assert.equal(readingHasFault("coolant_in"), true, "The newest rejected sample cannot expire into a plausible reading.");
console.log(
  "✓ Registry-derived onDemand metadata, held commands, real/future fan sensors, missing/fault states and link liveness"
);
