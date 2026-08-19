// @ts-check

import van from "../vendor/van-1.6.1.js";
import { chartTick, faultState, groupOf, knownKeys, isStale, signalState } from "../lib/store.js";
import { STALE_MS } from "../lib/tiles.js";
import { MUTED } from "../lib/colors.js";
// The handlebar buttons are momentary — a 30 ms press is one frame of a 60 Hz display
// — so a raw 1/0 readout cannot be watched, and BUTTON_GROUP is the switch that picks
// the tile below. Everything else about the group, including that it exists and where
// it sorts, falls out of the registry's `group` field exactly as every other group
// here does — including the section's own count, which is why adding the indicators,
// the high beam and the brake to it needed no change here beyond the wording.
import { BUTTON_GROUP, isFlasher, pressTracker, secondsHeld, secondsSincePress } from "../lib/press.js";

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
 * One handlebar control. Same card as RawTile, but built to be watched rather than read.
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
 * a working button whose flash the browser dropped.
 *
 * …with one substitution, for the members of this group that are not momentary. The
 * brake, and the high beam on a dark road, stay down for seconds or minutes, and "3
 * presses · 2 min ago" is a true sentence that answers the wrong question about a lever
 * that is being pulled RIGHT NOW. So once the bit has been down longer than the
 * threshold in press.js, the second line reports the hold instead of the count — see
 * the note there for why that is a clock reading rather than a hand-written list of
 * which keys are held states, and ../lib/flasher.js for why the two blinkers are
 * nonetheless a named exception to it.
 *
 * ⚠️ That substitution retired a diagnostic this comment used to carry, and the old
 * wording is worth knowing about because it is now a trap. It said "a bit stuck high
 * with a count of 1 is a wiring fault, not a press" — which was true when every signal
 * here was momentary, and is exactly what a squeezed brake lever looks like today. The
 * hold line is what tells them apart: a lever reads "held 4 s" and climbs while you
 * watch, and a stuck bit reads "held 20 min" on a bike nobody is sitting on. So the
 * lit tile is no longer evidence of anything by itself; the duration under it is.
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
  if (Number.isInteger(value)) {
    return String(value);
  }
  return Math.abs(value) >= 100 ? value.toFixed(1) : value.toFixed(2);
}
