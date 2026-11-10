// @ts-check
// Reading meanings, layout budget and preserved findings: docs/range-and-cells.md.
import van from "../vendor/van-1.6.1.js";
import { chartTick, peek } from "../lib/store.js";
import { readingStatus, worstStatus, statusWord, freshValue } from "../lib/reading-status.js";
import {
  REGEN_CEILING_A,
  HYPERMILE_HEADROOM_MV,
  driveKey,
  energyEmpty,
  compensatedThresholds,
  rangeDistanceKey,
  rangeEnergyKey,
} from "../lib/range-readings.js";
import {
  loadStoredParameters,
  serviceOperation,
  readServiceParameter,
  currentParameterReading,
  serviceCatalogue,
} from "../lib/service-client.js";
import { parameterReadingNamed } from "../lib/service-parameter-readings.js";
import { limitKw } from "../lib/power-limits.js";
import { limitFraction, remainingWh, rollingConsumption, rollingRangeKm } from "../lib/derive.js";
import { monotonicNow } from "../lib/clock.js";
import * as colors from "../lib/colors.js";
import * as units from "../lib/units.js";

const { div, span } = van.tags;
const DISCHARGE_CEILING_A = 400;

export function HypermileView() {
  void loadVcuLimits();
  return div(
    { class: "view riding-view range-view", "data-view": "hypermile" },
    MarginCard(),
    div(
      { class: "range-pair" },
      AllowanceCard("Drive allowed", driveKey, DISCHARGE_CEILING_A),
      AllowanceCard("Regen available", () => "allowed_regen_a", REGEN_CEILING_A)
    ),
    ConsumptionCard(),
    div({ class: "range-pair range-bottom" }, EnergyCard(), EstimatedRangeCard())
  );
}

async function loadVcuLimits() {
  await loadStoredParameters();
  await serviceOperation(async () => {
    for (const name of ["LIMP_MIN_CELL", "CELL_UNDERVOLTAGE"]) {
      const parameter = serviceCatalogue.rawVal?.parameters.find(parameter => parameter.name === name);
      if (!parameter || currentParameterReading(parameter, true)) continue;
      if (!(await readServiceParameter(parameter))) return;
    }
  });
}

function MarginCard() {
  return div({ class: "tile range-margin" }, div({ class: "label" }, "Weakest cell"), () => {
    chartTick.val;
    const minimum = freshValue("cell_min_mv", true);
    const limpMv = parameterReadingNamed("LIMP_MIN_CELL")?.value;
    const stopMv = parameterReadingNamed("CELL_UNDERVOLTAGE")?.value;
    const row = { class: "range-margin-number" };
    if (minimum === null)
      return div(
        row,
        span(
          {
            "data-reading": "margin",
            style: `color:${readingStatus("cell_min_mv", true) === "fault" ? colors.BAD : colors.MUTED}`,
          },
          statusWord(readingStatus("cell_min_mv", true))
        )
      );
    if (limpMv === undefined || stopMv === undefined)
      return div(row, span({ "data-reading": "margin" }, "VCU limits not read"));
    const { limp, stop } = compensatedThresholds(
      limpMv,
      stopMv,
      freshValue("pack_a", true),
      freshValue("limp_pack_res", true)
    );
    return div(
      row,
      span(minimum > limp ? "Limp in" : "Limp"),
      minimum > limp
        ? [
            span(
              { "data-reading": "limp-margin", style: `color:${colors.headroom(minimum - limp)}` },
              String(Math.round(minimum - limp))
            ),
            span("mV"),
          ]
        : [],
      span(minimum < stop ? "·" : "· stop in"),
      span(
        { "data-reading": "margin", style: `color:${colors.headroom(minimum - stop)}` },
        String(Math.round(Math.abs(minimum - stop)))
      ),
      span(minimum < stop ? "mV under stop" : "mV")
    );
  });
}

