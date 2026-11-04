import assert from "node:assert/strict";
import van from "../public/vendor/van-1.6.1.js";
import { SIGNALS } from "../src/can/registry.ts";
import { ON_DEMAND_KEYS } from "../public/lib/generated-bounds.js";
import { FAULT_MEMORY_MS, readingHasFault, readingIsStale, readingStatus } from "../public/lib/reading-status.js";
import { apply, chartTick, connection, signalState } from "../public/lib/store.js";

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

apply({
  type: "patch",
  ts: 400_000,
  signals: { ambient_temp: { value: 17, unit: "°C", group: "ambient", ts: 400_000 } },
});
let faultBindingRuns = 0;
van.derive(() => {
  faultBindingRuns++;
  return readingHasFault("ambient_temp");
});
const initialRuns = faultBindingRuns;
apply({
  type: "patch",
  ts: 400_001,
  signals: { ambient_temp: { value: 18, unit: "°C", group: "ambient", ts: 400_001 } },
});
await new Promise(resolve => setTimeout(resolve, 25));
assert.equal(faultBindingRuns, initialRuns, "A fault-free caption must not subscribe to signal values.");
apply({
  type: "patch",
  ts: 400_002,
  signals: { ambient_temp: { value: 65535, unit: "°C", group: "ambient", ts: 400_002 } },
});
await new Promise(resolve => setTimeout(resolve, 25));
const faultRuns = faultBindingRuns;
assert.ok(faultRuns > initialRuns, "New faults must still trigger the caption.");
apply({
  type: "patch",
  ts: 400_003,
  signals: { ambient_temp: { value: 19, unit: "°C", group: "ambient", ts: 400_003 } },
});
await new Promise(resolve => setTimeout(resolve, 25));
assert.equal(faultBindingRuns, faultRuns, "Fault memory must sample values without subscribing to their updates.");
chartTick.val++;
await new Promise(resolve => setTimeout(resolve, 25));
assert.ok(faultBindingRuns > faultRuns, "The slow pulse must still re-evaluate fault expiry/recovery.");
