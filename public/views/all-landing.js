// @ts-check
// The snapshot stays above the parked raw grid and its filter: docs/fault-report.md.
import van from "../vendor/van-1.6.1.js";
import { freshValue, readingStatus, statusWord } from "../lib/reading-status.js";
import { openDestination } from "../lib/destination.js";
import * as colors from "../lib/colors.js";
import * as units from "../lib/units.js";

const { button, div, span } = van.tags;

/** @param {HTMLElement} filterControl */
export function AllLanding(filterControl) {
  return div(
    { class: "riding-view all-landing" },
    div({ class: "riding-heading" }, "All", div({ class: "sub" }, "Live snapshot")),
    div(
      { class: "all-snapshot-pair" },
      SnapshotReading("pack_kw", "pack_kw (raw)", "− out · + in"),
      SnapshotReading("soc", "soc", "Battery charge")
    ),
    div(
      { class: "all-snapshot-pair" },
      SnapshotReading("gps_speed_kmh", "gps_speed_kmh", "GPS speed"),
      SnapshotReading("batt_temp_hi", "batt_temp_hi", "Hottest battery reading")
    ),
    div(
      { class: "all-snapshot-pair" },
      SnapshotReading("cell_min_mv", "cell_min_mv", "Weakest cell"),
      SnapshotReading("allowed_discharge_a", "allowed_discharge_a", "Drive current limit")
    ),
    filterControl,
    div(
      { class: "all-history-row" },
      div({ class: "sub" }, "Raw signals below"),
      button({ class: "settings-button", onclick: () => openDestination("battery-cooling") }, "Battery history →")
    )
  );
}

/** @param {string} key @param {string} label @param {string} caption */
function SnapshotReading(key, label, caption) {
  return div(
    { class: "tile", "data-snapshot": key },
    div({ class: "label" }, label),
    div({ class: "value", style: () => `color:${snapshotColor(key)}` }, () => {
      const value = freshValue(key);
      return value === null
        ? statusWord(readingStatus(key))
        : span(snapshotNumber(key, value), span({ class: "unit" }, ` ${snapshotUnit(key)}`));
    }),
    div({ class: "sub" }, caption)
  );
}

/** @param {string} key @param {number} value */
function snapshotNumber(key, value) {
  if (key === "pack_kw") return `${value > 0 ? "+" : ""}${value.toFixed(1)}`;
  if (key === "batt_temp_hi") return units.temp(value).toFixed(0);
  if (key === "gps_speed_kmh") return units.speed(value).toFixed(0);
  return value.toFixed(0);
}

/** @param {string} key */
function snapshotUnit(key) {
  if (key === "batt_temp_hi") return units.tempUnit();
  if (key === "gps_speed_kmh") return units.speedUnit();
  return /** @type {Record<string,string>} */ ({
    pack_kw: "kW",
    soc: "%",
    cell_min_mv: "mV",
    allowed_discharge_a: "A",
  })[key];
}

/** @param {string} key */
function snapshotColor(key) {
  const value = freshValue(key);
  if (value === null) return readingStatus(key) === "fault" ? colors.BAD : colors.MUTED;
  if (key === "soc") return colors.stateOfCharge(value);
  if (key === "batt_temp_hi") return colors.temperature(value);
  return colors.CALM;
}
