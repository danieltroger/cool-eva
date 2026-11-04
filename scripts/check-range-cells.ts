import assert from "node:assert/strict";
import { cellVoltageLayout, CELL_COUNT } from "../public/lib/cells.js";
import { cellSnapshot } from "../public/lib/cell-snapshot.js";
import type { ReadingStatus } from "../public/lib/reading-status.js";
import { apply, connection } from "../public/lib/store.js";
import { rangeInputStatus, rangeValue } from "../public/lib/range-readings.js";

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
const read = (key: string) => values.get(key) ?? null;
const fresh = (_key: string): ReadingStatus => "fresh";
const normal = cellSnapshot(read, fresh);
assert.equal(normal.fresh, 81);
assert.equal(normal.low, 3120);
assert.equal(normal.high, 3158);
assert.equal(normal.weakest, 1);
assert.equal(normal.strongest, 81);
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
  assert.equal(snapshot.weakest, 2);
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
connection.val = "live";
apply({
  type: "snapshot",
  ts: 1_000_000,
  signals: { allowed_discharge_a: { value: 0, unit: "A", group: "battery", ts: 1_000_000 } },
});
assert.equal(rangeValue("allowed_discharge_a"), 0, "A zero allowance remains a real reading.");
assert.equal(rangeInputStatus(["allowed_discharge_a"]), "fresh");
apply({
  type: "patch",
  ts: 1_000_001,
  signals: { allowed_discharge_a: { value: 65535, unit: "A", group: "battery", ts: 1_000_001 } },
});
assert.equal(rangeInputStatus(["allowed_discharge_a"]), "fault");
assert.equal(rangeValue("allowed_discharge_a"), null, "A rejected allowance cannot display the last plausible zero.");
console.log(
  "✓ All 81 physical slots, pack/module ordering, true extrema, complete/missing/stale/fault and balanced cells"
);
