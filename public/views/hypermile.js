// @ts-check
// Reading meanings, layout budget and preserved findings: docs/range-and-cells.md.
import van from "../vendor/van-1.6.1.js";
import { chartTick, peek } from "../lib/store.js";
import { readingStatus, worstStatus, statusWord, freshValue } from "../lib/reading-status.js";
import { REGEN_CEILING_A, rangeDistanceKey, rangeEnergyKey } from "../lib/range-readings.js";
import {
  headroomMv,
  restingHeadroomMv,
  sagPerCellMv,
  limitFraction,
  remainingWh,
  rollingConsumption,
  rollingRangeKm,
} from "../lib/derive.js";
import { CUTOFF_TIMER_S, dwellSeconds, secondsRemaining } from "../lib/dwell.js";
import { packResistance } from "../lib/pack-resistance-live.js";
import { resistanceNote } from "../lib/pack-resistance.js";
import { monotonicNow } from "../lib/clock.js";
import * as colors from "../lib/colors.js";
import * as units from "../lib/units.js";

const { div, span } = van.tags;
const DISCHARGE_CEILING_A = 400;

export function HypermileView() {
  return div(
    { class: "view riding-view range-view", "data-view": "hypermile" },
    MarginCard(),
    TimerCard(),
    div(
      { class: "range-pair" },
      AllowanceCard("Drive allowed", "allowed_discharge_a", DISCHARGE_CEILING_A),
      AllowanceCard("Regen available", "allowed_regen_a", REGEN_CEILING_A)
    ),
    ConsumptionCard(),
    div({ class: "range-pair range-bottom" }, EnergyCard(), EstimatedRangeCard())
  );
}

function MarginCard() {
  const keys = ["cell_min_mv", "cell_cutoff_mv"];
  return div(
    { class: "tile range-margin" },
    div({ class: "label" }, "Weakest cell above cut-off"),
    div(
      {
        class: "range-margin-number",
        style: () =>
          `color:${worstStatus(keys) === "fault" ? colors.BAD : colors.headroom(worstStatus(keys) === "fresh" ? headroomMv() : null)}`,
      },
      span({ "data-reading": "margin" }, () =>
        worstStatus(keys) === "fresh" ? String(Math.round(headroomMv() ?? 0)) : statusWord(worstStatus(keys))
      ),
      span({ class: "hero-unit" }, () => (worstStatus(keys) === "fresh" ? "mV" : ""))
    ),
    div({ class: "sub", "data-reading": "rest-sag" }, () => {
      const status = worstStatus([...keys, "pack_a"]);
      return status === "fresh"
        ? `${Math.round(restingHeadroomMv() ?? 0)} mV at rest · ${Math.round(sagPerCellMv() ?? 0)} mV sag`
        : `Rest/sag ${statusWord(status)}`;
    }),
    div({ class: "sub", "data-reading": "cutoff" }, () => {
      const cutoff = freshValue("cell_cutoff_mv");
      const identity = freshValue("cell_lowest_v_idx");
      const note = resistanceNote(packResistance.val) || "measured R";
      return `Cut-off ${cutoff === null ? statusWord(readingStatus("cell_cutoff_mv")) : `${cutoff.toFixed(0)} mV`} · BMS index ${identity === null ? statusWord(readingStatus("cell_lowest_v_idx")) : String(identity)} · ${note}`;
    })
  );
}

function TimerCard() {
  return div(
    { class: "tile range-timer" },
    div({ class: "label" }, "Estimated cut-off timer"),
    div(
      {
        class: "value",
        "data-reading": "dwell",
        style: () => `color:${worstStatus(["cell_min_mv", "cell_cutoff_mv"]) === "fault" ? colors.BAD : colors.CALM}`,
      },
      () => {
        chartTick.val;
        const status = worstStatus(["cell_min_mv", "cell_cutoff_mv"]);
        if (status !== "fresh") return statusWord(status);
        return dwellSeconds() < 0.5 && (freshValue("cell_min_mv") ?? 0) >= (freshValue("cell_cutoff_mv") ?? 0)
          ? "clear"
          : `${Math.round(secondsRemaining())} s`;
      }
    ),
    div({ class: "range-rule" }),
    div({ class: "sub" }, `${CUTOFF_TIMER_S} s allowed below cut-off; drains above it`)
  );
}

