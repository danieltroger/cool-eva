// @ts-check

import van from "../vendor/van-1.6.1.js";
import { chartTick, faultState, isStale, peekServerTime, signalState } from "./store.js";
import { ringFor } from "./ring.js";
import { monotonicNow } from "./clock.js";
import { sparkline } from "./svg.js";
import { CALM, MUTED } from "./colors.js";

const { div, span } = van.tags;

// The shared furniture every view is built from.
//
// Reactive parts are passed as functions, not values, so each binding subscribes
// to exactly the signals it reads. That is what keeps a 20 Hz `pack_a` frame from
// touching anything except the two text nodes that show pack_a.

/** A value not refreshed within this long is shown greyed rather than as truth. */
export const STALE_MS = 8000;

/** A fault older than this stops being shouted about — the sensor recovered. */
const FAULT_MEMORY_MS = 60_000;

/**
 * A tile for a signal that has never arrived takes up as much room as one showing a
 * number, and the ride screen ends up mostly empty boxes: no Bluetooth link means no
 * odometer, no OBD poller means no ambient temperature, an unplugged probe means no
 * coolant. Those tiles collapse instead.
 *
 * Never-seen is not the same as faulted. A signal that arrived and then went out of
 * range keeps its tile and shows the fault — hiding that would hide exactly the thing
 * worth knowing.
 * @param {string} key
 */
function hasEverArrived(key) {
  return signalState(key).val != null || faultState(key).val != null;
}

/**
 * A tick-paced trace of one signal's recent history.
 *
 * Bound to the tick, not to the signal: redrawing a polyline on every frame of a
 * 20 Hz signal is pure battery drain for motion no eye can use. The colour is
 * sampled off the ring rather than read from the signal state for the same reason
 * — reading `.val` here would re-subscribe this binding to the signal and cancel
 * the throttle entirely.
 *
 * Shared by SignalTile and PairTile so the pacing rule has one home; it is exactly
 * the kind of thing that gets fixed in one copy and not the other.
 * @param {string} key
 * @param {((value: number | null) => string) | undefined} color
 * @param {number} chartWindowMs
 * @param {number} minSpan
 */
function trace(key, color, chartWindowMs, minSpan) {
  return () => {
    chartTick.val;
    const ring = ringFor(key);
    const { values } = ring.since(chartWindowMs, monotonicNow());
    return sparkline({ values, color: color ? color(ring.latest()) : CALM, minSpan });
  };
}

/**
 * The standard readout: small label, large number, small unit, optional second line.
 * @param {object} options
 * @param {string} options.label
 * @param {() => string} options.value
 * @param {string} [options.unit]
 * @param {() => string} [options.sub]
 * @param {() => string} [options.color]
 * @param {string} [options.className]
 * @param {(Element | (() => Element))[]} [options.extra]
 */
export function Tile({ label, value, unit = "", sub, color, className = "", extra = [] }) {
  return div(
    { class: `tile ${className}` },
    div({ class: "label" }, label),
    div(
      { class: "value", style: () => (color ? `color:${color()}` : "") },
      value,
      unit ? span({ class: "unit" }, unit) : null
    ),
    sub ? div({ class: "sub" }, sub) : null,
    ...extra
  );
}

/**
 * A tile bound to one signal, with the staleness and fault handling every
 * signal-backed readout needs. This is where the plausibility gate becomes
 * visible: a rejected reading shows as "sensor fault" instead of silently
 * freezing, because on this bike that means a probe worth going and wiggling.
 * @param {object} options
 * @param {string} options.key
 * @param {string} options.label
 * @param {(value: number) => string} options.format
 * @param {string} [options.unit]
 * @param {(value: number | null) => string} [options.color]
 * @param {() => string} [options.sub]
 * @param {string} [options.className]
 * @param {boolean} [options.chart] draw a sparkline of the last few minutes
 * @param {number} [options.chartWindowMs]
 * @param {number} [options.minSpan]
 */
export function SignalTile({
  key,
  label,
  format,
  unit = "",
  color,
  sub,
  className = "",
  chart = false,
  chartWindowMs = 10 * 60_000,
  minSpan = 1,
}) {
  const state = signalState(key);
  const fault = faultState(key);

  const currentValue = () => {
    const reading = state.val;
    return reading ? reading.value : null;
  };

  const extra = chart ? [trace(key, color, chartWindowMs, minSpan)] : [];

  return div(
    {
      class: () => {
        const stale = state.val && isStale(key, STALE_MS);
        return `tile ${className}${stale ? " stale" : ""}`;
      },
      style: () => (hasEverArrived(key) ? "" : "display:none"),
    },
    div({ class: "label" }, label),
    div(
      { class: "value", style: () => `color:${color ? color(currentValue()) : CALM}` },
      () => {
        const reading = state.val;
        return reading ? format(reading.value) : "–";
      },
      unit ? span({ class: "unit" }, unit) : null
    ),
    () => {
      // Paced at 2 Hz so the fault notice can time itself out; see FAULT_MEMORY_MS.
      chartTick.val;
      const active = fault.val;
      // Server time, not Date.now(): active.ts is stamped by the Pi, and comparing
      // it against this device's clock measures the gap between two machines rather
      // than the age of the fault. Both sides here are server wall time, which is
      // the only pairing that means anything.
      //
      // Peeked, not read through `.val`: apply() sets serverTime on every message
      // including 20 Hz patches, so subscribing would rebuild this div at frame rate
      // — the same leak the chart binding above avoids. The tick above is what makes
      // the notice expire on its own instead of hanging around until the next fault.
      if (active && peekServerTime() - active.ts < FAULT_MEMORY_MS) {
        return div({ class: "sub fault" }, `sensor fault (${active.value.toFixed(0)})`);
      }
      return sub ? div({ class: "sub" }, sub()) : div({ class: "sub" }, "");
    },
    ...extra
  );
}