/** @param {string} label @param {()=>"allowed_discharge_a"|"current_max_out_a"|"allowed_regen_a"} signalKey @param {number} ceiling */
function AllowanceCard(label, signalKey, ceiling) {
  const identifier = label === "Drive allowed" ? "drive-allowed" : "allowed_regen_a";
  return div(
    { class: "tile range-allowance" },
    div({ class: "label" }, label),
    div(
      { class: "value", style: () => `color:${allowanceInk(signalKey(), ceiling)}` },
      span({ "data-reading": identifier }, () =>
        freshValue(signalKey()) === null
          ? statusWord(readingStatus(signalKey()))
          : String(Math.round(freshValue(signalKey()) ?? 0))
      ),
      span({ class: "unit" }, () => (freshValue(signalKey()) === null ? "" : "A"))
    ),
    div({ class: "range-share", "data-share": identifier }, () => {
      const kilowatts = limitKw(freshValue(signalKey()), freshValue("pack_v"));
      return kilowatts === null ? "— kW" : `≈ ${kilowatts.toFixed(1)} kW`;
    }),
    () => {
      const status = readingStatus(signalKey());
      const fraction = status === "fresh" ? limitFraction(signalKey(), ceiling) : null;
      const color = allowanceInk(signalKey(), ceiling);
      return div(
        {
          class: "range-availability",
          "data-allowance": identifier,
          "data-state": status,
          role: "img",
          "aria-label":
            fraction === null
              ? `${label} ${status}; configured ${ceiling} A`
              : `${label}: ${freshValue(signalKey())} A of ${ceiling} A`,
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
      { class: "value", "data-alert": () => String(energyEmpty()) },
      span({ "data-reading": "energy" }, () =>
        energyEmpty()
          ? "Empty — charge now"
          : worstStatus([rangeEnergyKey()]) === "fresh" && remainingWh() !== null
            ? ((remainingWh() ?? 0) / 1000).toFixed(1)
            : statusWord(readingStatus(rangeEnergyKey()))
      ),
      span({ class: "unit" }, () =>
        !energyEmpty() && worstStatus([rangeEnergyKey()]) === "fresh" && remainingWh() !== null ? "kWh" : ""
      )
    )
  );
}

function EstimatedRangeCard() {
  return div(
    { class: "tile range-estimate" },
    div({ class: "label" }, "Range at this rate"),
    div(
      {
        class: "value",
        "data-alert": () => String(!!rangeEstimate().alert),
        style: () => {
          chartTick.val;
          const estimate = rangeEstimate();
          return `color:${estimate.alert || estimate.status === "fault" ? colors.BAD : estimate.kilometres === null ? colors.MUTED : colors.CALM}`;
        },
      },
      span({ "data-reading": "range-estimate" }, () => {
        chartTick.val;
        const estimate = rangeEstimate();
        return (
          estimate.alert ||
          (estimate.status !== "fresh"
            ? statusWord(estimate.status)
            : estimate.kilometres === null
              ? "—"
              : String(Math.round(units.distance(estimate.kilometres))))
        );
      }),
      span({ class: "unit" }, () => {
        chartTick.val;
        return rangeEstimate().kilometres === null ? "" : units.distanceUnit();
      })
    )
  );
}

function rangeEstimate() {
  chartTick.val;
  const status = worstStatus(["pack_kw", rangeDistanceKey(), rangeEnergyKey(true)], true);
  const minimum = freshValue("cell_min_mv", true);
  const limpMv = parameterReadingNamed("LIMP_MIN_CELL")?.value;
  const limp =
    limpMv === undefined
      ? undefined
      : compensatedThresholds(limpMv, limpMv, freshValue("pack_a", true), freshValue("limp_pack_res", true)).limp;
  const alert = energyEmpty(key => freshValue(key, true))
    ? "Empty — charge now"
    : minimum !== null && limp !== undefined && minimum - limp <= HYPERMILE_HEADROOM_MV
      ? "Range uncertain — charge now"
      : "";
  return { status, alert, kilometres: !alert && status === "fresh" ? rollingRangeKm(monotonicNow(), peek) : null };
}

/** @param {"allowed_discharge_a"|"current_max_out_a"|"allowed_regen_a"} key @param {number} ceiling */
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
