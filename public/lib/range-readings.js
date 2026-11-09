// @ts-check
import { peek, valueOf } from "./store.js";
import { readingStatus } from "./reading-status.js";

export const REGEN_CEILING_A = 120;

/** @param {boolean} [sampled] */
export function rangeEnergyKey(sampled = false) {
  const read = sampled ? peek : valueOf;
  return readingStatus("bms_remaining_energy_wh", sampled) === "fault" || (read("bms_remaining_energy_wh") ?? 0) > 0
    ? "bms_remaining_energy_wh"
    : (read("residual_energy_wh") ?? 0) > 0
      ? "residual_energy_wh"
      : "bms_remaining_energy_wh";
}

export function rangeDistanceKey() {
  return (peek("odometer_can_km") ?? 0) > 0 ? "odometer_can_km" : "odometer_km";
}
