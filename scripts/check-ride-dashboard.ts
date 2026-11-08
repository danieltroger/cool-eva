import assert from "node:assert/strict";
import { rideThermal } from "../public/lib/ride-thermal.js";
import type { ReadingStatus } from "../public/lib/reading-status.js";

const readings: Record<string, number> = { coolant_in: 36.5, coolant_out: 41.2, pack_a: -142 };
const read = (key: string) => readings[key] ?? null;
const fresh = (_key: string): ReadingStatus => "fresh";
const normal = rideThermal(read, fresh, 73, true);
assert.ok(Math.abs((normal.delta ?? 0) - 4.7) < 1e-12);
assert.equal(normal.heatWatts, 1471.972);
assert.ok(Math.abs((normal.removalWatts ?? 0) - 4427.791666666667) < 1e-6);
assert.ok(Math.abs((normal.heatFraction ?? 0) - 1471.972 / 4427.791666666667) < 1e-12);
assert.equal(
  rideThermal(key => (key === "pack_a" ? 142 : read(key)), fresh, 73, true).heatWatts,
  normal.heatWatts,
  "Regeneration still dissipates I²R heat."
);
assert.equal(
  rideThermal(read, fresh, 100, true).heatWatts,
  2016.4,
  "The live resistance estimate must reach the displayed heat model."
);

for (const key of ["coolant_in", "coolant_out", "pack_a"]) {
  for (const quality of ["fault", "stale", "missing"] as const) {
    const result = rideThermal(read, signal => (signal === key ? quality : "fresh"), 73, true);
    if (key === "pack_a") {
      assert.equal(result.heatWatts, null);
      assert.equal(result.heatStatus, quality);
      assert.equal(result.removalWatts, normal.removalWatts, "Probe-derived removal remains independent.");
    } else {
      assert.equal(result.delta, null);
      assert.equal(result.removalWatts, null);
      assert.equal(result.deltaStatus, quality);
      assert.equal(result.heatWatts, normal.heatWatts, "A failed probe cannot erase independent battery heat.");
    }
    assert.equal(result.heatFraction, null, "A comparison needs both accepted inputs.");
  }
  const absent = rideThermal(signal => (signal === key ? null : read(signal)), fresh, 73, true);
  assert.equal(key === "pack_a" ? absent.heatStatus : absent.deltaStatus, "missing");
}
const disabled = rideThermal(read, fresh, 73, false);
assert.equal(disabled.delta, null);
assert.equal(disabled.deltaStatus, "missing");
assert.equal(disabled.removalWatts, null);
assert.equal(disabled.heatWatts, normal.heatWatts);
assert.equal(disabled.heatFraction, null);

const negative = rideThermal(key => (key === "coolant_out" ? 35 : read(key)), fresh, 73, true);
assert.equal(negative.delta, -1.5, "A negative measured ΔT must remain signed.");
assert.ok((negative.removalWatts ?? 0) < 0, "Do not clamp negative removal into plausible cooling.");
assert.equal(negative.heatFraction, 1, "Positive heat with negative removal fills the adverse meter.");
const zeroRemoval = (key: string) => (key === "coolant_out" ? 36.5 : read(key));
assert.equal(rideThermal(zeroRemoval, fresh, 73, true).heatFraction, 1);
assert.equal(
  rideThermal(key => (key === "pack_a" ? 0 : zeroRemoval(key)), fresh, 73, true).heatFraction,
  null,
  "Zero divided by zero is unavailable, not a fabricated percentage."
);
assert.equal(rideThermal(key => (key === "pack_a" ? 0 : read(key)), fresh, 73, true).heatFraction, 0);
const excess = rideThermal(key => (key === "pack_a" ? -500 : read(key)), fresh, 73, true);
assert.equal(excess.heatWatts, 18250, "The numeric estimate is never clipped to the meter.");
assert.equal(excess.heatFraction, 1);
assert.equal(rideThermal(read, key => (key === "coolant_in" ? "fault" : "missing"), 73, true).deltaStatus, "fault");

console.log(
  "✓ Ride thermal: signed ΔT/removal, live I²R, independent quality gates, hardware off and honest meter limits"
);
