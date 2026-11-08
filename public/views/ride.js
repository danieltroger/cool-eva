// @ts-check
// Instrument geometry and thermal provenance: docs/ride-power.md and docs/ride-thermal.md.
// Conditional units keep a text anchor: VanJS cannot revive a binding whose first result is null.
import van from "../vendor/van-1.6.1.js";
import { chartTick, valueOf } from "../lib/store.js";
import { readingStatus, worstStatus, statusWord, freshValue } from "../lib/reading-status.js";
import { currentChargeMode } from "../lib/charge-display.js";
import { powerEdge } from "../lib/power-edge.js";
import { ridePowerState } from "../lib/ride-power-state.js";
import { ridePowerDisplay } from "../lib/ride-power-display.js";
import { differenceByTime, ringFor } from "../lib/ring.js";
import { monotonicNow } from "../lib/clock.js";
import { COOLANT_WATTS_PER_KELVIN } from "../lib/derive.js";
import { packResistance } from "../lib/pack-resistance-live.js";
import { resistanceNote } from "../lib/pack-resistance.js";
import { sparkline } from "../lib/svg.js";
import * as colors from "../lib/colors.js";
import * as units from "../lib/units.js";

const { div, span } = van.tags;

export function RideView() {
  return div(
    { class: "view riding-view ride-view", "data-view": "ride" },
    PowerPanel(),
    DeltaCard(),
    HeatCard(),
    div(
      { class: "ride-pair" },
      TemperatureCard("Battery · min / max", ["batt_temp_lo", "batt_temp_hi"], "Across the battery"),
      TemperatureCard("Motor / OBD", ["motor_temp_c", "bike_coolant_temp"], "Separate sensors")
    )
  );
}

function PowerPanel() {
  return div(
    { class: "tile ride-power" },
    div(
      { class: "ride-row" },
      div({ class: "label" }, "Speed"),
      div(
        { class: "label", "data-power-direction": "", style: () => `color:${powerDisplay().color}` },
        () => powerDisplay().label
      )
    ),
    div(
      { class: "ride-row ride-numbers" },
      div(
        { class: "ride-speed" },
        span({ "data-signal": "gps_speed_kmh" }, () =>
          freshValue("gps_speed_kmh") === null ? "—" : String(Math.round(units.speed(valueOf("gps_speed_kmh") ?? 0)))
        ),
        span({ class: "hero-unit" }, () => (freshValue("gps_speed_kmh") === null ? "" : units.speedUnit()))
      ),
      div(
        { class: "value ride-kilowatts", style: () => `color:${powerDisplay().color}` },
        span({ "data-signal": "pack_kw" }, () => powerDisplay().magnitude),
        span({ class: "unit" }, () => (currentPower().value === null ? "" : "kW"))
      )
    ),
    div(
      { class: "ride-row ride-statusline" },
      div(
        {
          class: "sub ride-power-status",
          style: () => {
            const state = currentPower();
            return `color:${state.powerStatus === "fault" || (!state.charging && [state.drive.state, state.regen.state].includes("fault")) ? colors.BAD : colors.MUTED}`;
          },
        },
        () => currentPower().status || speedNote()
      ),
      span(
        { class: "ride-soc", "data-signal": "soc", style: () => `color:${colors.stateOfCharge(freshValue("soc"))}` },
        () =>
          freshValue("soc") === null ? `SOC ${statusWord(readingStatus("soc"))}` : `${Math.round(valueOf("soc") ?? 0)}%`
      )
    ),
    () => powerEdge(currentPower(), powerDisplay())
  );
}

function currentPower() {
  return ridePowerState(valueOf, readingStatus, currentChargeMode() !== "none");
}

function powerDisplay() {
  const speed = freshValue("speed_can_kmh") ?? freshValue("speed_kmh") ?? freshValue("gps_speed_kmh");
  return ridePowerDisplay(currentPower(), speed !== null && speed > 0);
}

function speedNote() {
  const speed = freshValue("gps_speed_kmh");
  if (speed === null) return `GPS speed ${statusWord(readingStatus("gps_speed_kmh"))}`;
  const wheel = freshValue("speed_can_kmh") ?? freshValue("speed_kmh");
  if (wheel === null) return "GPS · no wheel speed";
  const difference = units.speed(wheel) - units.speed(speed);
  return `GPS · wheel ${Math.round(units.speed(wheel))} (${difference >= 0 ? "+" : "−"}${Math.abs(difference).toFixed(0)})`;
}

