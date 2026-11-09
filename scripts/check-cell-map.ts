import assert from "node:assert/strict";
import {
  PACK_MODULE_GRID,
  packCellLayout,
  cellLmuBoundaries,
  lowestModuleCell,
  stepCellPosition,
} from "../public/lib/pack-layout.js";
import { cellMapReading, cellMapColour, cellMapAge, cellAgeText } from "../public/lib/cell-map.js";
import { apply, connection } from "../public/lib/store.js";
import type { DashboardMessage } from "../src/ws.ts";

const cells = packCellLayout();
assert.deepEqual(PACK_MODULE_GRID, [
  [3, 2, 1],
  [4, 5, 6],
  [9, 8, 7],
]);
assert.equal(cells.length, 81);
assert.equal(new Set(cells.map(cell => cell.key)).size, 81);
assert.deepEqual(
  cells.map(cell => cell.position),
  Array.from({ length: 81 }, (_, index) => index + 1)
);
const expectedRuns = [
  [
    [1, 1, 8],
    [2, 1, 1],
  ],
  [
    [2, 2, 8],
    [3, 1, 2],
  ],
  [
    [3, 3, 8],
    [4, 1, 3],
  ],
  [
    [4, 4, 8],
    [5, 1, 4],
  ],
  [
    [5, 5, 7],
    [6, 1, 6],
  ],
  [
    [6, 7, 7],
    [7, 1, 7],
    [8, 1, 1],
  ],
  [
    [8, 2, 7],
    [9, 1, 3],
  ],
  [
    [9, 4, 7],
    [10, 1, 5],
  ],
  [
    [10, 6, 7],
    [11, 1, 7],
  ],
];
for (const [index, runs] of expectedRuns.entries()) {
  const moduleCells = cells.filter(cell => cell.module === index + 1);
  assert.equal(moduleCells.length, 9);
  assert.deepEqual(
    moduleCells.map(cell => [cell.lmu, cell.cell]),
    runs.flatMap(([lmu, first, last]) => Array.from({ length: last - first + 1 }, (_, offset) => [lmu, first + offset]))
  );
  assert.ok(moduleCells.every(cell => cell.key === `lmu${cell.lmu}_cell${cell.cell}_mv`));
  const classes = moduleCells.map((_, cellIndex) => cellLmuBoundaries(moduleCells, cellIndex));
  for (const [cellIndex, cell] of moduleCells.entries()) {
    if (cellIndex % 3 < 2) {
      const different = cell.lmu !== moduleCells[cellIndex + 1].lmu;
      assert.equal(classes[cellIndex].includes("boundary-right"), different);
      assert.equal(classes[cellIndex + 1].includes("boundary-left"), different);
    }
    if (cellIndex < 6) {
      const different = cell.lmu !== moduleCells[cellIndex + 3].lmu;
      assert.equal(classes[cellIndex].includes("boundary-bottom"), different);
      assert.equal(classes[cellIndex + 3].includes("boundary-top"), different);
    }
  }
}
const moduleSix = cells.filter(cell => cell.module === 6);
assert.deepEqual(
  moduleSix
    .filter((_, index) => cellLmuBoundaries(moduleSix, index).includes("lmu-start"))
    .map(cell => [cell.position, cell.lmu, cell.cell]),
  [
    [46, 6, 7],
    [47, 7, 1],
    [54, 8, 1],
  ],
  "M6 spans three LMUs, including their one-cell edge runs."
);
assert.equal(
  lowestModuleCell(6, key => (key === "lmu7_cell2_mv" ? 3100 : 3300)),
  48
);
assert.equal(
  lowestModuleCell(6, () => null),
  46,
  "No current eligible voltage falls back to the first position."
);
assert.equal(
  lowestModuleCell(1, key => (key === "lmu1_cell4_mv" ? null : key === "lmu1_cell5_mv" ? 3200 : 3300)),
  5,
  "An unavailable lower historical reading cannot win selection."
);
for (const [position, direction, expected] of [
  [1, -1, 1],
  [1, 1, 2],
  [9, 1, 10],
  [46, 1, 47],
  [53, 1, 54],
  [80, 1, 81],
  [81, 1, 81],
]) {
  assert.equal(stepCellPosition(position, direction), expected);
}
assert.deepEqual([0, 8000, 8001, 59000, 60000, 180000, 3600000, Infinity].map(cellAgeText), [
  "now",
  "now",
  "8s",
  "59s",
  "1m",
  "3m",
  "1h",
  "—",
]);

