/** Verified units only; unconfirmed map-power and gain scales remain raw. See docs/service-parameters.md. */
export function parameterDisplay(name: string): { unit: string; scale: number } {
  switch (name) {
    case "MAX_DC_CHG_CURRENT":
      return { unit: "A", scale: 1 };
    case "TORQUE_LIMIT":
    case "REGEN_TORQUE_LIMIT":
      return { unit: "Nm", scale: 0.1 };
    case "BEAM_MAX_CURR_TH":
      return { unit: "mA", scale: 1 };
    default:
      return { unit: "raw", scale: 1 };
  }
}
