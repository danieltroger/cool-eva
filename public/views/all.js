// @ts-check

import van from "../vendor/van-1.6.1.js";
import { chartTick, faultState, groupOf, knownKeys, isStale, signalState } from "../lib/store.js";
import { STALE_MS } from "../lib/tiles.js";
import { MUTED } from "../lib/colors.js";
// A 30 ms press is one frame of a 60 Hz display, so a signal whose edges are the event
// cannot be watched as a raw 1/0. getsLatchedTile() picks the tile below, per KEY rather
// than per group. The sections themselves — that they exist, where they sort, what they
// count — still fall out of the registry's `group` field, as every other group here does.
import { getsLatchedTile } from "../lib/latched.js";
import { isFlasher, pressTracker, secondsHeld, secondsSincePress } from "../lib/press.js";
import { formatLifetimeValue, lifetimeError, lifetimeStats, loadLifetimeStats } from "../lib/lifetime.js";
import { ageInWords, reading } from "../lib/format.js";

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
  // Fetched here rather than at module scope: it is one request, and it should happen
  // when somebody looks at this tab rather than on every page load.
  void loadLifetimeStats();
  return div(
    { class: "view" },
    LifetimeBlock(),
    div(
      { class: "filter" },
      input({
        "type": "search",
        // Named for the same DevTools issue as the two write controls; there is nothing to
        // autofill a signal filter from, and a remembered list over it would only be in the way.
        "name": "signal-filter",
        "autocomplete": "off",
        "placeholder": "filter signals…",
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
              div(
                { class: "raw-grid" },
                ...groupKeys.map(key => (getsLatchedTile(key, group) ? ButtonTile(key) : RawTile(key)))
              )
            )
          )
      );
    }
  );
}

/**
 * The bike's lifetime battery statistics, above the grid.
 *
 * ⚠️ PINNED RATHER THAN A SECTION OF THE GRID, and the reason is not layout: these are
 * not signals. They have no arrival time and no staleness, so `groupOf` and
 * `isStale(key, STALE_MS)` — which every tile below depends on — have nothing true to
 * say about them, and a "lifetime" group sorting alphabetically between `gps` and
 * `motor` would be findable only by somebody who already knew it was there.
 *
 * It still OBEYS the filter, so the one interaction this view has keeps working: type
 * anything and these rows narrow with the rest, and the block disappears when none of
 * them match. docs/dashboard-decisions.md § "The lifetime block".
 */
function LifetimeBlock() {
  return () => {
    const needle = filter.val;
    const response = lifetimeStats.val;
    if (!response) {
      const failure = lifetimeError.val;
      return failure && needle === "" ? div({ class: "section" }, `lifetime · ${failure}`) : div();
    }
    if (!response.reading) {
      // Not an error: most Pis have never taken one. Says how, because the answer is a
      // command somebody has to run at the bike with the service stopped.
      return needle === ""
        ? div(
            div({ class: "section" }, "lifetime · never read"),
            div({ class: "raw-grid" }, div({ class: "raw" }, div({ class: "raw-sub" }, response.howToRead)))
          )
        : div();
    }
    const { statistics, source } = response.reading;
    const rows = statistics.rows.filter(row => row.key.includes(needle) || row.label.includes(needle));
    if (rows.length === 0) {
      return div();
    }
    return div(
      div(
        { class: "section" },
        `lifetime · read ${ageInWords(statistics.readAt)}${statistics.complete ? "" : " · INCOMPLETE"}` +
          `${source === "service" ? "" : " · service stopped"}`
      ),
      div({ class: "raw-grid" }, ...rows.map(LifetimeTile))
    );
  };
}

/**
 * One lifetime number, in the same tile the grid uses.
 *
 * The note is the load-bearing half for two of these rows — `charge moved` carries a
 * raw count and the reason it is not an amount of charge — so it is rendered at the
 * same weight as a rejected reading rather than tucked away.
 *
 * @param {import("../../src/diagnostics/lifetime-stats.ts").LifetimeRow} row
 */
function LifetimeTile(row) {
  return div(
    { class: `raw${row.status === "rejected" || row.status === "missing" ? " stale" : ""}` },
    div({ class: "raw-key" }, row.label),
    div({ class: "raw-value" }, formatLifetimeValue(row)),
    row.detail.length > 0 ? div({ class: "raw-sub" }, row.detail.join(" · ")) : span(),
    row.note ? div({ class: row.status === "rejected" ? "raw-fault" : "raw-sub" }, row.note) : span()
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
 * One control a person presses — the whole `buttons` group, plus the per-key exceptions in
 * ../lib/latched.js. Same card as RawTile, but built to be watched rather than read.
 *
 * Three readouts, in decreasing order of how much you should trust them: the press
 * COUNT, how long ago the last press was, and the lit state. ⚠️ Never trust the light
 * alone — a bit never seen high but whose count climbs is a working button whose flash
 * the browser dropped — and never trust a LIT tile alone either, which is the newer
 * trap: once the bit has been down longer than press.js's threshold the second line
 * reports the hold rather than the count, so a squeezed brake lever and a stuck bit look
 * identical until you read the duration under it.
 *
 * See docs/dashboard-decisions.md §"The button tile's three readouts", and
 * ../lib/flasher.js for why the two blinkers are a named exception.
 * @param {string} key
 */
function ButtonTile(key) {
  const state = signalState(key);
  const fault = faultState(key);
  const tracker = pressTracker(key);
  // The blinkers are the lamp outputs of a 1.46 Hz flasher, so every word this tile
  // would otherwise use is wrong about them: nobody "presses" a turn signal for eight
  // seconds. Same tile, same classes, same layout — only the nouns change.
  const flasher = isFlasher(key);
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
      if (!tracker.lit.val) {
        return "idle";
      }
      return flasher ? "FLASHING" : "PRESSED";
    }),
    div({ class: "raw-sub" }, () => {
      // chartTick paces both counters below: nothing arrives to mark the passing of a
      // second — these signals log on change and a held brake sends nothing at all —
      // so without this the age would freeze at whatever it was when the last press
      // repainted the tile, and a hold would never tick past its first reading.
      chartTick.val;
      // Read through the state, not just the sampled helper, so that the line also
      // repaints the instant the bit drops rather than up to 500 ms later.
      tracker.downSince.val;
      const held = secondsHeld(key);
      if (held !== null) {
        return `${flasher ? "flashing" : "held"} ${formatAgo(held)}`;
      }
      const count = tracker.count.val;
      if (count === 0) {
        return flasher ? "not used yet" : "no presses yet";
      }
      const ago = secondsSincePress(key);
      // "12 uses" for an indicator: one use is one signalled turn, however many times
      // the flasher blinked during it. press.js is what makes that a use and not 89.
      const noun = flasher ? "use" : "press";
      const label = count === 1 ? `1 ${noun}` : `${count} ${noun}s`;
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
  // ../lib/format.js, so the pinned lifetime block above this grid and the grid itself
  // cannot disagree about what "precise" means a centimetre apart.
  return reading(value);
}
