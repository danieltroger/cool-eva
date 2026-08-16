// @ts-check

import van from "../vendor/van-1.6.1.js";
import { chartTick, faultState, groupOf, knownKeys, isStale, signalState } from "../lib/store.js";
import { STALE_MS } from "../lib/tiles.js";
import { MUTED } from "../lib/colors.js";
// The handlebar buttons are momentary — a 30 ms press is one frame of a 60 Hz display
// — so a raw 1/0 readout cannot be watched, and BUTTON_GROUP is the switch that picks
// the tile below. Everything else about the group, including that it exists and where
// it sorts, falls out of the registry's `group` field exactly as every other group
// here does.
import { BUTTON_GROUP, pressTracker, secondsSincePress } from "../lib/press.js";

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
              div({ class: "raw-grid" }, ...groupKeys.map(group === BUTTON_GROUP ? ButtonTile : RawTile))
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
 * One handlebar button. Same card as RawTile, but built to be watched rather than read.
 *
 * Three readouts, in decreasing order of how much you should trust them:
 *
 *   • the press COUNT, which cannot be missed by looking away, by a backgrounded tab
 *     or by a reconnect;
 *   • how long ago the last press was, so a count that moved while you were looking at
 *     the bars is still attributable to the button you just pressed;
 *   • the lit state, which is the fastest to read and the easiest to miss.
 *
 * Never trust the light alone: a bit that is never seen high but whose count climbs is
 * a working button whose flash the browser dropped, and a bit stuck high with a count
 * of 1 is a wiring fault, not a press.
 * @param {string} key
 */
function ButtonTile(key) {
  const state = signalState(key);
  const fault = faultState(key);
  const tracker = pressTracker(key);
  return div(
    { class: () => `raw${tracker.lit.val ? " pressed" : ""}${state.val && isStale(key, STALE_MS) ? " stale" : ""}` },
    div({ class: "raw-key" }, key),
    div({ class: "raw-value" }, () => {
      if (!state.val) {
        // Three different nothings, and they must not look alike. A REJECTED reading
        // is shown as the fault it is: bounds.js gates this group to 0/1 precisely so
        // that a decoder returning the masked byte (`handlebar & 0x20` is 32, not 1)
        // cannot pass for a button at rest, and swallowing it here would undo that.
        // A plain "–" means the frame has never arrived at all — which on 0x400's four
        // bits is also what a missing RX filter looks like, and is worth telling apart
        // from a button nobody has pressed.
        const rejected = fault.val;
        return rejected ? `⚠ ${rejected.value}` : "–";
      }
      return tracker.lit.val ? "PRESSED" : "idle";
    }),
    div({ class: "raw-sub" }, () => {
      // chartTick paces the "ago" counter: nothing arrives to mark the passing of a
      // second, so without this the age would freeze at whatever it was when the last
      // press repainted the tile.
      chartTick.val;
      const count = tracker.count.val;
      if (count === 0) {
        return "no presses yet";
      }
      const ago = secondsSincePress(key);
      const label = count === 1 ? "1 press" : `${count} presses`;
      return ago === null ? label : `${label} · ${formatAgo(ago)} ago`;
    })
  );
}

/**
 * @param {number} seconds
 */
function formatAgo(seconds) {
  if (seconds < 60) {
    return `${Math.round(seconds)} s`;
  }
  if (seconds < 3600) {
    return `${Math.round(seconds / 60)} min`;
  }
  return `${Math.round(seconds / 3600)} h`;
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
