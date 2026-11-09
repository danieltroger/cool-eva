// @ts-check
// Nine physical modules, eleven LMUs; mapping and provenance: docs/cell-module-map.md.
import { cellVoltageLayout } from "./cells.js";

export function packCellLayout() {
  return cellVoltageLayout().map(slot => ({
    key: slot.key,
    position: slot.position,
    module: Math.ceil(slot.position / CELLS_PER_PACK_MODULE),
    lmu: slot.module,
    cell: slot.cell,
  }));
}

export const PACK_MODULE_GRID = /** @type {const} */ ([
  [3, 2, 1],
  [4, 5, 6],
  [9, 8, 7],
]);
export const CELLS_PER_PACK_MODULE = 9;
/** @typedef {ReturnType<typeof packCellLayout>[number]} PackCell */

/** @param {PackCell[]} cells @param {number} index */
export function cellLmuBoundaries(cells, index) {
  const cell = cells[index];
  const previous = cells[index - 1];
  const next = cells[index + 1];
  return [
    !previous || previous.lmu !== cell.lmu ? "lmu-start" : "",
    !next || next.lmu !== cell.lmu ? "lmu-end" : "",
    index % 3 < 2 && next?.lmu !== cell.lmu ? "boundary-right" : "",
    index % 3 > 0 && previous?.lmu !== cell.lmu ? "boundary-left" : "",
    index < 6 && cells[index + 3].lmu !== cell.lmu ? "boundary-bottom" : "",
    index >= 3 && cells[index - 3].lmu !== cell.lmu ? "boundary-top" : "",
  ].filter(Boolean);
}

/** Only the caller's current accepted readings can choose a lowest cell. @param {number} moduleNumber @param {(key:string)=>number|null} read */
export function lowestModuleCell(moduleNumber, read) {
  const cells = packCellLayout().filter(cell => cell.module === moduleNumber);
  let selected = cells[0];
  let lowest = Infinity;
  for (const cell of cells) {
    const value = read(cell.key);
    if (value !== null && value < lowest) {
      selected = cell;
      lowest = value;
    }
  }
  return selected.position;
}

/** @param {number} position @param {number} direction */
export function stepCellPosition(position, direction) {
  return Math.max(1, Math.min(81, position + direction));
}
