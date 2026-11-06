// @ts-check
// Shared parked module grid; sampled cell bindings preserve the table nodes across ticks.
import van from "../vendor/van-1.6.1.js";
import { chartTick, peek } from "../lib/store.js";
import { readingCanColour, readingStatus, statusWord } from "../lib/reading-status.js";
import {
  MODULE_COUNT,
  MODULE_SENSORS,
  MODULE_SENSOR_COUNT,
  moduleTemperatureGrid,
  moduleTemperatureKey,
} from "../lib/cells.js";
import { heatmap } from "../lib/svg.js";
import * as colors from "../lib/colors.js";
import * as units from "../lib/units.js";
const { div, table, thead, tbody, tr, th, td } = van.tags;

export function ModuleTemperatures() {
  return div(
    { class: "tile module-temperatures" },
    div({ class: "label" }, "Module temperatures"),
    () => {
      chartTick.val;
      const grid = moduleTemperatureGrid(key => (readingStatus(key, true) === "fresh" ? peek(key) : null));
      return heatmap({
        rows: grid.rows.map(row => ({
          label: String(row.module),
          cells: row.cells.map((cell, index) => {
            const key = moduleTemperatureKey(row.module, MODULE_SENSORS[index]);
            return {
              ...cell,
              color: key !== null && readingCanColour(key, true) ? colors.temperature(cell.value) : colors.MUTED,
            };
          }),
        })),
      });
    },
    div({ class: "sub", "data-module-count": "" }, () => {
      chartTick.val;
      const seen = moduleTemperatureGrid(key => (readingStatus(key, true) === "fresh" ? peek(key) : null)).seen;
      return `${seen} of ${MODULE_SENSOR_COUNT} fresh · modules 6 & 8 have no battery sensor`;
    }),
    table(
      { class: "module-readings" },
      thead(tr(th("Module"), th("Battery"), th("PCB 1"), th("PCB 2"))),
      tbody(
        ...Array.from({ length: MODULE_COUNT }, (_, index) =>
          tr(
            td(String(index + 1)),
            ...MODULE_SENSORS.map(sensor => ModuleReading(moduleTemperatureKey(index + 1, sensor)))
          )
        )
      )
    )
  );
}

/** @param {string|null} key */
function ModuleReading(key) {
  if (key === null) return td({ class: "sub" }, "Not fitted");
  return td(
    {
      "data-module-signal": key,
      style: () => {
        chartTick.val;
        const state = readingStatus(key, true);
        return `color:${state === "fault" ? colors.BAD : readingCanColour(key, true) ? colors.temperature(peek(key)) : colors.MUTED}`;
      },
    },
    () => {
      chartTick.val;
      const state = readingStatus(key, true);
      const value = state === "fresh" ? peek(key) : null;
      return value === null ? statusWord(state) : `${units.temp(value).toFixed(0)}${units.tempUnit()}`;
    }
  );
}
