// @ts-check
// Parked histories and cross-checks moved from Range: docs/range-and-cells.md.
import van from "../vendor/van-1.6.1.js";
import { chartTick, peek } from "../lib/store.js";
import { readingStatus } from "../lib/reading-status.js";
import { rangeInputStatus, rangeValue, rangeWord } from "../lib/range-readings.js";
import { openRidingView } from "../lib/destination.js";
import { Fact, SignalTile } from "../lib/tiles.js";
import {
  MODULE_COUNT,
  MODULE_SENSORS,
  MODULE_SENSOR_COUNT,
  moduleTemperatureGrid,
  moduleTemperatureKey,
} from "../lib/cells.js";
import { heatmap, sparkline } from "../lib/svg.js";
import { bikeConsumptionWhPerKm, resistiveLossPercent } from "../lib/derive.js";
import { packResistance } from "../lib/pack-resistance-live.js";
import { resistanceNote } from "../lib/pack-resistance.js";
import { ringFor } from "../lib/ring.js";
import { monotonicNow } from "../lib/clock.js";
import * as colors from "../lib/colors.js";
import * as units from "../lib/units.js";

const { button, div, h2, span, table, thead, tbody, tr, th, td } = van.tags;

export function BatteryCoolingPage() {
  return div(
    { class: "settings-page battery-cooling-page" },
    h2("Battery & cooling"),
    button({ class: "settings-button", onclick: () => openRidingView("cells") }, "Cells"),
    ModuleTemperatures(),
    div(
      { class: "tile battery-cross-checks" },
      div({ class: "label" }, "Bike consumption cross-check"),
      Fact("Bike's average", () => {
        chartTick.val;
        const reading = bikeConsumptionWhPerKm(monotonicNow());
        return reading === null
          ? "Waiting for bike history"
          : `${units.efficiency(reading).toFixed(0)} ${units.efficiencyUnit()} · last 5 min`;
      }),
      Fact("Bike's range", () => {
        const value = rangeValue("range_km");
        return value === null
          ? rangeWord(readingStatus("range_km"))
          : `${units.distance(value).toFixed(0)} ${units.distanceUnit()}`;
      })
    ),
    ResistanceHistory(),
    ...[
      "coolant_in",
      "coolant_out",
      "batt_temp_lo",
      "batt_temp_hi",
      "motor_temp_c",
      "bike_coolant_temp",
      "ambient_temp",
    ].map(key =>
      SignalTile({
        key,
        label:
          {
            coolant_in: "Coolant inlet",
            coolant_out: "Coolant outlet",
            batt_temp_lo: "Battery minimum",
            batt_temp_hi: "Battery maximum",
            motor_temp_c: "Motor",
            bike_coolant_temp: "OBD",
            ambient_temp: "Ambient",
          }[key] ?? key,
        format: value => units.temp(value).toFixed(1),
        unit: units.tempUnit,
        color: colors.temperature,
        chart: true,
        minSpan: 2,
      })
    )
  );
}

function ModuleTemperatures() {
  return div({ class: "tile module-temperatures" }, div({ class: "label" }, "Module temperatures"), () => {
    chartTick.val;
    const grid = moduleTemperatureGrid(key => (readingStatus(key, true) === "fresh" ? peek(key) : null));
    const rows = grid.rows.map(row => ({
      label: String(row.module),
      cells: row.cells.map(cell => ({ ...cell, color: colors.temperature(cell.value) })),
    }));
    return div(
      heatmap({ rows }),
      div(
        { class: "sub", "data-module-count": "" },
        `${grid.seen} of ${MODULE_SENSOR_COUNT} fresh · modules 6 & 8 have no battery sensor`
      ),
      table(
        { class: "module-readings" },
        thead(tr(th("Module"), th("Battery"), th("PCB 1"), th("PCB 2"))),
        tbody(
          ...Array.from({ length: MODULE_COUNT }, (_, index) =>
            tr(
              td(String(index + 1)),
              ...MODULE_SENSORS.map(sensor => {
                const key = moduleTemperatureKey(index + 1, sensor);
                if (key === null) return td({ class: "sub" }, "Not fitted");
                const status = readingStatus(key, true);
                const value = status === "fresh" ? peek(key) : null;
                return td(
                  {
                    "data-module-signal": key,
                    style: `color:${status === "fault" ? colors.BAD : status === "fresh" ? colors.temperature(value) : colors.MUTED}`,
                  },
                  value === null ? rangeWord(status) : `${units.temp(value).toFixed(0)}${units.tempUnit()}`
                );
              })
            )
          )
        )
      )
    );
  });
}

function ResistanceHistory() {
  return div(
    { class: "tile resistance-history" },
    div({ class: "label" }, "Lost to resistance"),
    div(
      { class: "value" },
      () =>
        rangeInputStatus(["pack_a", "pack_kw"]) === "fresh"
          ? (resistiveLossPercent()?.toFixed(1) ?? "—")
          : rangeWord(rangeInputStatus(["pack_a", "pack_kw"])),
      span({ class: "unit" }, () =>
        rangeInputStatus(["pack_a", "pack_kw"]) === "fresh" && resistiveLossPercent() !== null ? "%" : ""
      )
    ),
    () => {
      chartTick.val;
      const resistance = packResistance.rawVal;
      const amps =
        rangeInputStatus(["pack_a", "pack_kw"], true) === "fresh"
          ? ringFor("pack_a").since(600_000, monotonicNow()).values
          : [];
      return sparkline({
        values: amps.map(value => (value * value * resistance.milliohms) / 1000),
        color: colors.CALM,
        minSpan: 100,
      });
    },
    div(
      { class: "sub" },
      () =>
        `${packResistance.val.milliohms.toFixed(0)} mΩ · ${resistanceNote(packResistance.val) || "measured R"} · last 10 min`
    )
  );
}
