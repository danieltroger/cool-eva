// @ts-check
import { cellVoltageLayout } from "./cells.js";

/** No missing/rejected slot may shift another cell or keep a plausible bar. @param {(key:string)=>number|null} read @param {(key:string)=>import("./reading-status.js").ReadingStatus} status */
export function cellSnapshot(read, status) {
  const cells = cellVoltageLayout().map(slot => {
    const state = status(slot.key);
    return { ...slot, state, value: state === "fresh" ? read(slot.key) : null };
  });
  const values = cells.flatMap(cell => (cell.value === null ? [] : [cell.value]));
  const low = values.length ? Math.min(...values) : null;
  const high = values.length ? Math.max(...values) : null;
  return {
    cells,
    low,
    high,
    fresh: values.length,
    weakest: low === null ? null : (cells.find(cell => cell.value === low)?.position ?? null),
    strongest: high === null ? null : (cells.find(cell => cell.value === high)?.position ?? null),
    fault: cells.filter(cell => cell.state === "fault").length,
    stale: cells.filter(cell => cell.state === "stale").length,
    missing: cells.filter(cell => cell.state === "missing").length,
  };
}
