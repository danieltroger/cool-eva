// @ts-check
// Server-clock fault memory and measured/onDemand freshness: docs/reading-status.md.
import { ON_DEMAND_KEYS } from "./generated-bounds.js";
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
  return sampled ? isStaleSampled(key, STALE_MS) : isStale(key, STALE_MS);
}
