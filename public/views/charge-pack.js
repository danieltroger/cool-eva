// @ts-check
// Parked details and preserved measurement qualifications: docs/charge-dashboard.md.
import van from "../vendor/van-1.6.1.js";
import { SubTabs } from "../lib/sub-tabs.js";
import { chartTick, peek } from "../lib/store.js";
import { readingStatus, statusWord, worstStatus, freshValue } from "../lib/reading-status.js";
import { chargePowerDisplay, displayChargeMode } from "../lib/charge-display.js";
import { SignalTile, PairTile, Fact } from "../lib/tiles.js";
import { heatmap, meter, sparkline } from "../lib/svg.js";
import { cellSnapshot } from "../lib/cell-snapshot.js";
import { MODULE_COUNT, MAX_CELLS_PER_MODULE, CELL_COUNT, cellsInModule } from "../lib/cells.js";
import { ModuleTemperatures } from "./module-temperatures.js";
import { COOLANT_FLOW_LPH, coolantHeatRemovedWatts, resistiveLossWatts } from "../lib/derive.js";
import { packResistance } from "../lib/pack-resistance-live.js";
import { resistanceNote } from "../lib/pack-resistance.js";
import { monotonicNow } from "../lib/clock.js";
import { ringFor } from "../lib/ring.js";
import * as colors from "../lib/colors.js";
import * as units from "../lib/units.js";
const { div, span } = van.tags;

export function ChargePackView() {
  return div(
    { class: "view charge-pack-view", "data-view": "charge-pack" },
    SubTabs("charge"),
    ThermalBalance(),
    PairTile({
      label: "Physical battery",
      keys: ["batt_temp_lo", "batt_temp_hi"],
      format: value => units.temp(value).toFixed(0),
      unit: units.tempUnit,
      color: colors.temperature,
      caption: "min / max across the pack",
      chart: true,
      minSpan: 5,
    }),
    PairTile({
      label: "Bike-reported battery",
      keys: ["batt_temp_lo_vcu", "batt_temp_hi_vcu"],
      format: value => units.temp(value).toFixed(0),
      unit: units.tempUnit,
      color: colors.temperature,
      caption: "inputs to the observed temperature ceiling",
      chart: true,
      minSpan: 5,
    }),
    PairTile({
      label: "Coolant",
      keys: ["coolant_in", "coolant_out"],
      format: value => units.temp(value).toFixed(1),
      unit: units.tempUnit,
      color: colors.temperature,
      caption: "inlet / outlet",
      chart: true,
      minSpan: 2,
    }),
    Balance(),
    ModuleTemperatures(),
    VoltageGrid(),
    Isolation(),
    div({ class: "tile charge-phase" }, div({ class: "label" }, "Charge state"), () => {
      const states = [
        ...["bms_state_trickle", "bms_state_maintenance", "bms_state_balancing"].map(
          key =>
            `${key.replace("bms_state_", "")}: ${freshValue(key) === null ? statusWord(readingStatus(key)) : freshValue(key) === 1 ? "yes" : "no"}`
        ),
      ];
      return div({ class: "sub" }, states.join(" · "));
    }),
    ChargePowerHistory(),
    SignalTile({
      key: "pack_a",
      label: "Pack current",
      className: "charge-pack-current",
      format: value => value.toFixed(1),
      unit: "A",
      sub: () => {
        const value = freshValue("pack_a");
        return value === null
          ? statusWord(readingStatus("pack_a"), "unavailable")
          : value < 0
            ? "Power out of the pack"
            : value > 0
              ? "Power into the pack"
              : "No current flow";
      },
      chart: true,
      minSpan: 2,
    }),
    SignalTile({ key: "pack_v", label: "Pack voltage", format: value => value.toFixed(0), unit: "V" }),
    () =>
      displayChargeMode.val === "ac"
        ? AcDetails()
        : div(
            { class: "tile" },
            div({ class: "label" }, "AC delivery detail"),
            div({ class: "sub" }, "AC-only readings are inactive outside an AC charge.")
          )
  );
}

