// @ts-check

import van from "../vendor/van-1.6.1.js";
import { chartTick, isStale, peek, signalState, valueOf } from "../lib/store.js";
import { differenceByTime, ringFor } from "../lib/ring.js";
import { monotonicNow } from "../lib/clock.js";
import { coolantDelta, remainingWh, resistiveLossPercent, resistiveLossWatts } from "../lib/derive.js";
import { resistanceNote } from "../lib/pack-resistance.js";
import { packResistance } from "../lib/pack-resistance-live.js";
import { powerLimitsKw } from "../lib/power-limits.js";
import { PairTile, SectionLabel, SignalTile, Tile } from "../lib/tiles.js";
import { meter, sparkline, splitBar } from "../lib/svg.js";
import * as colors from "../lib/colors.js";
import * as units from "../lib/units.js";
import { power, whole } from "../lib/format.js";

const { div, span } = van.tags;

// The screen you actually ride with.
//
// Ordered by what you would want to know if you could only glance once: how fast,
// how hard you are pushing, how hot the pack is getting, how much is left. Speed
// comes from GPS rather than the bike, per the request — the wheel-derived figure
// is kept underneath it, because the gap between them is your speedometer error.

/** Widest power the bar scales to. The Ribelle peaks around 126 kW. */
const POWER_LIMIT_KW = 130;

export function RideView() {
  return div(
    { class: "view" },
    SpeedHero(),
    PowerRow(),
    SectionLabel("Thermal"),
    CoolantDeltaTile(),
    PairTile({
      label: "Battery",
      keys: ["batt_temp_lo", "batt_temp_hi"],
      format: value => units.temp(value).toFixed(0),
      unit: units.tempUnit,
      color: colors.temperature,
      caption: "min / max",
      className: "span2",
    }),
    PairTile({
      label: "Coolant",
      keys: ["coolant_in", "coolant_out"],
      format: value => units.temp(value).toFixed(1),
      unit: units.tempUnit,
      color: colors.temperature,
      caption: "in / out",
      className: "span2",
    }),
    SignalTile({
      key: "bike_coolant_temp",
      label: "Motor",
      format: value => units.temp(value).toFixed(0),
      unit: units.tempUnit,
      color: colors.temperature,
      chart: true,
      minSpan: 5,
    }),
    SignalTile({
      key: "ambient_temp",
      label: "Ambient",
      format: value => units.temp(value).toFixed(0),
      unit: units.tempUnit,
      color: colors.temperature,
    }),
    SectionLabel("Energy"),
    ChargeTile(),
    SignalTile({
      key: "range_km",
      label: "Range",
      format: value => units.distance(value).toFixed(0),
      unit: units.distanceUnit,
      color: () => colors.CALM,
    })
  );
}

/**
 * GPS speed, as large as the screen allows. The bike's own wheel speed sits in the
 * sub-line: it reads high by a few percent like every vehicle speedometer, and
 * seeing both is the only way to know by how much on this bike.
 */
function SpeedHero() {
  return div(
    { class: "hero" },
    div({ class: "label" }, "Speed"),
    div(
      { class: "hero-value" },
      () => {
        const gps = signalState("gps_speed_kmh").val;
        return gps ? String(Math.round(units.speed(gps.value))) : "–";
      },
      span({ class: "hero-unit" }, units.speedUnit)
    ),
    div({ class: "sub" }, () => {
      // 0x104 at 0.5 km/h beats the OBD PID's whole km/h, and arrives whether or
      // not the poller is running.
      const wheel = valueOf("speed_can_kmh") ?? valueOf("speed_kmh");
      const gps = valueOf("gps_speed_kmh");
      if (wheel == null) {
        return "GPS · no wheel speed";
      }
      if (gps == null) {
        return `wheel ${Math.round(units.speed(wheel))} ${units.speedUnit()} · no GPS fix`;
      }
      // The error is a difference of two speeds, so it converts by the same factor as a
      // speed — no offset — and speed() applied to the difference gives exactly that.
      const error = units.speed(wheel) - units.speed(gps);
      const sign = error >= 0 ? "+" : "−";
      return `GPS · wheel reads ${Math.round(units.speed(wheel))} (${sign}${Math.abs(error).toFixed(0)})`;
    })
  );
}

/**
 * Power flow and what it is costing in heat. The I²R figure is here, and not only
 * on the hypermiling screen, because it is the same watts the coolant loop has to
 * carry away — it belongs next to the temperatures it explains.
 *
 * The dashed lines are the BMS's own ceilings (lib/power-limits.js). They are what
 * turns the bar from "how hard am I pulling" into "how much is left before the pack
 * says no", and they MOVE — the discharge ceiling averages 91 kW over moving time in
 * the archive against the bike's 126 kW peak, so a rider reading a full-looking bar
 * without them is usually reading a derate as headroom.
 */
