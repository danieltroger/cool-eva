// @ts-check
import { peek, valueOf } from "./store.js";
import { freshValue, readingStatus } from "./reading-status.js";
import { CELL_COUNT } from "./cells.js";

export const REGEN_CEILING_A = 120;
export const HYPERMILE_HEADROOM_MV = 150;
const LIMP_QUALIFY_MS = 5000;
const STOP_QUALIFY_MS = 10000;
/** @type {number|null} */
let underLimpSince = null;
/** @type {number|null} */
let underStopSince = null;
/** @typedef {{minimum:number,limp:number,stop:number,driving:boolean,active:boolean}} CellCountdownInput */
/** @typedef {{active:boolean,minimum:number|null,limp:number|null,soc:number|null,limpSoc:number|null,temperature:number|null,limpTemperature:number|null,allowance:number|null,limpPackTenths:number|null}} LimpInput */

/** @param {number} now @param {CellCountdownInput|null} input */
export function advanceCellCountdowns(now, input) {
  underLimpSince = input?.driving && !input.active && input.minimum <= input.limp ? (underLimpSince ?? now) : null;
  underStopSince = input?.driving && input.minimum < input.stop ? (underStopSince ?? now) : null;
}

/** @param {number} now */
export function cellCountdowns(now) {
  return {
    limp: underLimpSince === null ? null : Math.max(0, Math.ceil((LIMP_QUALIFY_MS - (now - underLimpSince)) / 1000)),
    stop: underStopSince === null ? null : Math.max(0, Math.ceil((STOP_QUALIFY_MS - (now - underStopSince)) / 1000)),
  };
}

/** @param {LimpInput} input @param {ReturnType<typeof cellCountdowns>} counts */
export function limpLine(input, counts) {
  if (counts.stop !== null) return "stop";
  if (counts.limp !== null) return "limp";
  if (!input.active) return null;
  if (input.minimum !== null && input.limp !== null && input.minimum <= input.limp) return "cell";
  if (input.soc !== null && input.limpSoc !== null && input.soc < input.limpSoc) return "soc";
  if (input.temperature !== null && input.limpTemperature !== null && input.temperature > input.limpTemperature) {
    return "temperature";
  }
  if (input.allowance !== null && input.limpPackTenths !== null && input.allowance < input.limpPackTenths / 10) {
    return "pack";
  }
  return Object.values(input).some(value => value === null) ? null : "exit";
}

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
