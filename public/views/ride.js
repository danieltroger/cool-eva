// @ts-check
// Approved Ride allocation, estimates and signal quality: docs/ride-thermal.md and docs/ride-power.md.
import van from "../vendor/van-1.6.1.js";
import { chartTick, peek, valueOf } from "../lib/store.js";
import { readingStatus, statusWord, freshValue } from "../lib/reading-status.js";
import { currentChargeMode } from "../lib/charge-display.js";
import { powerEdge } from "../lib/power-edge.js";
import { ridePowerState } from "../lib/ride-power-state.js";
import { ridePowerDisplay } from "../lib/ride-power-display.js";
import { rideThermal } from "../lib/ride-thermal.js";
import { differenceByTime, ringFor } from "../lib/ring.js";
import { monotonicNow } from "../lib/clock.js";
import { packResistance } from "../lib/pack-resistance-live.js";
import { settings } from "../lib/settings.js";
import { zeroSparkline } from "../lib/zero-sparkline.js";
import { TemperatureReadings } from "./temperature-readings.js";
import * as colors from "../lib/colors.js";
import * as units from "../lib/units.js";

const { div, span } = van.tags;

export function RideView() {
  return div(
    { class: "view riding-view ride-view layout-page layout-stack", "data-view": "ride" },
    PowerPanel(),
    div(
      { class: "tile layout-card layout-between ride-temperature" },
      span({ class: "ride-label" }, "Battery · low / high"),
      div({ class: "value" }, ...TemperatureReadings(["batt_temp_lo", "batt_temp_hi"]))
    ),
    DeltaCard(),
    HeatCard()
  );
}

function PowerPanel() {
  return div(
    { class: "tile layout-card ride-power" },
    div(
      { class: "layout-between" },
      span({ class: "ride-label ride-upper" }, "Speed"),
      span(
        { class: "ride-label ride-upper", "data-power-direction": "", style: () => `color:${powerDisplay().color}` },
        () => (charging() ? "" : powerDisplay().label)
      )
    ),
    div(
      { class: "layout-between ride-numbers" },
      div(
        { class: "layout-row ride-speed" },
        span({ "data-signal": "gps_speed_kmh" }, () =>
          freshValue("gps_speed_kmh") === null ? "—" : String(Math.round(units.speed(freshValue("gps_speed_kmh") ?? 0)))
        ),
        span({ class: "hero-unit" }, () => (freshValue("gps_speed_kmh") === null ? "" : units.speedUnit()))
      ),
      div(
        { class: "value ride-kilowatts", hidden: charging, style: () => `color:${powerDisplay().color}` },
        span({ "data-signal": "pack_kw" }, () => powerDisplay().magnitude),
        span({ class: "unit" }, () => (currentPower().value === null ? "" : "kW"))
      )
    ),
    () => powerEdge(currentPower(), powerDisplay()),
    div(
      { class: "layout-between ride-statusline" },
      span(
        {
          class: "ride-sub ride-power-status",
          style: () =>
            `color:${!charging() && (currentPower().powerStatus === "fault" || [currentPower().drive.state, currentPower().regen.state].includes("fault")) ? colors.BAD : colors.MUTED}`,
        },
        () => (!charging() && currentPower().status ? currentPower().status : speedNote())
      ),
      span(
        {
          class: "ride-soc",
          "data-signal": "soc",
          hidden: charging,
          style: () => `color:${colors.stateOfCharge(freshValue("soc"))}`,
        },
        () =>
          freshValue("soc") === null
            ? `SOC ${statusWord(readingStatus("soc"))}`
            : `${Math.round(freshValue("soc") ?? 0)}%`
      )
    )
  );
}

function DeltaCard() {
  return div(
    { class: "tile layout-card ride-delta", hidden: () => settings.val?.active.coolantProbesEnabled === false },
    span({ class: "ride-label ride-upper" }, "Coolant ΔT"),
    div(
      {
        class: "value",
        "data-reading": "coolant-delta",
        style: () => `color:${currentThermal().delta === null ? colors.MUTED : colors.GOOD}`,
      },
      () =>
        currentThermal().delta === null
          ? statusWord(currentThermal().deltaStatus)
          : units.tempDelta(currentThermal().delta ?? 0).toFixed(2),
      () => (currentThermal().delta === null ? "" : span({ class: "unit" }, units.tempUnit))
    ),
    () => {
      chartTick.val;
      const current = currentThermal(true);
      const now = monotonicNow();
      const values =
        current.delta === null
          ? []
          : differenceByTime(ringFor("coolant_out").since(600_000, now), ringFor("coolant_in").since(600_000, now)).map(
              units.tempDelta
            );
      return div(
        { class: "ride-trace", "data-trace": current.delta === null ? "unavailable" : "available" },
        current.delta === null ? null : zeroSparkline(values, colors.GOOD)
      );
    }
  );
}

function HeatCard() {
  return div(
    { class: "tile layout-card ride-heat" },
    span({ class: "ride-label ride-upper" }, "Resistance heat / loop removal"),
    div(
      { class: "value" },
      span({ "data-reading": "resistance-heat" }, () =>
        currentThermal().heatWatts === null
          ? statusWord(currentThermal().heatStatus)
          : ((currentThermal().heatWatts ?? 0) / 1000).toFixed(2)
      ),
      () =>
        currentThermal().heatWatts !== null && currentThermal().removalWatts === null
          ? span({ class: "unit" }, "kW")
          : "",
      " / ",
      span({ "data-reading": "loop-removal" }, () =>
        currentThermal().removalWatts === null
          ? statusWord(currentThermal().deltaStatus)
          : ((currentThermal().removalWatts ?? 0) / 1000).toFixed(2)
      ),
      () => (currentThermal().removalWatts === null ? "" : span({ class: "unit" }, "kW"))
    ),
    () => {
      chartTick.val;
      const current = currentThermal(true);
      return div(
        {
          class: "ride-heat-meter",
          role: "img",
          "aria-label": "Resistance heat / loop removal",
          "data-heat-fraction": current.heatFraction === null ? "unknown" : String(current.heatFraction),
        },
        current.heatFraction === null
          ? null
          : span({
              style: `width:${current.heatFraction * 100}%;background:${(current.heatWatts ?? 0) > (current.removalWatts ?? 0) ? colors.BAD : colors.GOOD}`,
            })
      );
    }
  );
}

function currentPower() {
  return ridePowerState(valueOf, readingStatus, charging());
}
function charging() {
  return currentChargeMode() !== "none";
}
function powerDisplay() {
  const speed = freshValue("speed_can_kmh") ?? freshValue("speed_kmh") ?? freshValue("gps_speed_kmh");
  return ridePowerDisplay(currentPower(), speed !== null && speed > 0);
}
function speedNote() {
  if (freshValue("gps_speed_kmh") === null) return `GPS speed ${statusWord(readingStatus("gps_speed_kmh"))}`;
  const wheel = freshValue("speed_can_kmh") ?? freshValue("speed_kmh");
  return wheel === null ? "GPS · no wheel speed" : `GPS · wheel ${Math.round(units.speed(wheel))}`;
}
/** @param {boolean} [sampled] */
function currentThermal(sampled = false) {
  return rideThermal(
    sampled ? peek : valueOf,
    key => readingStatus(key, sampled),
    (sampled ? packResistance.rawVal : packResistance.val).milliohms,
    (sampled ? settings.rawVal : settings.val)?.active.coolantProbesEnabled !== false
  );
}
