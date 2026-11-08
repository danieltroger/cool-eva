// @ts-check
// Approved option C and live/held selection policy: docs/cell-module-map.md.
import van from "../vendor/van-1.6.1.js";
import { chartTick, ageOf } from "../lib/store.js";
import { freshValue, readingStatus, statusWord } from "../lib/reading-status.js";
import {
  PACK_MODULE_GRID,
  packCellLayout,
  cellLmuBoundaries,
  lowestModuleCell,
  stepCellPosition,
} from "../lib/pack-layout.js";
import { cellMapReading, cellMapColour, cellMapAge, cellAgeText } from "../lib/cell-map.js";
import { moduleTemperatureKey } from "../lib/cells.js";
import { TemperatureReadings } from "./temperature-readings.js";
import * as units from "../lib/units.js";
import * as colors from "../lib/colors.js";

export function CellsView() {
  const metric = van.state(/** @type {import("../lib/cell-map.js").CellMapMetric} */ ("temperature"));
  const position = van.state(48);
  const selection = { metric, position };
  const cells = packCellLayout();
  return div(
    { class: "view riding-view cells-view layout-page", "data-view": "cells" },
    div(
      { class: "layout-compact-stack cells-content", "data-cell-option": "combined" },
      Summary(),
      div(
        { class: "layout-row cell-mode", role: "group", "aria-label": "Map reading" },
        .../** @type {const} */ (["temperature", "balance"]).map(mode =>
          button(
            {
              class: "control-button",
              "data-map-mode": mode,
              "aria-pressed": () => String(metric.val === mode),
              onclick: () => {
                metric.val = mode;
              },
            },
            mode === "temperature" ? "Temperature" : "Cell balance"
          )
        )
      ),
      div(
        { class: "layout-between" },
        span({ class: "cell-tiny", "data-map-age": "" }, () => {
          chartTick.val;
          const age = cellMapAge(cells.map(cell => cellMapReading(cell, metric.val)));
          return age === "now" ? "Modules · now" : `Latest readings · ${age}${/^\d/.test(age) ? " old" : ""}`;
        }),
        span({ class: "cell-legend", "data-map-legend": "" }, () =>
          metric.val === "temperature"
            ? `${Math.round(units.temp(38))} → ${Math.round(units.temp(50))} ${units.tempUnit()}`
            : "0 → −40 mV"
        )
      ),
      div(
        { class: "pack-map", role: "group", "aria-label": "Nine modules, nine cells per module, across eleven LMUs" },
        ...PACK_MODULE_GRID.flat().map(moduleNumber =>
          ModuleBlock(
            moduleNumber,
            cells.filter(cell => cell.module === moduleNumber),
            selection
          )
        )
      ),
      SelectionDetail(cells, selection)
    )
  );
}

const { button, div, span } = van.tags;
/** @typedef {{metric:import("../vendor/van-1.6.1.js").State<import("../lib/cell-map.js").CellMapMetric>,position:import("../vendor/van-1.6.1.js").State<number>}} Selection */

function Summary() {
  return div(
    { class: "cell-summary" },
    div(
      { class: "tile layout-card" },
      span({ class: "label" }, "Battery · low / high"),
      div({ class: "value" }, ...TemperatureReadings(["batt_temp_lo", "batt_temp_hi"]))
    ),
    div(
      { class: "tile layout-card" },
      span({ class: "label" }, "Cell spread"),
      div(
        {
          class: "value",
          "data-spread-now": "",
          style: () =>
            `color:${readingStatus("cell_spread_mv") === "fault" ? colors.BAD : freshValue("cell_spread_mv") === null ? colors.MUTED : colors.CALM}`,
        },
        () =>
          freshValue("cell_spread_mv") === null
            ? statusWord(readingStatus("cell_spread_mv"))
            : span(String(Math.round(freshValue("cell_spread_mv") ?? 0)), span({ class: "unit" }, "mV"))
      )
    )
  );
}

/** @param {number} moduleNumber @param {import("../lib/pack-layout.js").PackCell[]} cells @param {Selection} selection */
function ModuleBlock(moduleNumber, cells, selection) {
  return button(
    {
      class: () => {
        chartTick.val;
        const age = cellMapAge(cells.map(cell => cellMapReading(cell, selection.metric.val)));
        return `module-block${Math.ceil(selection.position.val / 9) === moduleNumber ? " selected" : ""}${/^\d/.test(age) ? " old" : ""}`;
      },
      "data-module": moduleNumber,
      "aria-label": `Module ${moduleNumber}`,
      "aria-pressed": () => String(Math.ceil(selection.position.val / 9) === moduleNumber),
      onclick: event => {
        const target = event.target instanceof Element ? event.target.closest("[data-position]") : null;
        selection.position.val = target
          ? Number(target.getAttribute("data-position"))
          : selection.metric.val === "temperature"
            ? cells[0].position
            : lowestModuleCell(moduleNumber, key => {
                const cell = cells.find(candidate => candidate.key === key);
                const reading = cell ? cellMapReading(cell, "balance") : null;
                return reading?.current ? reading.value : null;
              });
      },
    },
    span(
      { class: "module-head" },
      span(`M${moduleNumber}`),
      span({ class: "age-cue", "data-module-age": "" }, () => {
        chartTick.val;
        const age = cellMapAge(cells.map(cell => cellMapReading(cell, selection.metric.val)));
        return age === "now" ? "" : age;
      })
    ),
    span(
      { class: "module-cells" },
      ...cells.map((cell, index) => CellSquare(cell, cellLmuBoundaries(cells, index), selection))
    )
  );
}