const timestamp = 1_000_000;
connection.val = "live";
const snapshot: DashboardMessage = {
  type: "snapshot",
  ts: timestamp,
  signals: {
    lmu_cell_mux: { value: 1, unit: "", group: "bms", ts: timestamp },
    lmu1_cell1_mv: { value: 3300, unit: "mV", group: "cells", ts: timestamp },
    lmu1_cell4_mv: { value: 3000, unit: "mV", group: "cells", ts: timestamp - 90000 },
    lmu7_cell2_mv: { value: 3405, unit: "mV", group: "cells", ts: timestamp },
    lmu7_bat1_c: { value: 44, unit: "°C", group: "battery", ts: timestamp },
    lmu1_bat1_c: { value: 39, unit: "°C", group: "battery", ts: timestamp - 180000 },
    cell_max_mv: { value: 3320, unit: "mV", group: "cells", ts: timestamp },
  },
};
apply(snapshot);
const first = cellMapReading(cells[0], "balance");
assert.equal(first.value, 3300);
assert.equal(first.current, true);
assert.equal(first.state, "fresh");
assert.equal(cellMapColour(first, "balance", 3320), "color-mix(in srgb,var(--warn) 50%,var(--good))");
assert.equal(
  cellMapColour(first, "balance", null),
  "var(--sub)",
  "An unavailable reference cannot become an invented zero gap."
);
const aboveReference = cellMapReading(cells[47], "balance");
assert.equal(aboveReference.value, 3405);
assert.equal(
  cellMapColour(aboveReference, "balance", 3320),
  "color-mix(in srgb,var(--warn) 0%,var(--good))",
  "A current sample above the BMS maximum keeps its actual voltage and zero relative gap."
);
const temperature = cellMapReading(cells[47], "temperature");
assert.equal(temperature.key, "lmu7_bat1_c");
assert.equal(temperature.value, 44);
assert.equal(cellMapColour(temperature, "temperature", null), "color-mix(in srgb,var(--warn) 50%,var(--cold))");
for (const position of [40, 46, 54, 60]) {
  const absent = cellMapReading(cells[position - 1], "temperature");
  assert.equal(absent.state, "absent");
  assert.equal(absent.key, null);
  assert.equal(absent.value, null);
  assert.equal(cellMapColour(absent, "temperature", 3320), "var(--tile)");
}
const held = cellMapReading(cells[3], "balance");
assert.equal(held.value, 3000);
assert.equal(held.state, "fresh");
assert.equal(held.current, false);
assert.equal(cellMapColour(held, "balance", 3320), "var(--sub)");
assert.equal(cellMapAge([held]), "1m");
assert.equal(cellMapAge([cellMapReading(cells[0], "temperature")]), "3m");
assert.equal(cellMapAge([first, held]), "1m", "Mixed-age latest readings cannot be labelled now.");
const missing = cellMapReading(cells[80], "balance");
assert.equal(missing.state, "missing");
assert.equal(missing.value, null);
assert.equal(cellMapAge([missing]), "—");
const rejection: DashboardMessage = {
  type: "patch",
  ts: timestamp + 100,
  signals: { lmu1_cell1_mv: { value: 65535, unit: "mV", group: "cells", ts: timestamp + 100 } },
};
apply(rejection);
const fault = cellMapReading(cells[0], "balance");
assert.equal(fault.state, "fault");
assert.equal(fault.value, null);
assert.equal(cellMapColour(fault, "balance", 3320), "var(--bad)");
assert.equal(cellMapAge([fault]), "fault");
connection.val = "offline";
const stale = cellMapReading(cells[47], "balance");
assert.equal(stale.state, "stale");
assert.equal(stale.value, null);
assert.equal(cellMapAge([stale]), "stale");
console.log(
  "✓ nine physical modules, eleven LMUs, all 81 stable slots, exact boundaries, bounded selection, missing sensors, faults, held ages and neutral old/reference-less colour"
);