function DeltaCard() {
  return div(
    { class: "tile ride-delta" },
    div({ class: "label" }, "Coolant ΔT"),
    div(
      {
        class: "value",
        style: () => `color:${delta() === null ? colors.MUTED : colors.GOOD}`,
        "data-reading": "coolant-delta",
      },
      () => (delta() === null ? statusWord(thermalStatus()) : units.tempDelta(delta() ?? 0).toFixed(2)),
      span({ class: "unit" }, () => (delta() === null ? "" : units.tempUnit()))
    ),
    () => {
      chartTick.val;
      const now = monotonicNow();
      const available = thermalStatus(true) === "fresh";
      const values = available
        ? differenceByTime(ringFor("coolant_out").since(600_000, now), ringFor("coolant_in").since(600_000, now))
        : [];
      return div(
        { class: "ride-trace", "data-trace": available ? "available" : "unavailable" },
        available
          ? sparkline({ values, color: colors.GOOD, minSpan: 0.5, baseline: 0, height: 40 })
          : div({ class: "sub" }, `ΔT ${statusWord(thermalStatus(true))}`)
      );
    },
    div({ class: "sub" }, "out − in · last 10 min")
  );
}

function HeatCard() {
  return div(
    { class: "tile ride-heat" },
    div({ class: "label" }, "Resistance heat / loop removal"),
    div(
      { class: "value" },
      span({ "data-reading": "resistance-heat" }, () =>
        heat() === null ? statusWord(readingStatus("pack_a")) : ((heat() ?? 0) / 1000).toFixed(2)
      ),
      () => (heat() !== null && delta() === null ? span({ class: "unit" }, "kW") : ""),
      " / ",
      span({ "data-reading": "loop-removal" }, () =>
        delta() === null ? statusWord(thermalStatus()) : (((delta() ?? 0) * COOLANT_WATTS_PER_KELVIN) / 1000).toFixed(2)
      ),
      span({ class: "unit" }, () => (delta() === null ? "" : "kW"))
    ),
    div({ class: "sub" }, () => {
      const output = freshValue("pack_kw");
      const loss = heat();
      const share =
        output === null || Math.abs(output) < 0.3 || loss === null
          ? "Output share unavailable"
          : `${((loss / (Math.abs(output) * 1000)) * 100).toFixed(1)}% of output`;
      const note = loss === null ? "" : resistanceNote(packResistance.val);
      return loss === null ? share : `${share}${note ? ` · ${note}` : " · measured R"}`;
    }),
    div({ class: "sub" }, "Rated flow · estimated loop removal")
  );
}

/** @param {string} label @param {string[]} keys @param {string} caption */
function TemperatureCard(label, keys, caption) {
  return div(
    { class: "tile ride-temperature" },
    div({ class: "label" }, label),
    div(
      { class: "value" },
      ...keys.flatMap((key, index) => [
        index ? "/" : "",
        span(
          {
            "data-signal": key,
            style: () => `color:${readingStatus(key) === "fault" ? colors.BAD : colors.temperature(freshValue(key))}`,
          },
          () => {
            const reading = freshValue(key);
            return reading === null ? "—" : units.temp(reading).toFixed(0);
          }
        ),
        () =>
          freshValue(key) !== null && !keys.slice(index + 1).some(next => freshValue(next) !== null)
            ? span({ class: "unit" }, units.tempUnit)
            : "",
      ])
    ),
    div({ class: "sub" }, () => {
      const states = keys.map(key => readingStatus(key));
      if (states.every(state => state === "fresh")) return caption;
      const names = keys[0] === "batt_temp_lo" ? ["min", "max"] : ["motor", "OBD"];
      return states.map((state, index) => `${names[index]} ${state}`).join(" · ");
    })
  );
}

/** @param {boolean} [sampled] @returns {import("../lib/reading-status.js").ReadingStatus} */
function thermalStatus(sampled = false) {
  return worstStatus(["coolant_in", "coolant_out"], sampled);
}

function delta() {
  return thermalStatus() === "fresh" ? (valueOf("coolant_out") ?? 0) - (valueOf("coolant_in") ?? 0) : null;
}

function heat() {
  const amps = freshValue("pack_a");
  return amps === null ? null : (amps * amps * packResistance.val.milliohms) / 1000;
}
