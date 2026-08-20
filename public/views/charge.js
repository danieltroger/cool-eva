// @ts-check

import van from "../vendor/van-1.6.1.js";
import { chartTick, isStale, knownKeys, peek, valueOf } from "../lib/store.js";
import { Fact, PairTile, STALE_MS, SectionLabel, SignalTile } from "../lib/tiles.js";
import { heatmap, meter, ring } from "../lib/svg.js";
import * as colors from "../lib/colors.js";
import { power, whole } from "../lib/format.js";
import { COOLANT_FLOW_LPH, coolantDelta, coolantHeatRemovedWatts, resistiveLossWatts } from "../lib/derive.js";
import { chargeMode } from "../lib/charge-mode.js";
import {
  CELL_COUNT,
  CELL_VOLTAGE_PATTERN,
  MAX_CELLS_PER_MODULE,
  MODULE_COUNT,
  MODULE_SENSORS,
  cellVoltageKeys,
  cellsInModule,
  moduleTemperatureKey,
} from "../lib/cells.js";

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

export function ChargeView() {
  return div(
    { class: "view" },
    ChargeHero(),
    SectionLabel("Delivery"),
    // Which tiles even exist depends on where the charge is coming from. On DC the
    // charger frames are silent, so the AC-sourced tiles below would sit there
    // showing the last values of a session that ended — which is what made this
    // screen useless at a fast charger. See lib/charge-mode.js.
    //
    // "charging" takes the pack-side set for the same reason DC does, and not because
    // it is thought to be DC: the AC tiles are made entirely of charger frames, so
    // when those are not arriving there is nothing honest to put in them.
    () => {
      switch (deliveryMode.val) {
        case "ac":
          return AcDelivery();
        case "dc":
        case "charging":
          return PackDelivery();
        default:
          return NotCharging();
      }
    },
    SectionLabel("Pack"),
    DerateTile(),
    ThermalBalanceTile(),
    BalanceTile(),
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
    HeatmapTile(),
    IsolationTile()
  );
}

/**
 * The one answer this whole screen is built on, held as a state so the DOM binding
 * above only fires when it actually flips.
 *
 * isStale() reads serverTime, which apply() writes on EVERY message including 20 Hz
 * pack_a patches — so binding the subgrid straight to chargeMode() would tear down
 * and rebuild four tiles at frame rate, sparklines included, defeating the chartTick
 * pacing they exist to have. Assigning an unchanged value to a VanJS state is a
 * no-op, so this derive absorbs the churn: it still re-runs per message, but that is
 * a handful of Map lookups rather than four tiles and an SVG.
 */
const deliveryMode = van.derive(() => chargeMode(valueOf, isStale));

/**
 * Charge is a tab, so this screen is reachable mid-ride. Without this the DC branch
 * would render "Charging at 41 kW" from pack_kw with its discharge sign stripped by
 * Math.abs() — confidently wrong, and not caught by staleness because pack_kw is
 * perfectly live while riding. The old AC-only tiles failed safe only by accident,
 * their signals being silent off the charger.
 */
function NotCharging() {
  return div(
    { class: "tile span2" },
    div({ class: "label" }, "Not charging"),
    div({ class: "sub" }, () => {
      const kilowatts = valueOf("pack_kw");
      if (kilowatts == null) {
        return "plug in to see delivery";
      }
      return kilowatts < 0
        ? `the pack is delivering ${power(Math.abs(kilowatts))} kW, not taking it`
        : "plug in to see delivery";
    })
  );
}

/**
 * AC: the charger tells you what it is doing, so show it.
 */
function AcDelivery() {
  return div(
    { class: "subgrid" },
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
    LimitsTile()
  );
}

/**
 * Nothing on the charger side is talking, but the pack is — and what the pack is
 * taking is the charge, measured closer to the thing you care about than the
 * charger's own claim would be anyway.
 *
 * Named for where the numbers come from rather than for DC, because it serves the
 * unidentified case too: a charge the BMS reports while no charger frames arrive is
 * not necessarily a fast charge, and only the caption is entitled to guess.
 */