/**
 * Two related numbers in one tile — "28 / 29", min over max. Used wherever the
 * pair means more together than either does alone: pack temperature extremes,
 * coolant in and out.
 * @param {object} options
 * @param {string} options.label
 * @param {[string, string]} options.keys
 * @param {(value: number) => string} options.format
 * @param {string} [options.unit]
 * @param {(value: number | null) => string} [options.color]
 * @param {string} [options.caption]
 * @param {string} [options.className]
 * @param {boolean} [options.chart] trace the upper key over the last few minutes
 * @param {number} [options.chartWindowMs]
 * @param {number} [options.minSpan]
 */
export function PairTile({
  label,
  keys,
  format,
  unit = "",
  color,
  caption = "",
  className = "",
  chart = false,
  chartWindowMs = 10 * 60_000,
  minSpan = 1,
}) {
  const first = signalState(keys[0]);
  const second = signalState(keys[1]);
  // The upper key carries the trace: for a min/max pair it is the hot end that
  // decides when the BMS starts derating, and two overlaid lines a few degrees
  // apart read as one thick line at this size anyway.
  const extra = chart ? [trace(keys[1], color, chartWindowMs, minSpan)] : [];
  return div(
    {
      // Staleness matters more on a pair than on a single value, because
      // batt_temp_lo/batt_temp_hi are deliberately sparse: they are not written at
      // all until the frames establish which BMS config is flashed, and they stop
      // rather than fall back to 0x200's shifted view if the source that owns the
      // true temperature goes quiet (see src/can/pack-temperature.ts). Without
      // this the tile would keep presenting the last good pair as current, which
      // is the one thing that file goes out of its way not to do.
      class: () => {
        // OR, not AND: half a pair going quiet is already reason not to read the
        // number as current. Requiring both meant a frozen high value stayed at
        // full brightness for as long as the low kept arriving.
        const seen = first.val || second.val;
        const stale = seen && (isStale(keys[0], STALE_MS) || isStale(keys[1], STALE_MS));
        return `tile ${className}${stale ? " stale" : ""}`;
      },
      style: () => (hasEverArrived(keys[0]) || hasEverArrived(keys[1]) ? "" : "display:none"),
    },
    div({ class: "label" }, label),
    div(
      {
        class: "value",
        style: () => {
          const reading = second.val;
          return `color:${color ? color(reading ? reading.value : null) : CALM}`;
        },
      },
      () => {
        const low = first.val;
        const high = second.val;
        if (!low || !high) {
          return "–";
        }
        return `${format(low.value)} / ${format(high.value)}`;
      },
      unit ? span({ class: "unit" }, unit) : null
    ),
    () => {
      // Same fault notice SignalTile carries, for the same reason: a reading
      // rejected by the plausibility gate never reaches signalState, so without
      // this the tile keeps presenting the last good pair as current — the
      // "silently dropped" outcome bounds.js exists to prevent. batt_temp_hi is a
      // signed byte off 0x660, so a garbage 0x7F or 0x80 is a real possibility
      // rather than a theoretical one. Paced at 2 Hz so the notice expires.
      chartTick.val;
      const faulted = keys
        .map((key, index) => ({ fault: faultState(key).val, end: index === 0 ? "low" : "high" }))
        .filter(entry => entry.fault && peekServerTime() - entry.fault.ts < FAULT_MEMORY_MS);
      if (faulted.length > 0) {
        const detail = faulted.map(entry => `${entry.end} ${entry.fault?.value.toFixed(0)}`).join(", ");
        return div({ class: "sub fault" }, `sensor fault (${detail})`);
      }
      return div({ class: "sub" }, caption);
    },
    ...extra
  );
}

/**
 * A labelled line of small text — for the secondary facts that would be noise as
 * their own tiles but are worth having on the page.
 * @param {string} label
 * @param {() => string} value
 */
export function Fact(label, value) {
  return div({ class: "fact" }, span({ class: "fact-label" }, label), span({ class: "fact-value" }, value));
}

/**
 * A full-width heading between groups of tiles.
 * @param {string} text
 */
export function SectionLabel(text) {
  return div({ class: "section" }, text);
}

/**
 * Placeholder shown where a signal the view is built around has never arrived.
 * @param {string} text
 */
export function Missing(text) {
  return div({ class: "missing", style: `color:${MUTED}` }, text);
}
