// @ts-check
// Server-clock fault memory and measured/onDemand freshness: docs/reading-status.md.
import { DISPLAY_FRESHNESS, ON_DEMAND_KEYS } from "./generated-bounds.js";
import {
  chartTick,
  connection,
  faultState,
  isStale,
  isStaleSampled,
  peek,
  peekServerTime,
  signalState,
  valueOf,
} from "./store.js";

const onDemand = new Set(ON_DEMAND_KEYS);
export const STALE_MS = 8000;
// Measured rotation budgets, kept separate for a future faster BMS config: docs/reading-status.md.
export const LMU_CELLS_1_TO_3_MAX_AGE_MS = 15_000;
export const LMU_CELLS_4_TO_8_MAX_AGE_MS = 715_000;
export const MODULE_TEMPERATURE_MAX_AGE_MS = 1_570_000;
const displayMaxAge = {
  "lmu-cells-1-to-3": LMU_CELLS_1_TO_3_MAX_AGE_MS,
  "lmu-cells-4-to-8": LMU_CELLS_4_TO_8_MAX_AGE_MS,
  "module-temperature": MODULE_TEMPERATURE_MAX_AGE_MS,
};
export const FAULT_MEMORY_MS = 60_000;
/** @typedef {"fresh" | "missing" | "stale" | "fault"} ReadingStatus */

/** @param {string} key @param {boolean} [sampled] @returns {ReadingStatus} */
export function readingStatus(key, sampled = false) {
  const reading = sampled ? signalState(key).rawVal : signalState(key).val;
  if (readingHasFault(key, sampled)) return "fault";
  if (!reading) return "missing";
  return readingIsStale(key, sampled) ? "stale" : "fresh";
}

/** @param {string} key @param {boolean} [sampled] */
export function freshValue(key, sampled = false) {
  return readingStatus(key, sampled) === "fresh" ? (sampled ? peek(key) : valueOf(key)) : null;
}

/** @param {string[]} keys @param {boolean} [sampled] @param {(key:string,sampled?:boolean)=>ReadingStatus} [status] @returns {ReadingStatus} */
export function worstStatus(keys, sampled = false, status = readingStatus) {
  const states = keys.map(key => status(key, sampled));
  return states.includes("fault")
    ? "fault"
    : states.includes("missing")
      ? "missing"
      : states.includes("stale")
        ? "stale"
        : "fresh";
}

/** @param {ReadingStatus} state @param {string} [missing] */
export function statusWord(state, missing = "—") {
  return state === "fresh" ? "—" : state === "missing" ? missing : state;
}

/** @param {string} key @param {boolean} [sampled] */
export function readingHasFault(key, sampled = false) {
  const fault = sampled ? faultState(key).rawVal : faultState(key).val;
  if (!fault) return false;
  // Both timestamps use the server clock. The slow pulse expires memory without a frame-rate subscription.
  if (!sampled) {
    chartTick.val;
  }
  // The pulse samples the last value/time; subscribing here would redraw pair captions on every sample.
  const value = peek(key);
  const timestamp = signalState(key).rawVal?.ts;
  return value === null || fault.ts >= (timestamp ?? -Infinity) || peekServerTime() - fault.ts < FAULT_MEMORY_MS;
}

/** @param {string} key @param {boolean} [sampled] */
export function readingIsStale(key, sampled = false) {
  if (onDemand.has(key)) {
    const reading = sampled ? signalState(key).rawVal : signalState(key).val;
    const link = sampled ? connection.rawVal : connection.val;
    return reading === null || link !== "live";
  }
  const stale = sampled ? isStaleSampled : isStale;
  const freshnessClass = DISPLAY_FRESHNESS[key];
  if (freshnessClass) {
    return stale(key, displayMaxAge[freshnessClass]) || stale("lmu_cell_mux", STALE_MS);
  }
  return stale(key, STALE_MS);
}

/** Provisional colour policy: held values stay visible, but only current samples carry colour.
 * @param {string} key @param {boolean} [sampled] */
export function readingCanColour(key, sampled = false) {
  return readingStatus(key, sampled) === "fresh" && !(sampled ? isStaleSampled : isStale)(key, STALE_MS);
}
