import { remainingWh, rollingConsumption, rollingRangeKm, headroomMvSampled } from "../public/lib/derive.js";
import { worstStatus } from "../public/lib/reading-status.js";
import assert from "node:assert/strict";
import { cellVoltageLayout, CELL_COUNT } from "../public/lib/cells.js";
import { cellSnapshot } from "../public/lib/cell-snapshot.js";
import type { ReadingStatus } from "../public/lib/reading-status.js";
import { apply, connection } from "../public/lib/store.js";
import { freshValue } from "../public/lib/reading-status.js";
import { energyEmpty, compensatedThresholds } from "../public/lib/range-readings.js";

const slots = cellVoltageLayout();
assert.equal(CELL_COUNT, 81);
assert.equal(slots.length, 81);
assert.deepEqual(
  slots.map(slot => slot.position),
  Array.from({ length: 81 }, (_, index) => index + 1)
);
assert.equal(new Set(slots.map(slot => slot.key)).size, 81);
assert.deepEqual(
  [slots[0].key, slots[7].key, slots[8].key, slots[31].key, slots[32].key, slots[80].key],
  ["lmu1_cell1_mv", "lmu1_cell8_mv", "lmu2_cell1_mv", "lmu4_cell8_mv", "lmu5_cell1_mv", "lmu11_cell7_mv"]
);
assert.deepEqual(
  Array.from({ length: 11 }, (_, index) => slots.filter(slot => slot.module === index + 1).length),
  [8, 8, 8, 8, 7, 7, 7, 7, 7, 7, 7]
);
const values = new Map(slots.map(slot => [slot.key, slot.position === 1 ? 3120 : slot.position === 81 ? 3158 : 3135]));
for (const [key, value] of [
  ["cell_min_mv", 3125],
  ["cell_max_mv", 3155],
  ["cell_spread_mv", 30],
  ["cell_lowest_v_idx", 7],
  ["cell_highest_v_idx", 19],
] as const) {
  values.set(key, value);
}
const read = (key: string) => values.get(key) ?? null;
const fresh = (_key: string): ReadingStatus => "fresh";
const normal = cellSnapshot(read, fresh);
assert.equal(normal.fresh, 81);
assert.equal(normal.low, 3125);
assert.equal(normal.high, 3155);
assert.equal(normal.spread, 30);
assert.equal(normal.weakest, 7);
assert.equal(normal.strongest, 19);
assert.equal(normal.displayLow, 3120);
assert.equal(normal.displayHigh, 3158);
for (const state of ["missing", "stale", "fault"] as const) {
  const snapshot = cellSnapshot(read, key => (key === slots[0].key ? state : "fresh"));
  assert.equal(snapshot.cells.length, 81);
  assert.equal(
    snapshot.cells[0].value,
    null,
    "Rejected or unavailable slots cannot keep their last plausible voltage."
  );
  assert.equal(snapshot.cells[0].state, state);
  assert.equal(snapshot.cells[1].position, 2);
  assert.equal(snapshot.cells[1].key, "lmu1_cell2_mv");
  assert.equal(snapshot.weakest, 7, "Missing per-cell readings cannot change the BMS's index.");
  assert.equal(snapshot.fresh, 80);
  assert.equal(snapshot[state], 1);
}
const empty = cellSnapshot(
  () => null,
  () => "missing"
);
assert.equal(empty.low, null);
assert.equal(empty.high, null);
assert.equal(empty.weakest, null);
assert.equal(empty.strongest, null);
assert.equal(empty.missing, 81);
const equal = cellSnapshot(() => 3300, fresh);
assert.equal(equal.high, equal.low, "A balanced pack must have zero observed spread.");
for (const state of ["missing", "stale", "fault"] as const) {
  const unavailableSummary = cellSnapshot(read, key => (key.startsWith("cell_") ? state : "fresh"));
  assert.deepEqual(
    [
      unavailableSummary.low,
      unavailableSummary.high,
      unavailableSummary.spread,
      unavailableSummary.weakest,
      unavailableSummary.strongest,
    ],
    [null, null, null, null, null],
    "Pack summaries never fall back to independently sampled per-cell readings."
  );
  assert.equal(unavailableSummary.fresh, 81);
}
connection.val = "live";
apply({
  type: "snapshot",
  ts: 1_000_000,
  signals: { allowed_discharge_a: { value: 0, unit: "A", group: "battery", ts: 1_000_000 } },
});
assert.equal(freshValue("allowed_discharge_a"), 0, "A zero allowance remains a real reading.");
assert.equal(worstStatus(["allowed_discharge_a"]), "fresh");
apply({
  type: "patch",
  ts: 1_000_001,
  signals: { allowed_discharge_a: { value: 65535, unit: "A", group: "battery", ts: 1_000_001 } },
});
assert.equal(worstStatus(["allowed_discharge_a"]), "fault");
assert.equal(freshValue("allowed_discharge_a"), null, "A rejected allowance cannot display the last plausible zero.");
console.log(
  "✓ All 81 physical slots, pack/module ordering, current BMS summaries, complete/missing/stale/fault and balanced cells"
);

const sampledKeys: string[] = [];
const sampledRead = (key: string) => {
  sampledKeys.push(key);
  return key === "bms_remaining_energy_wh" ? 4800 : key === "odometer_can_km" ? 40000 : null;
};
assert.equal(remainingWh(sampledRead), 4800);
assert.equal(
  remainingWh(key => (key === "residual_energy_wh" ? 2000 : null)),
  2000
);
sampledKeys.length = 0;
assert.equal(rollingConsumption(1_000_000, sampledRead).state, "waiting");
assert.ok(sampledKeys.includes("odometer_can_km"));
sampledKeys.length = 0;
assert.equal(rollingRangeKm(1_000_000, sampledRead), null);
assert.ok(
  sampledKeys.includes("odometer_can_km") && sampledKeys.includes("bms_remaining_energy_wh"),
  "Range sampling propagates the caller's reader through both operands."
);

for (const [soc, age, expected] of [
  [18, 0, false],
  [0, 30_000, false],
  [0, 0, true],
] as const) {
  apply({
    type: "patch",
    ts: 1_000_002,
    signals: {
      bms_remaining_energy_wh: { value: 0, unit: "Wh", group: "battery", ts: 1_000_002 },
      residual_energy_wh: { value: 0, unit: "Wh", group: "battery", ts: 1_000_002 },
      soc: { value: soc, unit: "%", group: "battery", ts: 1_000_002 - age },
    },
  });
  assert.equal(energyEmpty(), expected, "Empty requires two zero counters and fresh zero SOC.");
}

assert.deepEqual(compensatedThresholds(2900, 2750, -13.3, 119), { limp: 2880, stop: 2730 });
const pull = compensatedThresholds(2900, 2750, -377, 132);
assert.deepEqual([2988 - pull.limp, 2988 - pull.stop], [711, 853]);
assert.deepEqual(compensatedThresholds(2900, 2750, null, 132), { limp: 2900, stop: 2750 });
apply({
  type: "patch",
  ts: 1_000_003,
  signals: Object.fromEntries(
    Object.entries({ cell_min_mv: 2988, cell_cutoff_mv: 2900, pack_a: -377, limp_pack_res: 132 }).map(
      ([key, value]) => [key, { value, unit: "", group: "battery", ts: 1_000_003 }]
    )
  ),
});
assert.equal(headroomMvSampled(), 711);
