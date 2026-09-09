import { LMUS_WITHOUT_BATTERY_TEMP, LMU_COUNT } from "../src/can/decode-bms.ts";
import { SIGNALS } from "../src/can/registry.ts";
import { MODULE_COUNT, MODULE_SENSORS, moduleTemperatureGrid, moduleTemperatureKey } from "../public/lib/cells.js";

// The Charge tab's module-temperature grid, checked from Node.
//
//   node --experimental-strip-types scripts/check-module-heatmap.ts
//
// Run by `npm test` via scripts/run-checks.ts. Takes no arguments.
//
// The grid has three cell states and only two of them are failures. Modules 6 and 8
// have BattTemp1Enabled=False, so 31 of the 33 positions are sensors and two are
// nothing at all — and until #187 an absent-by-design cell rendered exactly like a
// probe that had died, on the screen you read while a fast charge decides how long you
// stand at the charger. Telling those apart is the behaviour here, and it is invisible
// in both directions: a wrong "no sensor" mark hides a real dropout, and a wrong
// outline sends you looking for a fault the bike does not have.
//
//   §1 the keys the dashboard expects are exactly the keys the Pi can send
//   §2 the three states, driven through the real grid
//
// Node has no DOM, so this reaches the pure kernel rather than the drawn SVG:
// moduleTemperatureGrid() takes its reader as a parameter, the way packResistanceWith()
// does. What that leaves uncovered is whether the DOT is visibly different from the
// OUTLINE, which is a question about pixels and is answered by the screenshots the
// dashboard gate requires.

const failures: string[] = [];

function check(condition: boolean, description: string): void {
  if (condition) {
    console.log(`✓ ${description}`);
    return;
  }
  failures.push(description);
  console.log(`✗ ${description}`);
}

/**
 * The pack, written out rather than only imported — and then checked against the import.
 *
 * A check that derived these from the code under test would agree with it by
 * construction: §1's set equality is satisfied by two EMPTY sets, so break
 * moduleTemperatureKey() and strip perLmuSignals() and it goes green having asserted
 * nothing. That is the trap scripts/check-all-view-tiles.ts names in its own words.
 *
 * These two literals earn their place twice over, because since #187 they are also
 * RENDERED: the caption reads "31 of 31 · modules 6 & 8 have no battery sensor", so
 * pinning them here pins a sentence the rider reads. If the bike's BMS config ever
 * changes, verify the new numbers against it and update these — do not delete them.
 */
const SENSOR_COUNT = 31;
const MODULES_WITHOUT_BATTERY_SENSOR = [6, 8];

console.log("──── §1 the dashboard expects exactly what the Pi can send ────");

check(
  LMU_COUNT === MODULE_COUNT && MODULE_COUNT === 11,
  `both sides agree the pack has ${MODULE_COUNT} modules, and decode-bms.ts says ${LMU_COUNT}`
);

/** Every key the dashboard's grid will ask for, in the order it asks. */
const expectedKeys = new Set<string>();
for (let module = 1; module <= MODULE_COUNT; module++) {
  for (const sensor of MODULE_SENSORS) {
    const key = moduleTemperatureKey(module, sensor);
    if (key != null) {
      expectedKeys.add(key);
    }
  }
}

// Deliberately matched on the registry's own unit and group as well as its key: a
// signal filed under the wrong group is what check-preview-fixtures.ts was written for,
// and a temperature that arrived as, say, "mV" would be gated by a band meant for
// millivolts before it ever reached the grid.
const registryKeys = new Set(
  SIGNALS.filter(
    signal => /^lmu\d+_(bat1|pcb1|pcb2)_c$/.test(signal.key) && signal.unit === "°C" && signal.group === "battery"
  ).map(signal => signal.key)
);

const missingFromRegistry = [...expectedKeys].filter(key => !registryKeys.has(key));
const missingFromDashboard = [...registryKeys].filter(key => !expectedKeys.has(key));
check(
  missingFromRegistry.length === 0,
  `every key the grid asks for is declared in registry.ts${missingFromRegistry.length > 0 ? ` — ${missingFromRegistry.join(", ")} is not` : ""}`
);
check(
  missingFromDashboard.length === 0,
  `every module temperature the Pi sends has a cell${missingFromDashboard.length > 0 ? ` — ${missingFromDashboard.join(", ")} has none` : ""}`
);
check(
  expectedKeys.size === SENSOR_COUNT,
  `that set has ${expectedKeys.size} members, and the caption promises ${SENSOR_COUNT}`
);

