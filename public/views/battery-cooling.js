// @ts-check
// Parked histories and cross-checks moved from Range: docs/range-and-cells.md.
import { ModuleTemperatures } from "./module-temperatures.js";
import van from "../vendor/van-1.6.1.js";
import { chartTick, peek } from "../lib/store.js";
import { readingStatus, worstStatus, statusWord } from "../lib/reading-status.js";
import { rangeValue } from "../lib/range-readings.js";
import { openRidingView } from "../lib/destination.js";
import { Fact, SignalTile } from "../lib/tiles.js";
import { sparkline } from "../lib/svg.js";
import { bikeConsumptionWhPerKm, resistiveLossPercent } from "../lib/derive.js";
import { packResistance } from "../lib/pack-resistance-live.js";
import { resistanceNote } from "../lib/pack-resistance.js";
import { ringFor } from "../lib/ring.js";
import { monotonicNow } from "../lib/clock.js";
import * as colors from "../lib/colors.js";
import * as units from "../lib/units.js";

const { button, div, h2, span } = van.tags;

export function BatteryCoolingPage() {
  return div(
    { class: "settings-page battery-cooling-page" },
    h2("Battery & cooling"),
    button({ class: "settings-button", onclick: () => openRidingView("cells") }, "Cells"),
    RegenAvailable(),
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
          ? statusWord(readingStatus("range_km"))
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

function ResistanceHistory() {
  return div(
    { class: "tile resistance-history" },
    div({ class: "label" }, "Lost to resistance"),
    div(
      { class: "value" },
      () =>
        worstStatus(["pack_a", "pack_kw"]) === "fresh"
          ? (resistiveLossPercent()?.toFixed(1) ?? "—")
          : statusWord(worstStatus(["pack_a", "pack_kw"])),
      span({ class: "unit" }, () =>
        worstStatus(["pack_a", "pack_kw"]) === "fresh" && resistiveLossPercent() !== null ? "%" : ""
      )
    ),
    () => {
      chartTick.val;
      const resistance = packResistance.rawVal;
      const amps =
        worstStatus(["pack_a", "pack_kw"], true) === "fresh"
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

function RegenAvailable() {
  return div(
    { class: "tile regen-information" },
    div({ class: "label" }, "Regen available"),
    div({ class: "value" }, () => {
      const value = rangeValue("allowed_regen_a");
      return value === null ? statusWord(readingStatus("allowed_regen_a")) : `${Math.round(value)} A of 120 A`;
    }),
    div({ class: "sub" }, () => {
      const allowance = rangeValue("allowed_regen_a");
      if (allowance === null) return `Allowance ${statusWord(readingStatus("allowed_regen_a"), "unknown")}`;
      const soc = rangeValue("soc");
      if (soc === null) return "Check charge level and pack temperature.";
      return allowance < 120 && soc > 90 ? "High charge level can reduce regen." : "Check pack temperature.";
    })
  );
}
