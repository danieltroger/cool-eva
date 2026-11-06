// @ts-check
import { cellVoltageLayout } from "./cells.js";

/** No missing/rejected slot may shift another cell or keep a plausible bar. @param {(key:string)=>number|null} read @param {(key:string)=>import("./reading-status.js").ReadingStatus} status */
export function cellSnapshot(read, status) {
  const cells = cellVoltageLayout().map(slot => {
    const state = status(slot.key);
    return { ...slot, state, value: state === "fresh" ? read(slot.key) : null };
  });
  const values = cells.flatMap(cell => (cell.value === null ? [] : [cell.value]));
  /** @param {string} key */
  const summary = key => (status(key) === "fresh" ? read(key) : null);
  const low = summary("cell_min_mv");
  const high = summary("cell_max_mv");
  return {
    cells,
    low,
    high,
    spread: summary("cell_spread_mv"),
    displayLow: values.length ? Math.min(...values) : null,
    displayHigh: values.length ? Math.max(...values) : null,
    fresh: values.length,
    weakest: summary("cell_lowest_v_idx"),
    strongest: summary("cell_highest_v_idx"),
    fault: cells.filter(cell => cell.state === "fault").length,
    stale: cells.filter(cell => cell.state === "stale").length,
    missing: cells.filter(cell => cell.state === "missing").length,
  };
}
