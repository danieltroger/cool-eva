// @ts-check

import van from "../vendor/van-1.6.1.js";
import { chartTick, isStale, peek, signalState, valueOf } from "../lib/store.js";
import { differenceByTime, ringFor } from "../lib/ring.js";
import { monotonicNow } from "../lib/clock.js";
import { coolantDelta, heatInOutText, resistiveLossPercent, resistiveLossWatts } from "../lib/derive.js";
import { resistanceNote } from "../lib/pack-resistance.js";
import { packResistance } from "../lib/pack-resistance-live.js";
import { powerLimitsKw } from "../lib/power-limits.js";
import { PairTile, SectionLabel, SignalTile } from "../lib/tiles.js";
import { sparkline } from "../lib/svg.js";
import { POWER_SCALE_KW, powerBar } from "../lib/power-bar.js";
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

export function RideView() {
  return div(
    { class: "view" },
    SpeedHero(),
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
    PairTile({
      // The motor's own sensor beside the bike's OBD temperature — separate sensors, not
      // one at two resolutions: docs/can-decode-findings.md §"0x020 / 0x022" has the
      // 2026-08-02 lap putting PID 05 up 27 → 30 °C in step with the inverter gate channel
      // while 0x022 moved 27.9 → 28.5. This tile showed PID 05 alone under the OTHER one's
      // name.
      //
      // ⚠️ Captioned "OBD", not "coolant": coolant is PID 05's OBD-II label, what the
      // capture establishes is that it tracks the gate, and the Coolant tile two rows up
      // is the MAX31865 probes. PID 05 is keys[1] because PairTile colours and charts from
      // the upper key and it is the more responsive of the two. The inverter IGBT channels
      // are hotter still and are NOT here — they are inverter readings, and that doc marks
      // their min/inst/max ordering unverified.
      label: "Motor",
      keys: ["motor_temp_c", "bike_coolant_temp"],
      format: value => units.temp(value).toFixed(0),
      unit: units.tempUnit,
      color: colors.temperature,
      caption: "motor / OBD",
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
 * Speed, power and the meter as one instrument.
 *
 * The meter is a strip down the left edge rather than a band under a card of its own: it
 * runs beside a numeral already that tall, so it costs no row, and this screen is short
 * of rows rather than of width. Wheel speed sits in the sub-line because it reads high by
 * a few percent like every vehicle speedometer, and charge at the end of that line —
 * small, because it moves slowly, and here because it must never need a scroll.
 *
 * The dashed stretches are the BMS's own ceilings (lib/power-limits.js), and they MOVE:
 * the discharge ceiling averages 91 kW over moving time against the bike's 126 kW peak.
 * docs/dashboard-decisions.md §"The power meter" has the rest.
 */
function SpeedHero() {
  return div(
    { class: "hero speed-hero" },
    () => {
      const kilowatts = valueOf("pack_kw");
      return powerBar({
        value: kilowatts,
        fullScale: POWER_SCALE_KW,
        color: colors.power(kilowatts),
        limits: powerLimitsKw(valueOf, isStale),
      });
    },
    div(
      { class: "hero-main" },
      div({ class: "hero-row" }, div({ class: "label" }, "Speed"), div({ class: "label" }, "Power")),
      div(
        { class: "hero-row" },
        div(
          { class: "hero-value" },
          () => {
            const gps = signalState("gps_speed_kmh").val;
            return gps ? String(Math.round(units.speed(gps.value))) : "–";
          },
          span({ class: "hero-unit" }, units.speedUnit)
        ),
        div(
          { class: "value hero-aside", style: () => `color:${colors.power(valueOf("pack_kw"))}` },
          () => power(valueOf("pack_kw")),
          span({ class: "unit" }, "kW")
        )
      ),
      div(
        { class: "hero-row" },
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
          // The error is a difference of two speeds, so it converts by the same factor as
          // a speed — no offset — and speed() applied to the difference gives exactly that.
          const error = units.speed(wheel) - units.speed(gps);
          const sign = error >= 0 ? "+" : "−";
          return `GPS · wheel reads ${Math.round(units.speed(wheel))} (${sign}${Math.abs(error).toFixed(0)})`;
        }),
        div(
          { class: "hero-charge", style: () => `color:${colors.stateOfCharge(valueOf("soc"))}` },
          () => `${whole(valueOf("soc"))} %`
        )
      )
    )
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
      { class: "value-row" },
      div(
        { class: "value", style: () => `color:${deltaColor()}` },
        () => {
          const delta = coolantDelta();
          return delta == null ? "–" : units.tempDelta(delta).toFixed(2);
        },
        span({ class: "unit" }, units.tempUnit)
      ),
      // The same two numbers as the Charge tab's HEAT IN / OUT, in the same order and
      // units, on a row that was 94 px of ink in 348. Named for the two MECHANISMS and
      // not for two directions: the Coolant tile two rows down is already captioned
      // "in / out", for the inlet and the outlet, and a second in/out pair on one
      // screen means neither. I²R earns the riding screen on its own account —
      // docs/dashboard-decisions.md §"Resistive loss".
      div(
        { class: "value-aside" },
        () => {
          const heat = heatInOutText();
          return heat == null ? "–" : `I²R ${heat.into} / loop ${heat.removed}`;
        },
        span({ class: "unit" }, "W")
      )
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
      // The Power card carried this sentence's other half — the same watts as a share of
      // output — and the card is gone. Both belong here anyway: these are the watts the
      // loop above has to carry away, which is what the ΔT beside them measures.
      const percent = resistiveLossPercent();
      const share = percent == null ? "" : ` · ${percent.toFixed(1)}% of output`;
      // Both halves of the aside above are qualified, not just the one. `out` is the
      // shakier of the two — COOLANT_FLOW_LPH is specified rather than measured, and an
      // upper bound — and it arrives on this screen with the Charge tab's full sentence
      // about the pump left behind, so the assumption has to travel with the number.
      //
      // ⚠️ The R note is dropped when there are no watts to qualify. With no pack_a the
      // aside reads `I²R ? / loop 4428 W`, and "modelled R" beside it would be a
      // provenance for a number that is not on screen.
      const resistanceCaveat = resistiveLossWatts() == null ? "" : resistanceNote(packResistance.val);
      const caveat = resistanceCaveat === "" ? "rated flow" : `${resistanceCaveat}, rated flow`;
      return `out − in${share} · ${caveat}`;
    })
  );
}
