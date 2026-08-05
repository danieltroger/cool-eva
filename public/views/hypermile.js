// @ts-check

import van from "../vendor/van-1.6.1.js";
import { chartTick, faultState, knownKeys, peek, valueOf } from "../lib/store.js";
import { CELL_COUNT, cellVoltageKeys } from "../lib/cells.js";
import { ringFor } from "../lib/ring.js";
import { monotonicNow } from "../lib/clock.js";
import {
  bikeConsumptionWhPerKm,
  headroomMv,
  limitFraction,
  remainingWh,
  resistiveLossPercent,
  restingHeadroomMv,
  rollingConsumption,
  rollingRangeKm,
  sagPerCellMv,
} from "../lib/derive.js";
import { CUTOFF_TIMER_S, dwellSeconds, secondsRemaining } from "../lib/dwell.js";
import { Fact, Missing, SectionLabel, SignalTile } from "../lib/tiles.js";
import { barStrip, meter, sparkline } from "../lib/svg.js";
import * as colors from "../lib/colors.js";
import { fixed, whole } from "../lib/format.js";

const { div, span } = van.tags;

// The range-maximising screen, built from the BMS's own configuration rather than
// from SOC. See HYPERMILING.md for the reasoning behind every number here.
//
// The organising fact: the BMS cuts discharge on the *minimum cell voltage*, not on
// pack voltage and not on SOC. One cell out of 81 ends the ride, and SOC — which
// comes from coulomb counting against an OCV table never re-characterised for these
// cells — is the wrong thing to lead with anywhere near empty.

/** The BMS's configured discharge ceiling, for scaling the limit bar. */
const DISCHARGE_CEILING_A = 400;

/** Configured regen ceiling: full 120 A between 10 °C and 45 °C. */
const REGEN_CEILING_A = 120;

export function HypermileView() {
  return div(
    { class: "view" },
    HeadroomHero(),
    DwellBar(),
    LimitBar(),
    SectionLabel("Efficiency"),
    ConsumptionTile(),
    LossTile(),
    SectionLabel("Pack"),
    SpreadTile(),
    CellStrip(),
    RegenTile()
  );
}

/**
 * Millivolts the weakest cell has left above the cut-off — instantaneous, with the
 * sag-compensated figure beneath it.
 *
 * Both are shown deliberately. The instantaneous number is what the BMS trips on,
 * so it is the authority. The compensated one — measured voltage plus the sag the
 * current draw is causing — is what you actually have left, and is the one that
 * doesn't collapse every time you open the throttle. Neither alone is honest.
 */
function HeadroomHero() {
  return div(
    { class: "hero" },
    div({ class: "label" }, "Weakest cell above cut-off"),
    div(
      { class: "hero-value", style: () => `color:${colors.headroom(headroomMv())}` },
      () => whole(headroomMv()),
      span({ class: "hero-unit" }, "mV")
    ),
    div({ class: "sub" }, () => {
      const resting = restingHeadroomMv();
      const sag = sagPerCellMv();
      if (resting == null || sag == null) {
        // Sag compensation needs a pack resistance, which the BMS only estimates
        // under load — say which half is missing rather than repeating the cut-off
        // that the line below already gives.
        return "sag compensation needs a pack resistance estimate";
      }
      return `${Math.round(resting)} mV at rest · ${Math.round(sag)} mV of sag right now`;
    }),
    div({ class: "sub" }, () => {
      const weakest = valueOf("cell_lowest_v_idx");
      const cutoff = valueOf("cell_cutoff_mv");
      const parts = [];
      if (cutoff != null) {
        parts.push(`cut-off ${cutoff} mV`);
      }
      if (weakest != null) {
        parts.push(`cell #${Math.round(weakest)}`);
      }
      return parts.join(" · ");
    })
  );
}

/**
 * How much of the BMS's 60-second under-voltage timer has been used.
 *
 * Without this, a display of raw headroom cries wolf: the weakest cell dips under
 * the floor on any hard pull, and nothing happens unless it *stays* there for a
 * full minute. Showing the timer turns a frightening flicker into "you have 45
 * seconds of this left", which is something a rider can act on.
 */
function DwellBar() {
  return div(
    { class: "tile span2" },
    div({ class: "label" }, "Cut-off timer"),
    div({ class: "value" }, () => {
      chartTick.val;
      const used = dwellSeconds();
      return used < 0.5 ? "clear" : `${Math.round(secondsRemaining())} s`;
    }),
    () => {
      chartTick.val;
      const used = dwellSeconds();
      const fraction = used / CUTOFF_TIMER_S;
      const color = fraction > 0.5 ? colors.BAD : fraction > 0.15 ? colors.WARN : colors.GOOD;
      return meter({ fraction, color });
    },
    div({ class: "sub" }, () => {
      chartTick.val;
      return dwellSeconds() < 0.5
        ? `weakest cell above cut-off · ${CUTOFF_TIMER_S} s allowed below`
        : "below cut-off — ease off and it drains back";
    })
  );
}

