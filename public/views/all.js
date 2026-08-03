// @ts-check

import van from "../vendor/van-1.6.1.js";
import { faultState, groupOf, knownKeys, isStale, signalState } from "../lib/store.js";
import { STALE_MS } from "../lib/tiles.js";
import { MUTED } from "../lib/colors.js";

const { div, input, span } = van.tags;

// Every signal the bike is producing, grouped and searchable.
//
// This is the debugging view, and it is deliberately not designed: it exists so
// that when something looks wrong on one of the other screens there is somewhere to
// go and see the raw number. With ~230 signals now arriving — 81 cell voltages
// among them — the old flat alphabetical grid had stopped being usable, so this one
// groups and filters.

const filter = van.state("");

export function AllView() {
  return div(
    { class: "view" },
    div(
      { class: "filter" },
      input({
        type: "search",
        placeholder: "filter signals…",
        value: filter,
        oninput: (/** @type {Event} */ event) => {
          const target = event.target;
          if (target instanceof HTMLInputElement) {
            filter.val = target.value.toLowerCase();
          }
        },
      })
    ),
    () => {
      const needle = filter.val;
      const keys = knownKeys.val.filter(key => key.includes(needle));
      if (keys.length === 0) {
        return div({ class: "missing", style: `color:${MUTED}` }, "nothing matches");
      }
      /** @type {Map<string, string[]>} */
      const byGroup = new Map();
      for (const key of keys) {
        // groupOf(), not signalState(key).val: reading the state here would
        // subscribe this one binding to all ~230 signals, so any patch — pack_a
        // arrives at frame rate with no deadband — would tear down and rebuild
        // the entire grid, losing any text selection with it.
        const group = groupOf(key);
        const list = byGroup.get(group) ?? [];
        list.push(key);
        byGroup.set(group, list);
      }
      return div(
        ...[...byGroup.entries()]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([group, groupKeys]) =>
            div(
              div({ class: "section" }, `${group} · ${groupKeys.length}`),
              div({ class: "raw-grid" }, ...groupKeys.map(RawTile))
            )
          )
      );
    }
  );
}

/**
 * One signal, rendered generically. Values are shown with whatever precision they
 * need rather than a fixed number of decimals — coordinates are useless at two, and
 * a pack current of 123.456 A is noise at three.
 * @param {string} key
 */
function RawTile(key) {
  const state = signalState(key);
  const fault = faultState(key);
  return div(
    { class: () => `raw${state.val && isStale(key, STALE_MS) ? " stale" : ""}` },
    div({ class: "raw-key" }, key),
    div({ class: "raw-value" }, () => {
      const reading = state.val;
      if (!reading) {
        const rejected = fault.val;
        return rejected ? `⚠ ${rejected.value}` : "–";
      }
      return formatValue(key, reading.value) + (reading.unit ? ` ${reading.unit}` : "");
    }),
    () => {
      const rejected = fault.val;
      // Only worth showing once a good value exists too — otherwise the line above
      // already says the only thing known about this signal.
      return rejected && state.val ? div({ class: "raw-fault" }, `rejected ${rejected.value}`) : span();
    }
  );
}

/**
 * @param {string} key
 * @param {number} value
 */
function formatValue(key, value) {
  if (key === "key_fob_id") {
    // Ten digits of decimal overflow the cell, and hex is what you would compare
    // against the E-LOCK's paired-key list anyway.
    return "0x" + (value >>> 0).toString(16).toUpperCase().padStart(8, "0");
  }
  if (key === "gps_lat" || key === "gps_lon" || key === "waypoint_lat" || key === "waypoint_lon") {
    return value.toFixed(6);
  }
  if (Number.isInteger(value)) {
    return String(value);
  }
  return Math.abs(value) >= 100 ? value.toFixed(1) : value.toFixed(2);
}