function PowerRow() {
  return div(
    { class: "tile span2" },
    div({ class: "label" }, "Power"),
    div(
      { class: "value", style: () => `color:${colors.power(valueOf("pack_kw"))}` },
      () => power(valueOf("pack_kw")),
      span({ class: "unit" }, "kW")
    ),
    () => {
      const kilowatts = valueOf("pack_kw");
      const limits = powerLimitsKw(valueOf, isStale);
      return splitBar({
        value: kilowatts,
        fullScale: POWER_LIMIT_KW,
        color: colors.power(kilowatts),
        limits,
      });
    },
    div({ class: "sub" }, () => {
      const watts = resistiveLossWatts();
      const percent = resistiveLossPercent();
      if (watts == null) {
        return "regen ← → drive";
      }
      const percentText = percent == null ? "" : ` · ${percent.toFixed(1)}% of output`;
      const note = resistanceNote(packResistance.val);
      const qualifier = note === "" ? "" : ` · ${note}`;
      return `${Math.round(watts)} W lost as heat${percentText}${qualifier}`;
    })
  );
}

/**
 * The number this whole project exists to answer: how much heat the loop is
 * actually pulling out of the pack. With flow roughly constant, ΔT is proportional
 * to watts removed — so putting it next to the I²R watts going in shows, live,
 * whether the cooling is keeping up.
 */
function CoolantDeltaTile() {
  const deltaColor = () => {
    const delta = coolantDelta();
    if (delta == null) {
      return colors.MUTED;
    }
    // A big ΔT is the loop working, not a problem — it only means trouble alongside
    // a pack that is also climbing, which the tile above shows.
    return delta > 0.3 ? colors.GOOD : colors.MUTED;
  };
  return div(
    {
      class: "tile span2",
      // No coolant probes attached (or none reporting yet) means no ΔT to show —
      // and this is the tallest tile on the screen to leave sitting empty.
      style: () => (coolantDelta() == null ? "display:none" : ""),
    },
    div({ class: "label" }, "Coolant ΔT"),
    div(
      { class: "value", style: () => `color:${deltaColor()}` },
      () => {
        const delta = coolantDelta();
        return delta == null ? "–" : units.tempDelta(delta).toFixed(2);
      },
      span({ class: "unit" }, units.tempUnit)
    ),
    () => {
      chartTick.val;
      const now = monotonicNow();
      const inlet = ringFor("coolant_in").since(10 * 60_000, now);
      const outlet = ringFor("coolant_out").since(10 * 60_000, now);
      // Both traces would need a shared scale to be comparable, and the difference
      // is the point — so chart the difference itself, at the outlet's sample times
      // with the inlet held from whatever it last read. Pairing the two by array
      // index instead would silently plot the rate mismatch between the probes.
      const deltas = differenceByTime(outlet, inlet);
      // peek(), not the deltaColor() above: that reads through valueOf() and would
      // subscribe this redraw to both probes instead of leaving it on the tick.
      const inletNow = peek("coolant_in");
      const outletNow = peek("coolant_out");
      const delta = inletNow == null || outletNow == null ? null : outletNow - inletNow;
      const traceColor = delta != null && delta > 0.3 ? colors.GOOD : colors.MUTED;
      return sparkline({ values: deltas, color: traceColor, minSpan: 0.5, baseline: 0 });
    },
    div({ class: "sub" }, () => {
      const watts = resistiveLossWatts();
      if (watts == null) {
        return "out − in";
      }
      const note = resistanceNote(packResistance.val);
      const qualifier = note === "" ? "" : ` (${note})`;
      return `out − in · ${Math.round(watts)} W going in${qualifier}`;
    })
  );
}

/** State of charge as a bar, because a percentage is a shape before it is a number. */
function ChargeTile() {
  return Tile({
    label: "Charge",
    value: () => whole(valueOf("soc")),
    unit: "%",
    color: () => colors.stateOfCharge(valueOf("soc")),
    className: "span2",
    extra: [
      () => {
        const soc = valueOf("soc");
        return meter({ fraction: soc == null ? null : soc / 100, color: colors.stateOfCharge(soc) });
      },
    ],
    sub: () => {
      const energy = remainingWh();
      return energy == null ? "" : `${(energy / 1000).toFixed(1)} kWh left`;
    },
  });
}
