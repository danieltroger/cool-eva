// @ts-check
import { power } from "./format.js";
import { BAD, CALM, FLOW, GOOD, MUTED } from "./colors.js";

/** @typedef {{label:string,magnitude:string,color:string}} RidePowerDisplay */

/** Direction words and unsigned precision: docs/ride-power.md. @param {import("./ride-power-state.js").RidePowerState} state @param {boolean} moving @returns {RidePowerDisplay} */
export function ridePowerDisplay(state, moving) {
  if (state.value === null) {
    return { label: "POWER", magnitude: "—", color: state.powerStatus === "fault" ? BAD : MUTED };
  }
  const magnitude = power(Math.abs(state.value));
  if (Number(magnitude) === 0) return { label: "POWER", magnitude: "0.0", color: CALM };
  return {
    label:
      state.value > 0
        ? state.charging
          ? "CHARGING"
          : moving
            ? "REGEN"
            : "POWER IN"
        : moving && !state.charging
          ? "DRIVE"
          : "POWER OUT",
    magnitude,
    color: state.value > 0 ? GOOD : FLOW,
  };
}