const withoutBatterySensor = [];
for (let module = 1; module <= MODULE_COUNT; module++) {
  if (moduleTemperatureKey(module, "bat1") == null) {
    withoutBatterySensor.push(module);
  }
}
check(
  withoutBatterySensor.join(",") === MODULES_WITHOUT_BATTERY_SENSOR.join(","),
  `cells.js withholds a battery key for modules ${withoutBatterySensor.join(" & ")}`
);
check(
  [...LMUS_WITHOUT_BATTERY_TEMP].sort().join(",") === MODULES_WITHOUT_BATTERY_SENSOR.join(","),
  `and decode-bms.ts withholds the reading for the same two — the mirror cells.js only asked for in a comment`
);

console.log("\n──── §2 the three cell states ────");

/** A reader over a fixed set of readings, which is all the grid needs. */
function readerFor(readings: Map<string, number>): (key: string) => number | null {
  return key => readings.get(key) ?? null;
}

const everySensor = new Map<string, number>();
for (const key of expectedKeys) {
  everySensor.set(key, 40);
}

const healthy = moduleTemperatureGrid(readerFor(everySensor));
check(healthy.seen === SENSOR_COUNT, `with every sensor reporting the caption says ${healthy.seen} of ${SENSOR_COUNT}`);
check(healthy.expected === SENSOR_COUNT, `and counts against the pack's ${healthy.expected}, not against 33`);
check(healthy.rows.length === MODULE_COUNT, `the grid is ${healthy.rows.length} rows, one per module`);
check(
  healthy.modulesWithoutBatterySensor.join(",") === MODULES_WITHOUT_BATTERY_SENSOR.join(","),
  `and names modules ${healthy.modulesWithoutBatterySensor.join(" & ")} in the caption`
);

// Rows are 1-indexed by module; cells are in MODULE_SENSORS order, battery first.
const batteryCellOf = (grid: typeof healthy, module: number) => grid.rows[module - 1].cells[0];

for (const module of MODULES_WITHOUT_BATTERY_SENSOR) {
  const cell = batteryCellOf(healthy, module);
  check(
    cell.absent && cell.value === null,
    `module ${module}'s battery cell is absent, on a pack reporting everything`
  );
}
check(
  healthy.rows.flatMap(row => row.cells).filter(cell => cell.absent).length === MODULES_WITHOUT_BATTERY_SENSOR.length,
  `and nothing else on the grid is marked absent`
);

// The failure this whole change exists to make legible: a sensor that EXISTS and has
// stopped reporting. 0x663/0x664 have been observed never sampling some modules, and
// decode-bms.ts drops a byte outside [-40, 100] — the 122 °C pad — so this is a state
// the bike actually reaches, and it must not borrow the "no sensor" mark.
const droppedOut = new Map(everySensor);
droppedOut.delete("lmu4_bat1_c");
const withDropout = moduleTemperatureGrid(readerFor(droppedOut));
const dropped = batteryCellOf(withDropout, 4);
check(!dropped.absent && dropped.value === null, "a sensor that exists and stopped reporting is NOT marked absent");
check(
  withDropout.seen === SENSOR_COUNT - 1 && withDropout.expected === SENSOR_COUNT,
  `and the caption says ${withDropout.seen} of ${withDropout.expected}, so the gap is countable`
);
for (const module of MODULES_WITHOUT_BATTERY_SENSOR) {
  check(batteryCellOf(withDropout, module).absent, `module ${module} is still absent beside it, not merged with it`);
}

const silent = moduleTemperatureGrid(readerFor(new Map()));
check(
  silent.seen === 0 && silent.expected === SENSOR_COUNT,
  "with nothing on the bus the grid reports 0 seen and still expects 31 — the view's waiting branch"
);

console.log("");
if (failures.length > 0) {
  console.error(`✗ ${failures.length} failed:`);
  for (const description of failures) {
    console.error(`   ${description}`);
  }
  process.exit(1);
}
console.log("✓ module heatmap: 31 expected, 6 & 8 absent by config, a dropout stays a dropout");
