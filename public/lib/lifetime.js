// @ts-check

import van from "../vendor/van-1.6.1.js";
import { groupedReading } from "./format.js";

// The bike's lifetime battery statistics, fetched once when the All tab is first
// shown. Not a signal: nothing broadcasts these, so there is no socket to bind to and
// no staleness to compute — just a file the Pi read off the bike at some point, with
// the age of that reading shown next to it.
//
// See docs/lifetime-battery-statistics.md for what the numbers mean, and why the one
// labelled "charge moved" is a raw count rather than an amount of charge.

/** @typedef {import("../../src/http/lifetime-stats.ts").LifetimeStatsResponse} LifetimeStatsResponse */
/** @typedef {import("../../src/diagnostics/lifetime-stats.ts").LifetimeRow} LifetimeRow */

/** The last fetch's answer, or null before the first one lands. */
export const lifetimeStats = van.state(/** @type {LifetimeStatsResponse | null} */ (null));

/** Why there is nothing to show, or "" when there is. */
export const lifetimeError = van.state("");

let fetched = false;

/**
 * Fetches once per page load, then whenever asked again.
 *
 * Once, because the file only changes when somebody reads the bike — which needs the
 * service stopped, and therefore this page gone. `force` is for the day that stops
 * being true (an in-service read) and for a manual refresh.
 *
 * @param {boolean} [force]
 */
export async function loadLifetimeStats(force = false) {
  if (fetched && !force) {
    return;
  }
  try {
    const response = await fetch("/lifetime-stats");
    if (!response.ok) {
      lifetimeError.val = `the Pi answered ${response.status}`;
      return;
    }
    lifetimeStats.val = /** @type {LifetimeStatsResponse} */ (await response.json());
    lifetimeError.val = "";
    // ⚠️ Only now. Set before the await, a phone that wandered out of wifi once would
    // show "could not reach the Pi" until the page was reloaded — and switching tabs
    // re-enters AllView() but would short-circuit on the guard above.
    fetched = true;
  } catch (err) {
    // Ordinary when the phone has wandered out of wifi range, and worth saying rather
    // than leaving an empty block that looks like a bike with no statistics.
    lifetimeError.val = "could not reach the Pi";
    console.warn("lifetime: fetch failed", err);
  }
}

/**
 * What one row should read as, formatted.
 *
 * ⚠️ Formatting only. Whether a value is trustworthy, in range, or scalable at all is
 * decided in src/diagnostics/lifetime-stats.ts and arrives already decided — this
 * function must never turn a rejected reading into a plausible-looking number.
 *
 * @param {LifetimeRow} row
 */
export function formatLifetimeValue(row) {
  if (row.status === "missing") {
    return "–";
  }
  if (row.status === "rejected") {
    return `⚠ ${row.raw}`;
  }
  if (row.status === "unscaled") {
    return `${row.raw === null ? "–" : groupedReading(row.raw)} raw`;
  }
  const value = row.value;
  if (value === null) {
    return "–";
  }
  return `${groupedReading(value)}${row.unit ? ` ${row.unit}` : ""}`;
}