/**
 * Allowed discharge current against the configured ceiling — "am I being
 * throttled". This falls before the voltage floor is reached, and also for cold,
 * heat and low SOC, which makes it the earlier warning of the two.
 */
function LimitBar() {
  return div(
    { class: "tile span2" },
    div({ class: "label" }, "Current allowed"),
    div(
      { class: "value" },
      () => whole(valueOf("allowed_discharge_a")),
      span({ class: "unit" }, `/ ${DISCHARGE_CEILING_A} A`)
    ),
    () => {
      const fraction = limitFraction("allowed_discharge_a", DISCHARGE_CEILING_A);
      const color =
        fraction == null ? colors.MUTED : fraction > 0.9 ? colors.GOOD : fraction > 0.6 ? colors.WATCH : colors.WARN;
      return meter({ fraction, color });
    },
    div({ class: "sub" }, () => {
      const fraction = limitFraction("allowed_discharge_a", DISCHARGE_CEILING_A);
      if (fraction == null) {
        return "BMS has not reported a limit";
      }
      return fraction > 0.95 ? "not limited" : "BMS is limiting output";
    })
  );
}

/** Wh/km over the last few km, with the horizon stated so it can't be over-read. */
function ConsumptionTile() {
  return div(
    { class: "tile span2" },
    div({ class: "label" }, "Consumption"),
    div(
      { class: "value" },
      () => {
        chartTick.val;
        const rolling = rollingConsumption(monotonicNow());
        if (rolling.state === "measured") {
          return rolling.whPerKm.toFixed(0);
        }
        // A descent puts energy back in; a dash is what "no reading" looks like, and
        // this is a reading.
        return rolling.state === "regenerating" ? "regen" : "–";
      },
      span({ class: "unit" }, "Wh/km")
    ),
    div({ class: "sub" }, () => {
      chartTick.val;
      const now = monotonicNow();
      const rolling = rollingConsumption(now);
      if (rolling.state === "waiting") {
        return "needs ~200 m of riding";
      }
      if (rolling.state === "regenerating") {
        return `putting charge back over the last ${rolling.km.toFixed(1)} km`;
      }
      const range = rollingRangeKm(now);
      const rangeText = range == null ? "" : ` · ${Math.round(range)} km left at this rate`;
      return `over the last ${rolling.km.toFixed(1)} km${rangeText}`;
    }),
    Fact("Remaining", () => {
      const energy = remainingWh();
      return energy == null ? "–" : `${(energy / 1000).toFixed(2)} kWh`;
    }),
    Fact("Bike's own figure", () => {
      chartTick.val;
      const bike = bikeConsumptionWhPerKm(monotonicNow());
      return bike == null ? "–" : `${Math.round(bike)} Wh/km`;
    }),
    Fact("Bike's own range", () => {
      const range = valueOf("range_km");
      return range == null ? "–" : `${Math.round(range)} km`;
    })
  );
}

/**
 * Share of the pack's output being burned in its own internal resistance. Rises
 * with the square of current, so it is the most direct feedback there is on riding
 * style — and it is exactly the heat the coolant loop then has to remove.
 */
function LossTile() {
  return div(
    { class: "tile span2" },
    div({ class: "label" }, "Lost to resistance"),
    div(
      { class: "value", style: () => `color:${colors.lossFraction(resistiveLossPercent())}` },
      () => fixed(resistiveLossPercent(), 1),
      span({ class: "unit" }, "%")
    ),
    () => {
      // Everything read inside this binding becomes a dependency of it, so the
      // resistance is sampled with peek() and the colour is computed from peeked
      // values — reading pack_a or pack_kw through valueOf() here would subscribe
      // the redraw to a signal with no deadband and pace it at frame rate, which is
      // exactly what the tick is meant to prevent.
      chartTick.val;
      const milliohms = peek("pack_resistance_mohm");
      // Charting zero watts because the resistance is unknown draws a flat line that
      // looks like a measurement of "no losses". Draw the empty placeholder instead.
      if (milliohms == null || milliohms <= 0) {
        return sparkline({ values: [], color: colors.MUTED });
      }
      const amps = ringFor("pack_a").since(10 * 60_000, monotonicNow());
      const watts = amps.values.map(value => (value * value * milliohms) / 1000);
      const packKilowatts = peek("pack_kw");
      const outputWatts = packKilowatts == null ? 0 : Math.abs(packKilowatts) * 1000;
      const newestWatts = watts.length > 0 ? watts[watts.length - 1] : null;
      const percent = outputWatts < 300 || newestWatts == null ? null : (newestWatts / outputWatts) * 100;
      return sparkline({ values: watts, color: colors.lossFraction(percent), minSpan: 100 });
    },
    div({ class: "sub" }, () => {
      const milliohms = valueOf("pack_resistance_mohm");
      if (milliohms == null || milliohms <= 0) {
        return "waiting for a pack resistance estimate — the BMS only reports one under load";
      }
      return `pack ${milliohms.toFixed(0)} mΩ · halving current quarters this`;
    })
  );
}

