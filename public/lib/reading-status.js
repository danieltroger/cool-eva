// @ts-check
import { ON_DEMAND_KEYS } from "./generated-bounds.js";
import { connection, faultState, isStale, isStaleSampled, signalState } from "./store.js";
import { STALE_MS } from "./tiles.js";

const onDemand = new Set(ON_DEMAND_KEYS);
/** @typedef {"fresh" | "missing" | "stale" | "fault"} ReadingStatus */

/** @param {string} key @param {boolean} [sampled] @returns {ReadingStatus} */
export function readingStatus(key, sampled = false) {
  const reading = sampled ? signalState(key).rawVal : signalState(key).val;
  const fault = sampled ? faultState(key).rawVal : faultState(key).val;
  if (fault && (!reading || fault.ts >= reading.ts)) return "fault";
  if (!reading) return "missing";
  return readingIsStale(key, sampled) ? "stale" : "fresh";
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
