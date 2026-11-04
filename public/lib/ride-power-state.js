// @ts-check
import { POWER_SCALE_KW, limitKw } from "./power-limits.js";

/** @typedef {import("./reading-status.js").ReadingStatus} ReadingStatus */
/** @typedef {{state:ReadingStatus,kilowatts:number|null}} PowerLimit */
/** @typedef {{value:number|null,powerStatus:ReadingStatus,drive:PowerLimit,regen:PowerLimit,charging:boolean,status:string,excess:boolean}} RidePowerState */

/** @param {(key:string)=>number|null} read @param {(key:string)=>ReadingStatus} status @param {boolean} charging @returns {RidePowerState} */
export function ridePowerState(read, status, charging) {
  const powerStatus = status("pack_kw");
  const value = powerStatus === "fresh" ? read("pack_kw") : null;
  const drive = limitState("allowed_discharge_a", read, status);
  const regen = limitState("allowed_regen_a", read, status);
  const used = value !== null && value < 0 ? drive : regen;
  const excess = !charging && value !== null && used.kilowatts !== null && Math.abs(value) > used.kilowatts;
  const unknown = [limitReason("Drive", drive), limitReason("Regen", regen)].filter(Boolean).join(" · ");
  return {
    value,
    powerStatus,
    drive,
    regen,
    charging,
    excess,
    status: charging
      ? powerStatus === "fresh"
        ? value !== null && value < 0
          ? "Power out · riding limits off"
          : "Charging · riding limits off"
        : `Charging · power ${reason(powerStatus)} · riding limits off`
      : powerStatus !== "fresh"
        ? `Power ${reason(powerStatus)}`
        : excess
          ? `Over ${value !== null && value < 0 ? "drive" : "regen"} limit`
          : unknown,
  };
}

/** @param {number} kilowatts Positive is regen, negative is drive. */
export function powerPosition(kilowatts) {
  return (POWER_SCALE_KW.regen - kilowatts) / (POWER_SCALE_KW.regen + POWER_SCALE_KW.drive);
}

/** @param {string} key @param {(key:string)=>number|null} read @param {(key:string)=>ReadingStatus} status @returns {PowerLimit} */
function limitState(key, read, status) {
  const states = [status(key), status("pack_v")];
  const state = states.includes("fault")
    ? "fault"
    : states.includes("missing")
      ? "missing"
      : states.includes("stale")
        ? "stale"
        : "fresh";
  const amps = read(key);
  const volts = read("pack_v");
  if (state !== "fresh") return { state, kilowatts: null };
  if (amps !== null && amps < 0) return { state: "fault", kilowatts: null };
  const kilowatts = limitKw(amps, volts);
  return { state: kilowatts === null ? "missing" : "fresh", kilowatts };
}

/** @param {string} side @param {PowerLimit} limit */
function limitReason(side, limit) {
  return limit.state === "fresh" ? "" : `${side} limit ${reason(limit.state)}`;
}

/** @param {ReadingStatus} state */
function reason(state) {
  return state === "missing" ? "unavailable" : state;
}