/** Cell spread — range already paid for that the weakest cell will not let you use. */
function SpreadTile() {
  return SignalTile({
    key: "cell_spread_mv",
    label: "Cell spread",
    format: value => value.toFixed(0),
    unit: "mV",
    color: colors.spread,
    className: "span2",
    chart: true,
    minSpan: 10,
    sub: () => {
      const low = valueOf("cell_lowest_v_idx");
      const high = valueOf("cell_highest_v_idx");
      if (low == null || high == null) {
        return "gap between best and worst cell";
      }
      return `weakest #${Math.round(low)} · strongest #${Math.round(high)}`;
    },
  });
}

/**
 * All 81 cells as one shape. Reading 81 numbers is impossible; spotting the short
 * bar is instant. Only rendered once the per-cell frames are actually arriving.
 */
function CellStrip() {
  return div({ class: "tile span2" }, () => {
    chartTick.val;
    const cells = cellVoltageKeys(knownKeys.val);
    const bars = [];
    let low = Infinity;
    let high = -Infinity;
    for (const key of cells) {
      // peek(), not valueOf(): this binding is paced by the tick above, and
      // subscribing it to 81 signals at ~2 Hz each would rebuild the strip
      // continuously.
      const value = peek(key);
      if (value == null) {
        continue;
      }
      bars.push(value);
      low = Math.min(low, value);
      high = Math.max(high, value);
    }
    if (bars.length === 0) {
      return Missing(`Per-cell voltages: waiting for 0x662–0x664 (0 of ${CELL_COUNT})`);
    }
    // A cell whose reading was rejected keeps its last good bar, so the strip would
    // otherwise look complete while one of its 81 values is frozen. Say so — the
    // whole premise of this screen is that one cell out of 81 ends the ride.
    const faulted = cells.filter(key => faultState(key).rawVal !== null).length;
    // Scale to the spread rather than to zero, or 81 near-identical cells all draw
    // as full-height bars and the weak one is invisible.
    const padding = Math.max((high - low) * 0.25, 5);
    return div(
      div({ class: "label" }, `Cells (${bars.length} of ${CELL_COUNT})`),
      barStrip({
        // The *scale* is relative — that is what makes a short bar visible — but the
        // *colour* is absolute, in millivolts below the strongest cell. Colouring by
        // position within the pack's own spread means a well-balanced pack (a few mV
        // end to end) paints itself orange and red, and a pack whose cells all read
        // identically after the 5 mV deadband paints entirely red. colors.spread()
        // already encodes what a gap worth worrying about actually is.
        bars: bars.map(value => ({ value, color: colors.spread(high - value) })),
        low: low - padding,
        high: high + padding,
      }),
      div(
        { class: faulted > 0 ? "sub fault" : "sub" },
        `${Math.round(low)} – ${Math.round(high)} mV · spread ${Math.round(high - low)} mV` +
          (faulted > 0 ? ` · ${faulted} cell${faulted === 1 ? "" : "s"} reading out of range` : "")
      )
    );
  });
}

/**
 * Regen headroom. It derates at high SOC and at temperature extremes, so a full
 * battery at the top of a mountain means the brakes are doing all the work — worth
 * knowing before the descent rather than during it.
 */
function RegenTile() {
  return div(
    { class: "tile span2" },
    div({ class: "label" }, "Regen available"),
    div({ class: "value" }, () => whole(valueOf("allowed_regen_a")), span({ class: "unit" }, `/ ${REGEN_CEILING_A} A`)),
    () => {
      const fraction = limitFraction("allowed_regen_a", REGEN_CEILING_A);
      const color =
        fraction == null ? colors.MUTED : fraction > 0.8 ? colors.GOOD : fraction > 0.4 ? colors.WATCH : colors.WARN;
      return meter({ fraction, color });
    },
    div({ class: "sub" }, () => {
      const fraction = limitFraction("allowed_regen_a", REGEN_CEILING_A);
      const soc = valueOf("soc");
      if (fraction == null) {
        return "BMS has not reported a regen limit";
      }
      if (fraction > 0.9) {
        return "full regen";
      }
      return soc != null && soc > 90 ? "derated — pack too full to absorb much" : "derated — check pack temperature";
    })
  );
}
