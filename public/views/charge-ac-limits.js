// @ts-check
// AC setpoint/dash ceiling are mains-side; the BMS grant is pack-side. docs/charge-dashboard.md.
import van from "../vendor/van-1.6.1.js";
import { freshValue, readingStatus, statusWord } from "../lib/reading-status.js";
import * as colors from "../lib/colors.js";
const { div, span } = van.tags;

export function ChargeAcLimits() {
  return div(
    { class: "tile layout-card charge-ac-limits" },
    span({ class: "charge-label" }, "AC setpoint"),
    div(
      { class: "value" },
      Reading("charge_limit_a", true),
      span({ class: "unit" }, () => (freshValue("charge_limit_a") === null ? "" : "A · mains"))
    ),
    div(
      { class: "charge-record-row layout-between" },
      span("Charger ceiling"),
      div(Reading("ac_charge_ceiling_a"), () => (freshValue("ac_charge_ceiling_a") === null ? "" : " A · mains"))
    ),
    div(
      { class: "charge-record-row layout-between" },
      span("Battery ceiling"),
      div(Reading("charger_max_dc_a"), () => (freshValue("charger_max_dc_a") === null ? "" : " A · pack"))
    )
  );
}
/** @param {string} key @param {boolean} [main] */
function Reading(key, main = false) {
  return span(
    {
      "data-ac-reading": key,
      style: () =>
        `color:${readingStatus(key) === "fault" ? colors.BAD : freshValue(key) === null ? colors.MUTED : main ? colors.CALM : "var(--fg)"}`,
    },
    () => {
      const value = freshValue(key);
      return value === null ? statusWord(readingStatus(key), "Unavailable") : String(Number(value.toFixed(1)));
    }
  );
}
