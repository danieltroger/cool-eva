// @ts-check
import van from "../vendor/van-1.6.1.js";
import { chartTick } from "../lib/store.js";
import { freshValue, readingStatus } from "../lib/reading-status.js";
import * as colors from "../lib/colors.js";
import * as units from "../lib/units.js";

/** @param {string[]} keys @param {number} [decimals] */
export function TemperatureReadings(keys, decimals = 0) {
  return keys.flatMap((key, index) => [
    index ? " / " : "",
    van.tags.span(
      {
        "data-signal": key,
        style: () =>
          `color:${readingStatus(key) === "fault" ? colors.BAD : readingStatus(key) !== "fresh" ? colors.MUTED : colors.temperature(freshValue(key))}`,
      },
      () => {
        chartTick.val;
        const reading = freshValue(key);
        const state = readingStatus(key);
        return reading === null ? (state === "missing" ? "—" : state) : units.temp(reading).toFixed(decimals);
      }
    ),
    () =>
      freshValue(key) !== null && !keys.slice(index + 1).some(next => freshValue(next) !== null)
        ? van.tags.span({ class: "unit" }, units.tempUnit)
        : "",
  ]);
}