function ThermalBalance() {
  return div(
    { class: "tile charge-thermal" },
    div({ class: "label" }, "Resistance heat / loop removal"),
    div(
      { class: "value" },
      () => heatText("in"),
      span(" / "),
      () => heatText("out")
    ),
    () => {
      const into = worstStatus(["pack_a"]) === "fresh" ? resistiveLossWatts() : null;
      const out = worstStatus(["coolant_in", "coolant_out"]) === "fresh" ? coolantHeatRemovedWatts() : null;
      return meter({
        fraction: into !== null && out !== null && into > 0 ? Math.min(out / into, 1) : null,
        color: out !== null && into !== null && out >= into ? colors.GOOD : colors.WATCH,
      });
    },
    div(
      { class: "sub" },
      () =>
        `Heat in uses ${resistanceNote(packResistance.val) || "measured R"}; heat out assumes rated ${COOLANT_FLOW_LPH} L/h flow.`
    )
  );
}
/** @param {"in"|"out"} side */
function heatText(side) {
  const state = worstStatus(side === "in" ? ["pack_a"] : ["coolant_in", "coolant_out"]);
  if (state !== "fresh") return statusWord(state);
  const value = side === "in" ? resistiveLossWatts() : coolantHeatRemovedWatts();
  return value === null ? "—" : `${Math.round(value)} W`;
}
function Balance() {
  return SignalTile({
    key: "cell_spread_mv",
    label: "Cell spread",
    format: value => value.toFixed(0),
    unit: "mV",
    color: colors.spread,
    chart: true,
    minSpan: 10,
    sub: () => {
      const state = worstStatus(["cell_min_mv", "cell_max_mv"]);
      const span =
        state === "fresh" ? `${freshValue("cell_min_mv")}–${freshValue("cell_max_mv")} mV` : statusWord(state);
      const balance = freshValue("bms_state_balancing");
      return `${span} · ${balance === null ? `balancing ${statusWord(readingStatus("bms_state_balancing"))}` : balance === 1 ? "balancing now" : "not balancing"} · last 10 min`;
    },
  });
}
function VoltageGrid() {
  return div({ class: "tile charge-voltage-grid" }, div({ class: "label" }, "Cell voltages by module"), () => {
    chartTick.val;
    const snapshot = cellSnapshot(peek, key => readingStatus(key, true));
    const rows = Array.from({ length: MODULE_COUNT }, (_, index) => ({
      label: String(index + 1),
      cells: Array.from({ length: cellsInModule(index + 1) }, (_, cellIndex) => {
        const cell = snapshot.cells.find(slot => slot.module === index + 1 && slot.cell === cellIndex + 1);
        const value = cell?.value ?? null;
        return {
          value,
          color:
            cell?.state === "fault"
              ? colors.BAD
              : value === null
                ? colors.MUTED
                : colors.spread((snapshot.high ?? 0) - value),
        };
      }),
    }));
    return div(
      heatmap({ rows, columns: MAX_CELLS_PER_MODULE }),
      div(
        { class: "sub" },
        `${snapshot.fresh} of ${CELL_COUNT} fresh · mV below the best; unavailable slots stay empty`
      )
    );
  });
}
function Isolation() {
  return div(
    { class: "tile charge-isolation" },
    div({ class: "label" }, "Isolation"),
    div({ class: "value" }, () => {
      const value = freshValue("iso_test_total");
      return value === null ? statusWord(readingStatus("iso_test_total"), "Not reported") : String(Math.round(value));
    }),
    div({ class: "sub" }, "Raw BMS units · watch for a sudden drop, not the absolute number")
  );
}
function ChargePowerHistory() {
  return div(
    { class: "tile charge-power-history" },
    div({ class: "label", style: () => `color:${chargePowerDisplay().color}` }, () => chargePowerDisplay().label),
    div({ class: "value", style: () => `color:${chargePowerDisplay().color}` }, () => {
      const shown = chargePowerDisplay();
      return `${shown.magnitude}${shown.unit ? ` ${shown.unit}` : ""}`;
    }),
    () => {
      chartTick.val;
      return sparkline({
        values:
          readingStatus("pack_kw", true) === "fresh" ? ringFor("pack_kw").since(600_000, monotonicNow()).values : [],
        color: chargePowerDisplay(true).color,
        minSpan: 5,
      });
    },
    div({ class: "sub" }, "Measured at the pack · last 10 min · history keeps its signed samples")
  );
}
function AcDetails() {
  return div(
    { class: "charge-ac-details" },
    SignalTile({
      key: "dc_a",
      label: "AC pack-side current",
      format: value => Math.abs(value).toFixed(1),
      unit: "A",
      chart: true,
      minSpan: 2,
    }),
    SignalTile({ key: "dc_v", label: "AC pack-side voltage", format: value => value.toFixed(0), unit: "V" }),
    SignalTile({ key: "mains_v", label: "Mains voltage", format: value => value.toFixed(0), unit: "V" }),
    SignalTile({ key: "mains_a", label: "Mains current", format: value => value.toFixed(1), unit: "A" }),
    div(
      { class: "tile" },
      div({ class: "label" }, "BMS grants"),
      .../** @type {[string,string,string][]} */ ([
        ["Current ceiling", "charger_max_dc_a", "A"],
        ["Ceiling voltage", "charger_max_dc_v", "V"],
        ["AC setpoint", "charge_limit_a", "A"],
      ]).map(([label, key, unit]) =>
        Fact(label, () => {
          const value = freshValue(key);
          return value === null ? statusWord(readingStatus(key)) : `${value.toFixed(1)} ${unit}`;
        })
      ),
      Fact("Charger enabled", () =>
        freshValue("charger_enabled") === null
          ? statusWord(readingStatus("charger_enabled"))
          : freshValue("charger_enabled") === 1
            ? "yes"
            : "no"
      )
    )
  );
}
