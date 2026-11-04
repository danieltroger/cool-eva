// @ts-check
import { peek, valueOf } from "./store.js";
import { readingStatus } from "./reading-status.js";

/** @param {string[]} keys @param {boolean} [sampled] @returns {import("./reading-status.js").ReadingStatus} */
export function rangeInputStatus(keys, sampled = false) {
  const states = keys.map(key => readingStatus(key, sampled));
  return states.includes("fault")
    ? "fault"
    : states.includes("missing")
      ? "missing"
      : states.includes("stale")
        ? "stale"
        : "fresh";
}

/** @param {string} key @param {boolean} [sampled] */
export function rangeValue(key, sampled = false) {
  return readingStatus(key, sampled) === "fresh" ? (sampled ? peek(key) : valueOf(key)) : null;
}

/** @param {import("./reading-status.js").ReadingStatus} status */
export function rangeWord(status) {
  return status === "missing" ? "—" : status === "fresh" ? "—" : status;
}

export function rangeEnergyKey() {
  return readingStatus("bms_remaining_energy_wh") === "fault" || (valueOf("bms_remaining_energy_wh") ?? 0) > 0
    ? "bms_remaining_energy_wh"
    : (valueOf("residual_energy_wh") ?? 0) > 0
      ? "residual_energy_wh"
      : "bms_remaining_energy_wh";
}

export function rangeDistanceKey() {
  return (peek("odometer_can_km") ?? 0) > 0 ? "odometer_can_km" : "odometer_km";
}