/** @param {import("../lib/pack-layout.js").PackCell} cell @param {string[]} boundaries @param {Selection} selection */
function CellSquare(cell, boundaries, selection) {
  return span(
    {
      "data-position": cell.position,
      "data-cell-key": cell.key,
      "data-lmu": cell.lmu,
      "data-lmu-cell": cell.cell,
      "data-state": () => {
        chartTick.val;
        return cellMapReading(cell, selection.metric.val).state;
      },
      class: () => {
        chartTick.val;
        const state = cellMapReading(cell, selection.metric.val).state;
        return `cell-square ${boundaries.join(" ")}${selection.position.val === cell.position ? " selected" : ""}${state === "fault" ? " fault" : ["absent", "missing", "stale"].includes(state) ? " missing" : ""}`;
      },
      style: () => {
        chartTick.val;
        return `--cell-color:${cellMapColour(cellMapReading(cell, selection.metric.val), selection.metric.val, freshValue("cell_max_mv", true))}`;
      },
      title: () => {
        chartTick.val;
        const reading = cellMapReading(cell, selection.metric.val);
        return `Position ${cell.position} · LMU ${cell.lmu} cell ${cell.cell} · ${reading.state === "absent" ? "Battery sensor not fitted" : reading.value === null ? mapStatusWord(reading.state) : `${selection.metric.val === "temperature" ? `${Math.round(units.temp(reading.value))} ${units.tempUnit()}` : `${reading.value} mV`} · ${ageDescription(reading.age)}`}`;
      },
    },
    span({ class: "lmu-label" }, boundaries.includes("lmu-start") ? `L${cell.lmu}` : ""),
    span({ class: "cell-marker" }, () => {
      chartTick.val;
      const state = cellMapReading(cell, selection.metric.val).state;
      return state === "fault" ? "!" : state === "missing" || state === "stale" ? "×" : "";
    })
  );
}

/** @param {import("../lib/pack-layout.js").PackCell[]} cells @param {Selection} selection */
function SelectionDetail(cells, selection) {
  return div(
    { class: "cell-detail" },
    ...[-1, 0, 1].map(direction =>
      direction
        ? button(
            {
              class: "control-button",
              "data-cell-step": direction,
              "aria-label": direction < 0 ? "Previous cell" : "Next cell",
              disabled: () => selection.position.val === (direction < 0 ? 1 : 81),
              onclick: () => {
                selection.position.val = stepCellPosition(selection.position.val, direction);
              },
            },
            direction < 0 ? "‹" : "›"
          )
        : div(
            { class: "layout-compact-stack" },
            span(
              {
                "data-cell-description": "",
                style: () => {
                  chartTick.val;
                  return `color:${cellMapReading(cells[selection.position.val - 1], selection.metric.val).state === "fault" ? colors.BAD : "var(--fg)"}`;
                },
              },
              () => {
                chartTick.val;
                const cell = cells[selection.position.val - 1];
                const reading = cellMapReading(cell, selection.metric.val);
                return selection.metric.val === "temperature"
                  ? `M${cell.module} · LMU ${cell.lmu} · ${reading.value === null ? (reading.state === "absent" ? "—" : mapStatusWord(reading.state)) : `${Math.round(units.temp(reading.value))} ${units.tempUnit()}`}`
                  : `M${cell.module} · L${cell.lmu} C${cell.cell} · ${reading.value === null ? mapStatusWord(reading.state) : `${(reading.value / 1000).toFixed(3)} V`}`;
              }
            ),
            span({ class: "cell-tiny", "data-cell-extra": "" }, () => {
              chartTick.val;
              const cell = cells[selection.position.val - 1];
              const reading = cellMapReading(cell, selection.metric.val);
              if (selection.metric.val === "temperature") {
                const keys = [moduleTemperatureKey(cell.lmu, "pcb1"), moduleTemperatureKey(cell.lmu, "pcb2")].filter(
                  key => key !== null
                );
                const oldestBoardAge = Math.max(...keys.filter(key => freshValue(key, true) !== null).map(ageOf));
                const boardAge = cellAgeText(oldestBoardAge);
                const showAge = boardAge !== "—" && (reading.state !== "absent" || boardAge !== "now");
                return `${reading.state === "absent" ? "No battery sensor · " : ""}PCB ${temperaturePair(keys)}${showAge ? ` · ${ageDescription(oldestBoardAge)}` : ""}`;
              }
              if (reading.state === "fault") return "Invalid voltage · slot retained";
              if (reading.state === "missing") return "No reading · slot retained";
              if (reading.state === "stale") return "stale · slot retained";
              const reference = freshValue("cell_max_mv", true);
              return `Position ${cell.position}${reading.current && reference !== null && reading.value !== null ? ` · ${Math.max(0, reference - reading.value)} mV below best` : ""} · ${ageDescription(reading.age)}`;
            })
          )
    )
  );
}
/** @param {string[]} keys */
function temperaturePair(keys) {
  const values = keys.map(key => freshValue(key, true));
  const lastNumeric = values.findLastIndex(value => value !== null);
  return values
    .map((value, index) =>
      value === null
        ? statusWord(readingStatus(keys[index], true))
        : `${Math.round(units.temp(value))}${index === lastNumeric ? ` ${units.tempUnit()}` : ""}`
    )
    .join(" / ");
}
/** @param {number} age */
function ageDescription(age) {
  const text = cellAgeText(age);
  return text === "now" || text === "—" ? text : `${text} old`;
}

/** @param {import("../lib/cell-map.js").CellMapReading["state"]} state */
function mapStatusWord(state) {
  return state === "absent" ? "—" : statusWord(state, "Missing");
}