function PackDelivery() {
  return div(
    { class: "subgrid" },
    SignalTile({
      key: "pack_kw",
      label: "Charging at",
      format: value => power(Math.abs(value)),
      unit: "kW",
      color: () => colors.CALM,
      className: "span2",
      chart: true,
      minSpan: 5,
      sub: () =>
        deliveryMode.val === "dc"
          ? "measured at the pack — the DC charger reports nothing on this bus"
          : "measured at the pack — the charger's own frames have gone quiet",
    }),
    SignalTile({
      key: "pack_a",
      label: "Current",
      format: value => Math.abs(value).toFixed(0),
      unit: "A",
      color: () => colors.CALM,
    }),
    SignalTile({
      key: "pack_v",
      label: "Pack",
      format: value => value.toFixed(0),
      unit: "V",
      color: () => colors.CALM,
    })
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
        if (kilowatts == null) {
          return "";
        }
        // Direction, not just magnitude. Math.abs() alone said "0.1 kW in" on a parked
        // bike whose pack was feeding the housekeeping loads — the same wrong-way-round
        // reading as the label below it, from the same missing sign. Exactly zero gets
        // no direction rather than a made-up one.
        const direction = kilowatts > 0 ? " in" : kilowatts < 0 ? " out" : "";
        return `${power(Math.abs(kilowatts))} kW${direction}`;
      }),
      div({ class: "sub" }, chargeModeText)
    )
  );
}

/**
 * Where the charge is coming from, plus whichever phase of it the BMS says it is in.
 * The state bits matter here: trickle and maintenance both look like "charging" but
 * mean the interesting part is over.
 */
function chargeModeText() {
  // deliveryMode itself, not a second derivation of the same question. This line used
  // to work out AC-vs-DC on its own and never asked whether anything was charging at
  // all, so a parked bike read "DC charging" — "not AC" being the only test it made —
  // directly above the card below correctly reporting the pack as DELIVERING 0.1 kW.
  // Reading the state the tiles switch on makes that disagreement unrepresentable.
  const mode = deliveryMode.val;
  if (mode === "none") {
    return "not charging";
  }
  // A source is named only when the bus has shown it: "DC" needs the contactor bit,
  // "AC" needs the charger's own frames. Otherwise the word is simply left out —
  // guessing which one it must be is the whole mistake being corrected here, and it
  // is no more excusable in this direction than it was in the other.
  const source = mode === "ac" ? "AC" : mode === "dc" ? "DC" : null;
  const phase = chargePhase();
  if (phase != null) {
    return source == null ? `charging · ${phase}` : `${source} · ${phase}`;
  }
  return source == null ? "charging" : `${source} charging`;
}

/**
 * Which phase of a charge the BMS is reporting, or null for an ordinary one.
 *
 * Charge-complete is not among them and has no branch anywhere on this screen: it
 * would need `0x201` byte 0 to hold 0x20, and across ~24 M frames that byte has taken
 * exactly three values — 0x01, 0x02 and 0x10. The label it used to have ("AC ·
 * complete") could therefore never render, and a dead branch that looks like it
 * distinguishes a finished charge from one that never started is worse than not
 * drawing the distinction: it reads as though the case were covered.
 * @returns {string | null}
 */
