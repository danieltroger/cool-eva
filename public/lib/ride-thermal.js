// @ts-check
import { COOLANT_WATTS_PER_KELVIN } from "./derive.js";
import { worstStatus } from "./reading-status.js";

/** @typedef {import("./reading-status.js").ReadingStatus} ReadingStatus */
/** @typedef {{delta:number|null,deltaStatus:ReadingStatus,heatWatts:number|null,heatStatus:ReadingStatus,removalWatts:number|null,heatFraction:number|null}} RideThermal */

/** Thermal estimates and meter meaning: docs/ride-thermal.md.
 * @param {(key:string)=>number|null} read
 * @param {(key:string)=>ReadingStatus} status
 * @param {number} resistanceMilliohms
 * @param {boolean} probesEnabled
 * @returns {RideThermal} */
export function rideThermal(read, status, resistanceMilliohms, probesEnabled) {
  const deltaStatus = probesEnabled ? worstStatus(["coolant_in", "coolant_out"], false, status) : "missing";
  const inlet = read("coolant_in");
  const outlet = read("coolant_out");
  const delta = deltaStatus === "fresh" && inlet !== null && outlet !== null ? outlet - inlet : null;
  const heatStatus = status("pack_a");
  const amps = read("pack_a");
  const heatWatts = heatStatus === "fresh" && amps !== null ? (amps * amps * resistanceMilliohms) / 1000 : null;
  const removalWatts = delta === null ? null : delta * COOLANT_WATTS_PER_KELVIN;
  const heatFraction =
    heatWatts === null || removalWatts === null
      ? null
      : removalWatts > 0
        ? Math.min(1, heatWatts / removalWatts)
        : heatWatts > 0
          ? 1
          : null;
  return {
    delta,
    deltaStatus: delta === null && deltaStatus === "fresh" ? "missing" : deltaStatus,
    heatWatts,
    heatStatus: heatWatts === null && heatStatus === "fresh" ? "missing" : heatStatus,
    removalWatts,
    heatFraction,
  };
}
