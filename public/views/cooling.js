// @ts-check
import van from "../vendor/van-1.6.1.js";
import { settings } from "../lib/settings.js";
import { TemperatureReadings } from "./temperature-readings.js";
import { FanControl } from "./fan.js";

const { div, span } = van.tags;

export function CoolingView() {
  return div(
    { class: "view riding-view cooling-view layout-page layout-stack", "data-view": "cooling" },
    div(
      { class: "layout-grid-2 cooling-top" },
      div(
        { class: "tile layout-card cooling-probes", hidden: () => settings.val?.active.coolantProbesEnabled === false },
        span({ class: "ride-label" }, "Coolant in / out"),
        div({ class: "value cooling-values" }, ...TemperatureReadings(["coolant_in", "coolant_out"], 1))
      ),
      div(
        { class: "tile layout-card" },
        span({ class: "ride-label" }, "Motor / OBD"),
        div({ class: "value cooling-values" }, ...TemperatureReadings(["motor_temp_c", "bike_coolant_temp"]))
      )
    ),
    div(
      { class: "tile layout-card layout-between cooling-outside" },
      span({ class: "ride-label" }, "Outside air"),
      div({ class: "value" }, ...TemperatureReadings(["ambient_temp"]))
    ),
    FanControl()
  );
}