/** @param {string} label @param {"allowed_discharge_a"|"allowed_regen_a"} key @param {number} ceiling */
function AllowanceCard(label, key, ceiling) {
  return div(
    { class: "tile range-allowance" },
    div({ class: "label" }, label),
    div(
      { class: "value", style: () => `color:${allowanceInk(key, ceiling)}` },
      span({ "data-reading": key }, () =>
        freshValue(key) === null ? statusWord(readingStatus(key)) : String(Math.round(freshValue(key) ?? 0))
      ),
      span({ class: "unit" }, () => (freshValue(key) === null ? "" : "A"))
    ),
    div({ class: "range-share", "data-share": key }, () =>
      freshValue(key) === null
        ? `of ${ceiling} A · ${readingStatus(key) === "missing" ? "unknown" : readingStatus(key)}`
        : `${Math.round(((freshValue(key) ?? 0) / ceiling) * 100)}% of ${ceiling} A`
    ),
    () => {
      const status = readingStatus(key);
      const fraction = status === "fresh" ? limitFraction(key, ceiling) : null;
      const color = allowanceInk(key, ceiling);
      return div(
        {
          class: "range-availability",
          "data-allowance": key,
          "data-state": status,
          role: "img",
          "aria-label":
            fraction === null
              ? `${label} ${status}; configured ${ceiling} A`
              : `${label}: ${freshValue(key)} A of ${ceiling} A`,
        },
        fraction === null ? "" : div({ style: `width:${fraction * 100}%;height:100%;background:${color}` })
      );
    }
  );
}

function ConsumptionCard() {
  return div(
    { class: "tile range-consumption" },
    div({ class: "label" }, "Rolling consumption"),
    div(
      { class: "value" },
      span({ "data-reading": "consumption" }, () => {
        chartTick.val;
        const status = worstStatus(["pack_kw", rangeDistanceKey()]);
        if (status !== "fresh") return statusWord(status);
        const rolling = rollingConsumption(monotonicNow(), peek);
        return rolling.state === "measured"
          ? units.efficiency(rolling.whPerKm).toFixed(0)
          : rolling.state === "regenerating"
            ? "Regen"
            : "—";
      }),
      span({ class: "unit" }, () => {
        chartTick.val;
        return worstStatus(["pack_kw", rangeDistanceKey()]) === "fresh" &&
          rollingConsumption(monotonicNow(), peek).state === "measured"
          ? units.efficiencyUnit()
          : "";
      })
    ),
    div({ class: "sub", "data-reading": "consumption-horizon" }, () => {
      chartTick.val;
      const status = worstStatus(["pack_kw", rangeDistanceKey()]);
      if (status !== "fresh") return `Consumption ${statusWord(status)} · last 5 min`;
      const now = monotonicNow();
      const rolling = rollingConsumption(now, peek);
      if (rolling.state === "waiting") return "Needs about 200 m of riding · last 5 min";
      const horizon = `Last ${units.distance(rolling.km).toFixed(1)} ${units.distanceUnit()}`;
      if (rolling.state === "regenerating") return `${horizon} · putting charge back`;
      return horizon;
    })
  );
}

function EnergyCard() {
  return div(
    { class: "tile range-energy" },
    div({ class: "label" }, "Energy left"),
    div(
      { class: "value" },
      span({ "data-reading": "energy" }, () =>
        worstStatus([rangeEnergyKey()]) === "fresh" && remainingWh() !== null
          ? ((remainingWh() ?? 0) / 1000).toFixed(1)
          : statusWord(readingStatus(rangeEnergyKey()))
      ),
      span({ class: "unit" }, () =>
        worstStatus([rangeEnergyKey()]) === "fresh" && remainingWh() !== null ? "kWh" : ""
      )
    ),
    div({ class: "sub" }, "Bike estimate")
  );
}

function EstimatedRangeCard() {
  return div(
    { class: "tile range-estimate" },
    div({ class: "label" }, "Range at this rate"),
    div(
      {
        class: "value",
        style: () => {
          chartTick.val;
          const estimate = rangeEstimate();
          return `color:${estimate.status === "fault" ? colors.BAD : estimate.kilometres === null ? colors.MUTED : colors.CALM}`;
        },
      },
      span({ "data-reading": "range-estimate" }, () => {
        chartTick.val;
        const estimate = rangeEstimate();
        return estimate.status !== "fresh"
          ? statusWord(estimate.status)
          : estimate.kilometres === null
            ? "—"
            : String(Math.round(units.distance(estimate.kilometres)));
      }),
      span({ class: "unit" }, () => {
        chartTick.val;
        return rangeEstimate().kilometres === null ? "" : units.distanceUnit();
      })
    )
  );
}

function rangeEstimate() {
  const status = worstStatus(["pack_kw", rangeDistanceKey(), rangeEnergyKey(true)], true);
  return { status, kilometres: status === "fresh" ? rollingRangeKm(monotonicNow(), peek) : null };
}

/** @param {"allowed_discharge_a"|"allowed_regen_a"} key @param {number} ceiling */
function allowanceInk(key, ceiling) {
  const status = readingStatus(key);
  if (status !== "fresh") return status === "fault" ? colors.BAD : colors.MUTED;
  const fraction = limitFraction(key, ceiling) ?? 0;
  return key === "allowed_regen_a"
    ? fraction > 0.8
      ? colors.GOOD
      : fraction > 0.4
        ? colors.WATCH
        : colors.WARN
    : fraction > 0.9
      ? colors.GOOD
      : fraction > 0.6
        ? colors.WATCH
        : colors.WARN;
}
