// @ts-check

import van from "../vendor/van-1.6.1.js";
import { chartTick, isStale, peek, signalState, valueOf } from "../lib/store.js";
import { differenceByTime, ringFor } from "../lib/ring.js";
import { monotonicNow } from "../lib/clock.js";
import { coolantDelta, resistiveLossPercent, resistiveLossWatts } from "../lib/derive.js";
import { resistanceNote } from "../lib/pack-resistance.js";
import { packResistance } from "../lib/pack-resistance-live.js";
import { powerLimitsKw } from "../lib/power-limits.js";
import { PairTile, SectionLabel, SignalTile } from "../lib/tiles.js";
import { sparkline } from "../lib/svg.js";
import { powerBar } from "../lib/power-bar.js";
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

/**
 * What each half of the power bar shows at its end. Fixed — it is the derate that
 * moves, not the scale — and asymmetric, because the two directions are not the same
 * size on this machine and pretending they are wastes most of one half.
 *
 * ⚠️ Sized against the CEILING each half has to be able to clear, not against the power
 * recorded in it. That distinction is the whole of why `regen` is not 45: the regen
 * ceiling is `allowed_regen_a × pack_v` and cannot pass 120 A × 341.2 V = 40.9 kW, so a
 * 45 kW half could never be un-hatched — 0.00% of moving time in the archive, a
 * permanent 15% floor of dashes on a healthy pack. Which is the exact fault the hatching
 * exists to remove, at a fifth of the size.
 *
 * 130 = 400 A at 325 V; 36 = 120 A at 300 V — each direction's configured current limit
 * at a representative pack voltage. Measured over 1054 minutes of moving time, that
 * clears the drive half for 20.1% of the time the BMS is allowing its full 400 A and the
 * regen half for 23.0% of the time it is allowing its full 120 A, so neither half is
 * systematically noisier than the other. 130 also contains the archive's deepest sample
 * (−117.3 kW) and the Ribelle's ~126 kW peak. 36 does not contain regen's largest ever
 * (40.9 kW) and is not meant to: 4 of 57 443 positive samples exceed 38 kW, and clamping
 * that tail costs far less than a half that can never come clean.
 * docs/dashboard-decisions.md §"The power bar" has the measurements.
 */
const POWER_SCALE_KW = { drive: 130, regen: 36 };

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
      // Both of the powertrain temperatures the bike broadcasts, which are separate
      // sensors rather than one at two resolutions — docs/can-decode-findings.md
      // §"0x020 / 0x022": at rest they agree at ambient, but the garage lap of
      // 2026-08-02 put PID 05 up 27 → 30 °C in step with 0x020's inverter gate channel
      // while 0x022's motor sensor moved 27.9 → 28.5. This tile used to show only the
      // first and call it "Motor", which named the wrong one of the two.
      label: "Motor",
      keys: ["bike_coolant_temp", "motor_temp_c"],
      format: value => units.temp(value).toFixed(0),
      unit: units.tempUnit,
      color: colors.temperature,
      caption: "coolant / motor",
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
 * The power meter is a strip down the left edge rather than a bar under a card of its
 * own: it runs beside a numeral that is already that tall, so it costs no row, and the
 * riding screen is short of rows rather than of width. The bike's wheel speed sits in
 * the sub-line — it reads high by a few percent like every vehicle speedometer, and
 * seeing both is the only way to know by how much on this bike. Charge sits at the end
 * of the same line: small, because it changes slowly, and here because it is the one
 * number that must not need a scroll.
 *
 * The dashed stretches on the meter are the BMS's own ceilings (lib/power-limits.js) —
 * the part of the scale you can no longer reach. They MOVE: the discharge ceiling
 * averages 91 kW over moving time in the archive against the bike's 126 kW peak, so a
 * rider reading a full-looking meter without them is usually reading a derate as
 * headroom.
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
        div({ class: "hero-charge", style: () => `color:${colors.stateOfCharge(valueOf("soc"))}` }, () => {
          const soc = valueOf("soc");
          return soc == null ? "– %" : `${whole(soc)} %`;
        })
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
      // The Power card carried this sentence's other half — the same watts as a share of
      // output — and the card is gone. Both belong here anyway: these are the watts the
      // loop above has to carry away, which is what the ΔT beside them measures.
      const percent = resistiveLossPercent();
      const share = percent == null ? "" : ` · ${percent.toFixed(1)}% of output`;
      const note = resistanceNote(packResistance.val);
      const qualifier = note === "" ? "" : ` (${note})`;
      return `out − in · ${Math.round(watts)} W going in${share}${qualifier}`;
    })
  );
}
