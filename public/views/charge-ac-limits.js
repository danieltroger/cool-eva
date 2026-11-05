// @ts-check
// AC setpoint and BMS grants are charger-output values; docs/charge-dashboard.md.
import van from "../vendor/van-1.6.1.js";
import { freshValue, readingStatus, statusWord } from "../lib/reading-status.js";
import * as colors from "../lib/colors.js";
const { div } = van.tags;

export function ChargeAcLimits() {
  return div(
    { class: "tile charge-ac-limits" },
    div({ class: "label" }, "AC charge limits"),
    AcReading("AC setpoint", "Charger output current", "charge_limit_a", "A"),
    AcReading("Battery ceiling", "Granted charger current", "charger_max_dc_a", "A"),
    AcReading("Battery ceiling", "Granted charger voltage", "charger_max_dc_v", "V"),
    div(
      { class: "charge-ac-notes sub" },
      div("Battery-side values, not mains current."),
      div("Other bike and charger limits still apply.")
    )
  );
}

/** @param {string} label @param {string} scope @param {string} key @param {string} unit */
function AcReading(label, scope, key, unit) {
  return div(
    { class: "charge-ac-row" },
    div(div({ class: "label" }, label), div({ class: "sub" }, scope)),
    div(
      {
        class: () => `charge-ac-reading ${freshValue(key) === null ? "status-word" : ""}`,
        "data-ac-reading": key,
        style: () =>
          `color:${readingStatus(key) === "fault" ? colors.BAD : freshValue(key) === null ? colors.MUTED : colors.CALM}`,
      },
      () => {
        const value = freshValue(key);
        return value === null ? statusWord(readingStatus(key), "unavailable") : `${Number(value.toFixed(1))} ${unit}`;
      }
    )
  );
}
