// @ts-check
import van from "../vendor/van-1.6.1.js";
import { chartTick, connection, faultState, isStale, signalState, valueOf } from "../lib/store.js";
import { STALE_MS } from "../lib/tiles.js";
import { SubTabs } from "../lib/sub-tabs.js";
import { settings } from "../lib/settings.js";
import { FAN_MODE_CODE, fanDriveState } from "../lib/fan-display.js";
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
      FanStatus()
    )
  );
}

function FanStatus() {
  return div({ class: "sub", "data-fan-status": "" }, () => {
    chartTick.val;
    if (settings.val?.active.radiatorFanEnabled === false) return "Not installed";
    const signals = ["fan_auto_mode", "fan_driver_enabled", "fan_duty_pct", "fan_target_pct"];
    if (signals.some(key => faultState(key).val)) {
      return span({ style: `color:${colors.BAD}` }, "Fan status fault");
    }
    if (signals.some(readingUnavailable)) {
      return "Fan status unavailable";
    }
    const mode = valueOf("fan_auto_mode");
    const modeText =
      mode === FAN_MODE_CODE.AUTOMATIC
        ? "Automatic"
        : mode === FAN_MODE_CODE.FUN
          ? "Fun"
          : mode === FAN_MODE_CODE.MANUAL
            ? "Manual"
            : "Mode unavailable";
    const driveState = fanDriveState(valueOf("fan_duty_pct"), valueOf("fan_target_pct"), valueOf("fan_driver_enabled"));
    if (driveState === "braking") {
      return span({ style: `color:${colors.BAD}` }, "Braking fault · cut fan power");
    }
    if (driveState === "stop-failed") {
      return span({ style: `color:${colors.BAD}` }, "Stop failed · still driving");
    }
    if (driveState === "unreported") return "Fan status unavailable";
    if (driveState === "standby") return `${modeText} · Standby`;
    if (driveState === "kick-start") return `${modeText} · kick-starting`;
    return `${modeText} · driving`;
  });
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
        `color:${faultState(key).val ? colors.BAD : readingUnavailable(key) ? colors.MUTED : temperature ? colors.temperature(valueOf(key)) : colors.CALM}`,
    },
    () => {
      chartTick.val;
      if (
        (key.startsWith("coolant_") && settings.val?.active.coolantProbesEnabled === false) ||
        (key.startsWith("fan_") && settings.val?.active.radiatorFanEnabled === false)
      ) {
        return "—";
      }
      if (faultState(key).val) return "fault";
      const reading = signalState(key).val;
      if (!reading) return "—";
      if (readingUnavailable(key)) return "stale";
      return (temperature ? units.temp(reading.value) : reading.value).toFixed(decimals);
    }
  );
}

/** @param {string} key */
function readingUnavailable(key) {
  // Fan commands retain their last-change timestamp across live snapshots (registry.ts onDemand).
  if (key.startsWith("fan_")) {
    return signalState(key).val === null || connection.val !== "live";
  }
  return isStale(key, STALE_MS);
}
