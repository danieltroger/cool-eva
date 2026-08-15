// @ts-check

import van from "../vendor/van-1.6.1.js";
import { chartTick, isStale, valueOf } from "../lib/store.js";
import { Fact, PairTile, SectionLabel, SignalTile } from "../lib/tiles.js";
import { ring } from "../lib/svg.js";
import * as colors from "../lib/colors.js";
import { power, whole } from "../lib/format.js";

const { div, span } = van.tags;

// The charging screen.
//
// No time-to-full estimate here on purpose. Without the pack's taper curve any ETA
// is a straight-line extrapolation of a curve that is anything but, and the bike's
// own dash already shows one of those. Amps, volts and kilowatts are what actually
// tell you whether the charge is going the way it should.
//
// Verified against a real 48-minute AC session captured 2026-08-02 18:55→19:43
// (`0x201` byte 0 held `02` = Charge for 18 400 frames, with `0x305`/`0x306`
// arriving throughout).

/**
 * A charger frame seen this recently means the onboard AC charger is live. During
 * DC fast charging those frames are silent, so their freshness — not the state
 * bitfield, which only says charging-vs-not — is what separates AC from DC.
 */
const CHARGER_LIVE_MS = 6000;

export function ChargeView() {
  return div(
    { class: "view" },
    ChargeHero(),
    SectionLabel("Delivery"),
    SignalTile({
      key: "dc_a",
      label: "Current",
      format: value => value.toFixed(1),
      unit: "A",
      color: () => colors.CALM,
      chart: true,
      minSpan: 2,
    }),
    SignalTile({
      key: "dc_v",
      label: "Pack side",
      format: value => value.toFixed(0),
      unit: "V",
      color: () => colors.CALM,
    }),
    SignalTile({
      key: "mains_v",
      label: "Mains",
      format: value => value.toFixed(0),
      unit: "V",
      color: () => colors.CALM,
      sub: () => {
        const amps = valueOf("mains_a");
        return amps == null ? "" : `${amps.toFixed(1)} A drawn`;
      },
    }),
    LimitsTile(),
    SectionLabel("Pack"),
    BalanceTile(),
    // The same pair the riding screen shows, rather than pack_temp_avg.
    //
    // The average was never wrong — across 287 samples of rides.db it sits between
    // the min and the max on 277 of them, the rest being pairing lag on
    // log-on-change signals — but it is a different statistic under a label that
    // did not say so, and a lone "37" next to the riding screen's "37 / 38" reads
    // as a third unrelated number rather than the middle of that pair.
    //
    // Cost of the switch, worth knowing: batt_temp_lo/hi are deliberately sparse
    // (src/can/pack-temperature.ts) and are not written until the frames establish
    // which BMS config is flashed, while pack_temp_avg is emitted from the first
    // 0x660. So this tile can be absent for a few seconds after a restart where
    // the old one showed a number immediately. The pair is still the honest thing
    // to show: a gap says "not established yet", which is what is true.
    PairTile({
      label: "Pack temp",
      keys: ["batt_temp_lo", "batt_temp_hi"],
      format: value => value.toFixed(0),
      unit: "°C",
      color: colors.temperature,
      caption: "min / max across the pack",
      chart: true,
      minSpan: 5,
    }),
    SignalTile({
      key: "coolant_out",
      label: "Coolant out",
      format: value => value.toFixed(1),
      unit: "°C",
      color: colors.temperature,
      chart: true,
      minSpan: 2,
    }),
    IsolationTile()
  );
}

/** State of charge as a ring, with the power going in written through it. */
function ChargeHero() {
  return div(
    { class: "hero charge-hero" },
    () => {
      const soc = valueOf("soc");
      return ring({ fraction: soc == null ? null : soc / 100, color: colors.stateOfCharge(soc) });
    },
    div(
      { class: "charge-hero-text" },
      div(
        { class: "hero-value", style: () => `color:${colors.stateOfCharge(valueOf("soc"))}` },
        () => whole(valueOf("soc")),
        span({ class: "hero-unit" }, "%")
      ),
      div({ class: "sub" }, () => {
        const kilowatts = valueOf("pack_kw");
        return kilowatts == null ? "" : `${power(Math.abs(kilowatts))} kW in`;
      }),
      div({ class: "sub" }, chargeModeText)
    )
  );
}

/**
 * AC or DC, plus whichever phase of the charge the BMS says it is in. The state
 * bits matter here: trickle and maintenance both look like "charging" but mean the
 * interesting part is over.
 */
function chargeModeText() {
  const onboardLive = ["mains_v", "mains_a", "dc_v", "dc_a"].some(key => !isStale(key, CHARGER_LIVE_MS));
  const kind = onboardLive ? "AC" : "DC";
  if (valueOf("bms_state_charge_complete") === 1) {
    return `${kind} · complete`;
  }
  if (valueOf("bms_state_trickle") === 1) {
    return `${kind} · trickle`;
  }
  if (valueOf("bms_state_maintenance") === 1) {
    return `${kind} · maintenance`;
  }
  if (valueOf("bms_state_balancing") === 1) {
    return `${kind} · balancing`;
  }
  return `${kind} charging`;
}

/** What the BMS is granting the charger, against what the charger is doing. */
function LimitsTile() {
  return div(
    { class: "tile span2" },
    div({ class: "label" }, "BMS grants"),
    div({ class: "value" }, () => whole(valueOf("charger_max_dc_a")), span({ class: "unit" }, "A max")),
    Fact("Ceiling voltage", () => {
      const volts = valueOf("charger_max_dc_v");
      return volts == null ? "–" : `${volts.toFixed(0)} V`;
    }),
    Fact("AC setpoint", () => {
      const limit = valueOf("charge_limit_a");
      return limit == null ? "–" : `${limit.toFixed(1)} A`;
    }),
    Fact("Charger enabled", () => (valueOf("charger_enabled") === 1 ? "yes" : "no"))
  );
}

/**
 * Balancing is only visible while charging, and it is the one time the pack's
 * worst problem is being actively fixed — so the spread trend belongs here more
 * than anywhere else.
 */
function BalanceTile() {
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
      // The spread is max − min, so the two voltages it is made of belong on the
      // same tile rather than in one of their own: while charging, how full the
      // cells actually are matters as much as how far apart they are.
      const minimum = valueOf("cell_min_mv");
      const maximum = valueOf("cell_max_mv");
      const range = minimum == null || maximum == null ? "" : `${Math.round(minimum)}–${Math.round(maximum)} mV · `;
      const balancing = valueOf("bms_state_balancing") === 1;
      const low = valueOf("cell_lowest_v_idx");
      const high = valueOf("cell_highest_v_idx");
      const cells = low == null || high == null ? "" : ` · low #${Math.round(low)}, high #${Math.round(high)}`;
      return `${range}${balancing ? "balancing now" : "not balancing"}${cells}`;
    },
  });
}

/**
 * Isolation resistance. Only ever interesting while plugged in, and then very:
 * a collapsing value with the bike connected to mains is the one fault on this
 * screen worth stopping for.
 */
function IsolationTile() {
  return div({ class: "tile span2" }, () => {
    chartTick.val;
    const total = valueOf("iso_test_total");
    if (total == null) {
      return div(div({ class: "label" }, "Isolation"), div({ class: "sub" }, "not reported"));
    }
    return div(
      div({ class: "label" }, "Isolation"),
      div({ class: "value" }, String(Math.round(total))),
      div({ class: "sub" }, "raw BMS units — watch for a sudden drop, not the absolute number")
    );
  });
}
