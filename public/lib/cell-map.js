// @ts-check
// Latest samples keep the existing bounded holds and neutral aged ink: docs/cell-module-map.md.
import { ageOf } from "./store.js";
import { freshValue, readingStatus, readingCanColour, STALE_MS } from "./reading-status.js";
import { moduleTemperatureKey } from "./cells.js";
import * as colors from "./colors.js";

/** @typedef {"temperature"|"balance"} CellMapMetric */
/** @param {import("./pack-layout.js").PackCell} cell @param {CellMapMetric} metric */
export function cellMapReading(cell, metric) {
  const key = metric === "balance" ? cell.key : moduleTemperatureKey(cell.lmu, "bat1");
  return {
    key,
    state: key === null ? /** @type {const} */ ("absent") : readingStatus(key, true),
    value: key === null ? null : freshValue(key, true),
    current: key !== null && readingCanColour(key, true),
    age: key === null ? Infinity : Math.max(0, ageOf(key)),
  };
}
/** @typedef {ReturnType<typeof cellMapReading>} CellMapReading */

/** @param {CellMapReading} reading @param {CellMapMetric} metric @param {number|null} reference */
export function cellMapColour(reading, metric, reference) {
  if (reading.state === "fault") return colors.BAD;
  if (reading.value === null) return "var(--tile)";
  if (!reading.current || (metric === "balance" && reference === null)) return colors.MUTED;
  const amount =
    metric === "temperature" ? (reading.value - 38) / 12 : Math.max(0, (reference ?? 0) - reading.value) / 40;
  const percentage = Math.min(100, Math.max(0, amount * 100));
  return `color-mix(in srgb,var(--warn) ${percentage}%,${metric === "temperature" ? colors.COLD : colors.GOOD})`;
}

/** @param {number} milliseconds */
export function cellAgeText(milliseconds) {
  if (!Number.isFinite(milliseconds)) return "—";
  if (milliseconds <= STALE_MS) return "now";
  if (milliseconds < 60_000) return `${Math.floor(milliseconds / 1000)}s`;
  if (milliseconds < 3_600_000) return `${Math.floor(milliseconds / 60_000)}m`;
  return `${Math.floor(milliseconds / 3_600_000)}h`;
}

/** @param {CellMapReading[]} readings */
export function cellMapAge(readings) {
  const available = readings.filter(reading => reading.value !== null);
  if (!available.length) {
    return readings.some(reading => reading.state === "fault")
      ? "fault"
      : readings.some(reading => reading.state === "stale")
        ? "stale"
        : "—";
  }
  return cellAgeText(Math.max(...available.map(reading => reading.age)));
}
