// @ts-check
import { peek, valueOf } from "./store.js";
import { freshValue, readingStatus } from "./reading-status.js";
import { CELL_COUNT } from "./cells.js";

export const REGEN_CEILING_A = 120;
export const HYPERMILE_HEADROOM_MV = 150;

/** @param {number} limpMv @param {number} stopMv @param {number|null} packAmps @param {number|null} resistanceMilliohm */
export function compensatedThresholds(limpMv, stopMv, packAmps, resistanceMilliohm) {
  const load = packAmps === null || resistanceMilliohm === null ? 0 : packAmps * resistanceMilliohm;
  return { limp: limpMv + Math.floor(load / 80), stop: stopMv + Math.min(0, Math.floor(load / CELL_COUNT)) };
}

/** @param {(key:string)=>number|null} [read] */
export function driveKey(read = freshValue) {
  return read("go") === 1 ? "current_max_out_a" : "allowed_discharge_a";
}

/** @param {(key:string)=>number|null} [read] */
export function energyEmpty(read = freshValue) {
  return read("bms_remaining_energy_wh") === 0 && read("residual_energy_wh") === 0 && read("soc") === 0;
}

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
