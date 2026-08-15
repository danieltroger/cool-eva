// @ts-check

// How the per-cell voltage signals are named, and how to enumerate them.
//
// One module owns this so that nothing else in public/ has to know the shape of a
// cell key. The strip used to build its own — `cell_v_lmu3_c5` against the
// decoder's `lmu3_cell5_mv` — and reported "0 of 81" for a whole ride while the
// ALL view, which renders whatever arrives, showed all 81. Fixing the string in
// two places would have left the same trap set; there is now one copy, imported by
// both the strip and the plausibility gate.
//
// The pattern must stay in step with `cellVoltageKey()` in src/can/decode-bms.ts.
// That is the only cross-file agreement left, and it is the one that cannot be
// removed without a build step.

/** Matches the decoder's cellVoltageKey(): lmu<module>_cell<n>_mv. */
export const CELL_VOLTAGE_PATTERN = /^lmu(\d+)_cell(\d+)_mv$/;

/**
 * Series positions in the pack: 11 modules, four with 8 cells and seven with 7.
 * Mirrors cellsInLmu() in src/can/decode-bms.ts.
 */
export const CELL_COUNT = 81;

/**
 * The per-cell voltage keys among `keys`, in pack order.
 *
 * Sorted numerically by module then cell: a plain string sort puts lmu10 between
 * lmu1 and lmu2, which would silently scramble which bar is which cell — the strip
 * would still look plausible while pointing at the wrong module.
 * @param {string[]} keys
 * @returns {string[]}
 */
export function cellVoltageKeys(keys) {
  const found = [];
  for (const key of keys) {
    const match = CELL_VOLTAGE_PATTERN.exec(key);
    if (match) {
      found.push({ key, lmu: Number(match[1]), cell: Number(match[2]) });
    }
  }
  found.sort((a, b) => (a.lmu === b.lmu ? a.cell - b.cell : a.lmu - b.lmu));
  return found.map(entry => entry.key);
}

/** The three temperature sensors each module reports, in the order they are shown. */
export const MODULE_SENSORS = /** @type {const} */ (["bat1", "pcb1", "pcb2"]);

/** Modules 6 and 8 have no battery sensor — mirrors LMUS_WITHOUT_BATTERY_TEMP. */
const MODULES_WITHOUT_BATTERY_SENSOR = [6, 8];

/** Modules in the pack, 1-indexed. */
export const MODULE_COUNT = 11;

/** Widest module. Mirrors cellsInLmu() in src/can/decode-bms.ts: 8 for modules 1-4. */
export const MAX_CELLS_PER_MODULE = 8;

/**
 * How many cells a module has. Mirrors cellsInLmu().
 * @param {number} moduleNumber
 */
export function cellsInModule(moduleNumber) {
  return moduleNumber <= 4 ? 8 : 7;
}

/**
 * The key a module's temperature sensor reports under, or null where that sensor
 * does not exist. Mirrors `lmuTemperatureKey()` in src/can/decode-bms.ts, which
 * owns the naming — see the note at the top of this file.
 * @param {number} moduleNumber
 * @param {(typeof MODULE_SENSORS)[number]} sensor
 * @returns {string | null}
 */
export function moduleTemperatureKey(moduleNumber, sensor) {
  if (sensor === "bat1" && MODULES_WITHOUT_BATTERY_SENSOR.includes(moduleNumber)) {
    return null;
  }
  return `lmu${moduleNumber}_${sensor}_c`;
}
