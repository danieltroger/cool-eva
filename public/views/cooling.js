// @ts-check
import van from "../vendor/van-1.6.1.js";
import { chartTick, faultState, isStale, signalState, valueOf } from "../lib/store.js";
import { STALE_MS } from "../lib/tiles.js";
import { SubTabs } from "../lib/sub-tabs.js";
import { settings } from "../lib/settings.js";
import * as units from "../lib/units.js";
import * as colors from "../lib/colors.js";

const { div, span } = van.tags;

export function CoolingView() {
  return div(
    { class: "view riding-view cooling-view", "data-view": "cooling" },
    SubTabs("ride"),
    TemperatureCard(
      "Coolant · inlet / outlet",
      ["coolant_in", "coolant_out"],
      () => (settings.val?.active.coolantProbesEnabled === false ? "Coolant probes off" : "Two coolant probes"),
      1
    ),
    TemperatureCard("Battery · min / max", ["batt_temp_lo", "batt_temp_hi"], "Across the battery"),
    TemperatureCard("Motor / OBD", ["motor_temp_c", "bike_coolant_temp"], "Separate temperature sensors"),
    TemperatureCard("Ambient", ["ambient_temp"], "Outside air", 0, "cooling-short"),
    div(
      { class: "tile cooling-short" },
      div({ class: "label" }, "Cooling fan · commanded"),
      div({ class: "value" }, Reading("fan_target_pct", 0, false), span({ class: "unit" }, "%")),
      div({ class: "sub" }, () => {
        chartTick.val;
        if (settings.val?.active.radiatorFanEnabled === false) return "Not installed";
        if (faultState("fan_auto_mode").val || faultState("fan_driver_enabled").val) return "Fan status fault";
        if (isStale("fan_auto_mode", STALE_MS) || isStale("fan_driver_enabled", STALE_MS))
          return "Fan status unavailable";
        const mode = valueOf("fan_auto_mode");
        const enabled = valueOf("fan_driver_enabled");
        const modeText = mode === 1 ? "Automatic" : mode === 2 ? "Fun" : mode === 0 ? "Manual" : "Mode unavailable";
        return `${modeText} · ${enabled === 1 ? "driver ready" : enabled === 0 ? "driver off" : "readiness unavailable"}`;
      })
    )
  );
}

/** @param {string} label @param {string[]} keys @param {string | (() => string)} caption @param {number} [decimals] @param {string} [extraClass] */
function TemperatureCard(label, keys, caption, decimals = 0, extraClass = "") {
  return div(
    { class: `tile ${extraClass}` },
    div({ class: "label" }, label),
    div(
      { class: "value cooling-values" },
      ...keys.flatMap((key, index) => [index ? span(" / ") : span(), Reading(key, decimals, true)]),
      span({ class: "unit" }, units.tempUnit)
    ),
    div({ class: "sub" }, caption)
  );
}

/** @param {string} key @param {number} decimals @param {boolean} temperature */
function Reading(key, decimals, temperature) {
  return span(
    {
      "data-signal": key,
      style: () =>
        `color:${faultState(key).val ? colors.BAD : isStale(key, STALE_MS) ? colors.MUTED : temperature ? colors.temperature(valueOf(key)) : colors.CALM}`,
    },
    () => {
      chartTick.val;
      if (
        (key.startsWith("coolant_") && settings.val?.active.coolantProbesEnabled === false) ||
        (key.startsWith("fan_") && settings.val?.active.radiatorFanEnabled === false)
      )
        return "—";
      if (faultState(key).val) return "fault";
      const reading = signalState(key).val;
      if (!reading) return "—";
      if (isStale(key, STALE_MS)) return "stale";
      return (temperature ? units.temp(reading.value) : reading.value).toFixed(decimals);
    }
  );
}