function chargePhase() {
  if (valueOf("bms_state_trickle") === 1) return "trickle";
  if (valueOf("bms_state_maintenance") === 1) return "maintenance";
  if (valueOf("bms_state_balancing") === 1) return "balancing";
  return null;
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
 * How close the pack is to the temperature where DC charging is throttled — the number
 * that decides how long you stand at the charger.
 *
 * The knee is exact rather than fitted: the pack reports a flat 35 °C to the VCU and
 * only starts telling the truth at 55 °C, at which point the VCU throttles. ⚠️ Which is
 * why the tile counts down against the TRUE temperature (batt_temp_hi, off 0x660) and
 * not the clamped one, which would show no approach at all.
 * See docs/dashboard-decisions.md §"The derate knee".
 */
const DERATE_KNEE_C = 55;

/** Bottom of the bar. Below this the pack is nowhere near derating. */
const DERATE_SCALE_FROM_C = 30;

/**
 * Hand-built tiles get no staleness for free, which is the fault this PR calls out
 * in BMS grants — so these two do not get to repeat it. A tile whose inputs have all
 * gone quiet is dimmed rather than left presenting the last number at full
 * brightness, and keys that have never arrived do not count as stale.
 * @param {string[]} keys
 */
function inputsStale(keys) {
  const live = keys.filter(key => valueOf(key) != null);
  return live.length > 0 && live.every(key => isStale(key, STALE_MS));
}

function DerateTile() {
  const headroom = () => {
    const hot = valueOf("batt_temp_hi");
    return hot == null ? null : DERATE_KNEE_C - hot;
  };
  return div(
    { class: () => `tile span2${inputsStale(["batt_temp_hi"]) ? " stale" : ""}` },
    div({ class: "label" }, "Charge derate"),
    div(
      {
        class: "value",
        style: () => {
          const left = headroom();
          if (left == null) {
            return `color:${colors.MUTED}`;
          }
          return `color:${left <= 0 ? colors.BAD : left <= 2 ? colors.WARN : left <= 5 ? colors.WATCH : colors.GOOD}`;
        },
      },
      () => {
        const left = headroom();
        if (left == null) {
          return "–";
        }
        return left <= 0 ? "throttled" : `${left.toFixed(0)}`;
      },
      () => span({ class: "unit" }, (headroom() ?? 1) <= 0 ? "" : "°C to go")
    ),
    () => {
      const hot = valueOf("batt_temp_hi");
      const span = DERATE_KNEE_C - DERATE_SCALE_FROM_C;
      const fraction = hot == null ? null : (hot - DERATE_SCALE_FROM_C) / span;
      const left = headroom();
      const color = left == null ? colors.MUTED : left <= 0 ? colors.BAD : left <= 2 ? colors.WARN : colors.GOOD;
      return meter({ fraction, color, marker: 1 });
    },
    div({ class: "sub" }, () => {
      const hot = valueOf("batt_temp_hi");
      if (hot == null) {
        return `pack temperature not established yet · the VCU starts throttling at ${DERATE_KNEE_C} °C`;
      }
      return `hottest cell ${hot.toFixed(0)} °C · BMS reports a flat 35 °C to the VCU until ${DERATE_KNEE_C} °C, then the truth`;
    })
  );
}

/**
 * Heat going into the pack against heat the loop is taking out.
 *
 * The two halves are not equally solid and the caption says so. Heat in is
 * I²R from the BMS's own resistance estimate, which is sparse and swings several
 * fold. Heat out is ṁ·cp·ΔT with ṁ assumed from the pump's rating — the ΔT is
 * measured, the flow is not. Together they still answer the question the loop was
 * built to answer, which no single number does: is it keeping up.
 */
function ThermalBalanceTile() {
  return div(
    {
      // Both halves have their own inputs; the tile is only old when nothing feeding
      // either of them is current.
      class: () =>
        `tile span2${inputsStale(["pack_a", "pack_resistance_mohm", "coolant_in", "coolant_out"]) ? " stale" : ""}`,
    },
    div({ class: "label" }, "Heat in / out"),
    div(
      { class: "value" },
      () => {
        const into = resistiveLossWatts();
        const out = coolantHeatRemovedWatts();
        if (into == null && out == null) {
          return "–";
        }
        return `${into == null ? "?" : Math.round(into)} / ${out == null ? "?" : Math.round(out)}`;
      },
      span({ class: "unit" }, "W")
    ),
    () => {
      const into = resistiveLossWatts();
      const out = coolantHeatRemovedWatts();
      if (into == null || out == null || into <= 0) {
        return meter({ fraction: null, color: colors.MUTED });
      }
      const keepingUp = out / into;
      const color = keepingUp >= 0.9 ? colors.GOOD : keepingUp >= 0.6 ? colors.WATCH : colors.WARN;
      return meter({ fraction: Math.min(keepingUp, 1), color });
    },
    div({ class: "sub" }, () => {
      const delta = coolantDelta();
      const deltaText = delta == null ? "no coolant probes" : `coolant ΔT ${delta.toFixed(2)} °C`;
      return `${deltaText} · out assumes the pump's rated ${COOLANT_FLOW_LPH} L/h`;
    })
  );
}

/**
 * The pack, module by module.
 *
 * Temperature first: during a fast charge heat is what limits the charge, so the
 * question is which module is running hot, and the 81-cell voltage strip cannot
 * answer it. Voltage is a tap away for when balance is the question instead.
 */
const heatmapMode = van.state(/** @type {"temperature" | "voltage"} */ ("temperature"));

function HeatmapTile() {
  return div(
    { class: "tile span2" },
    div({ class: "label" }, () => (heatmapMode.val === "temperature" ? "Module temperatures" : "Cell voltages")),
    () => {
      chartTick.val;
      return heatmapMode.val === "temperature" ? TemperatureGrid() : VoltageGrid();
    },
    div(
      { class: "toggle-row" },
      .../** @type {const} */ (["temperature", "voltage"]).map(mode =>
        van.tags.button(
          {
            class: () => (heatmapMode.val === mode ? "on" : ""),
            onclick: () => {
              heatmapMode.val = mode;
            },
          },
          mode === "temperature" ? "Temperature" : "Voltage"
        )
      )
    )
  );
}

/** Rows are modules, columns are that module's battery and two board sensors. */
function TemperatureGrid() {
  const rows = [];
  let seen = 0;
  for (let module = 1; module <= MODULE_COUNT; module++) {
    const cells = MODULE_SENSORS.map(sensor => {
      const key = moduleTemperatureKey(module, sensor);
      const value = key == null ? null : peek(key);
      if (value != null) {
        seen += 1;
      }
      return { value, color: colors.temperature(value) };
    });
    rows.push({ label: String(module), cells });
  }
  if (seen === 0) {
    return div({ class: "sub" }, "Module temperatures: waiting for 0x664");
  }
  return div(heatmap({ rows }), div({ class: "sub" }, `${seen} sensors · battery, board 1, board 2 per module`));
}

/** Rows are modules, columns are the cells in them; colour is millivolts below the best. */
function VoltageGrid() {
  const keys = cellVoltageKeys(knownKeys.val);
  if (keys.length === 0) {
    return div({ class: "sub" }, `Cell voltages: waiting for 0x662–0x664 (0 of ${CELL_COUNT})`);
  }
  // Indexed by cell number, not appended: a missing cell has to leave a hole rather
  // than shift every later cell in its module one column left, or the grid stops
  // meaning what the position says — which is the whole reason for drawing a grid.
  // Not hypothetical here: 0x663/0x664 have been observed never sampling modules 1
  // and 2, and a 0xFFFF rejected by bounds.js does the same thing, which is exactly
  // when you want to see the gap.
  /** @type {Map<number, Array<number | null>>} */
  const byModule = new Map();
  let highest = -Infinity;
  for (const key of keys) {
    const match = CELL_VOLTAGE_PATTERN.exec(key);
    if (!match) {
      continue;
    }
    const module = Number(match[1]);
    const cells = byModule.get(module) ?? Array.from({ length: MAX_CELLS_PER_MODULE }, () => null);
    byModule.set(module, cells);
    const value = peek(key);
    if (value == null) {
      continue;
    }
    highest = Math.max(highest, value);
    cells[Number(match[2]) - 1] = value;
  }
  const rows = [];
  let seen = 0;
  for (let module = 1; module <= MODULE_COUNT; module++) {
    const values = byModule.get(module) ?? Array.from({ length: cellsInModule(module) }, () => null);
    rows.push({
      label: String(module),
      // Absolute millivolts below the best cell, matching the strip on the
      // hypermiling screen — a relative scale paints a healthy pack red.
      cells: values.slice(0, cellsInModule(module)).map(value => {
        if (value != null) {
          seen += 1;
        }
        return { value, color: value == null ? "" : colors.spread(highest - value) };
      }),
    });
  }
  return div(
    heatmap({ rows, columns: MAX_CELLS_PER_MODULE }),
    div({ class: "sub" }, `${seen} of ${CELL_COUNT} cells · mV below the best`)
  );
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
