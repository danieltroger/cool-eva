import { bandFor, withinBand } from "./lifetime-bands.ts";
import type { FreezeFrame, FreezeFrameValue } from "./freeze-frame.ts";
import type { LifetimeRow } from "./lifetime-stats.ts";

// One row per number the lifetime block shows, and the prose that goes under it.
//
// Split from ./lifetime-stats.ts, which owns what a READING is; this owns how each
// number is PRESENTED — which of them belong together, what a refused scale should say,
// and what a rejected constituent looks like. Both are pure.
//
// ⚠️ The prose lives here rather than in the browser on purpose. Two of these numbers
// are shown unscaled, so the line under them is what makes them mean anything, and
// deciding that is the same judgement as deciding the row.

/**
 * Every row this module can produce: its label and the component that carries it.
 *
 * ⚠️ ONE place. Each of these was previously spelled twice — once where the field
 * decodes and once in the "component did not answer" branch — so a rename left the tile
 * called one thing when the read worked and another when it did not.
 */
const ROWS: Record<string, { label: string; component: number }> = {
  charges: { label: "charges", component: 52 },
  exchanged_ah: { label: "charge moved", component: 52 },
  average_battery_temp_c: { label: "average pack temperature", component: 52 },
  average_depth_of_discharge: { label: "average depth of discharge", component: 52 },
  odometer_km: { label: "odometer", component: 51 },
  state_of_health: { label: "state of health", component: 51 },
  cell_spread_mv: { label: "cell spread", component: 51 },
};

/**
 * One row, with the fields a row usually does not decide filled in.
 *
 * Six of these rows differ from each other in two fields out of eight; spelling all
 * eight each time buried the part that varies and made adding a field a ten-site edit.
 */
function row(key: string, fields: Partial<Omit<LifetimeRow, "key">>): LifetimeRow {
  return {
    key,
    label: ROWS[key]?.label ?? key,
    status: "ok",
    value: null,
    unit: "",
    raw: null,
    detail: [],
    note: null,
    ...fields,
  };
}

/** The counters, from component 52. Every row marked `missing` when it did not answer. */
export function counterRows(
  frame: FreezeFrame | null,
  odometerKm: number | null,
  outcome: string | null
): LifetimeRow[] {
  if (!frame) {
    // ⚠️ EVERY row this component owns, not a representative pair. A half reading that
    // silently dropped two tiles would look like a bike that has fewer statistics, not
    // like a read that half failed.
    return [
      missingRow("charges", outcome),
      missingRow("exchanged_ah", outcome),
      missingRow("average_battery_temp_c", outcome),
      missingRow("average_depth_of_discharge", outcome),
    ];
  }
  return [
    chargesRow(
      fieldOf(frame, "CompletedCharges"),
      fieldOf(frame, "CompletedACCharges"),
      fieldOf(frame, "CompletedDCCharges")
    ),
    exchangedRow(fieldOf(frame, "TotalExchangedAh"), odometerKm),
    numberRow("average_battery_temp_c", "average pack temperature", fieldOf(frame, "AvgBattTemp"), RECENT_AVERAGE_NOTE),
    depthOfDischargeRow(fieldOf(frame, "AvgDOD")),
  ];
}

/** Pack health and the odometer, from component 51. */
export function packRows(frame: FreezeFrame | null, outcome: string | null): LifetimeRow[] {
  if (!frame) {
    return [missingRow("odometer_km"), missingRow("state_of_health"), missingRow("cell_spread_mv")];
  }
  return [
    numberRow("odometer_km", "odometer", fieldOf(frame, "V_ODOMETER")),
    numberRow("state_of_health", "state of health", fieldOf(frame, "B_SOH")),
    cellSpreadRow(frame),
  ];
}

/**
 * ⚠️ NOT a lifetime mean, and saying so is the point.
 *
 * 33.0 °C on 2026-08-08 against 29.4 °C on 2026-09-08, 72 charges apart: for a
 * cumulative average over the 946 charges before it, those 72 would have to average
 * −17.9 °C. It tracks the season instead. docs/lifetime-battery-statistics.md.
 */
const RECENT_AVERAGE_NOTE = "a recent average, not a lifetime one — it tracked the season between the two reads";

/** Cell spread is meaningless without the charge it was measured at: 43 mV at 19 % SOC and 20 mV at 99 % is one healthy pack. */
const SOC_CONTEXT_NOTE = "a full pack always looks tighter than an empty one, so read this against the charge above";

/**
 * `TotalExchangedAh`, shown as the raw count it is.
 *
 * The scale is unsettled and the field is refused in ./infokey-table.ts, so this row
 * carries the two candidates and the way to decide between them rather than a number
 * wearing a unit. The estimates are computed from the raw, so they cannot drift out
 * of step with it.
 */
function exchangedRow(field: FreezeFrameValue | null, odometerKm: number | null): LifetimeRow {
  if (!field) {
    return missingRow("exchanged_ah");
  }
  if (field.value !== null) {
    // ⚠️ Derived, never asserted. If ./infokey-table.ts ever applies a scale to this
    // field again, this row shows the scaled number rather than going on printing
    // candidate scales beside a value that has stopped being a candidate.
    return numberRow("exchanged_ah", "charge moved", field);
  }
  return row("exchanged_ah", {
    status: "unscaled",
    raw: field.raw,
    detail: [
      describeCandidate(field.raw * 0.01, "×0.01", odometerKm),
      describeCandidate(field.raw / 64, "÷64", odometerKm),
    ],
    // ⚠️ Through the same helper as the two candidates above. Hand-inlining this third
    // copy is how it lost the `packs <= 0` guard and put ≈Infinity back on the one row
    // whose whole job is to be honest about a number nobody knows.
    note:
      `Energica's own would be ${describeCandidate(field.raw * 0.1, "×0.1", odometerKm)}, ` +
      `which this pack's own logged current refutes by 7.4×. Which of the two above is right is unsettled; ` +
      `two reads bracketing one charge session would settle it.`,
  });
}

/**
 * One candidate scale in the units a rider can judge it in.
 *
 * Full packs and kilometres per pack, because "6 581 Ah" is unjudgeable and "179 km on
 * a full charge" is a number anybody who rides this bike has an opinion about. The
 * arithmetic is stated, not hidden: amp-hours ÷ a measured full pack, and the odometer
 * ÷ that.
 */
function describeCandidate(ampHours: number, label: string, odometerKm: number | null): string {
  const packs = ampHours / FULL_PACK_AH;
  // A counter reading zero is a real answer — a replaced pack — and dividing the
  // odometer by no packs at all put "≈Infinity km each" on the tile.
  const perPack = odometerKm === null || packs <= 0 ? null : odometerKm / packs;
  const range = perPack === null ? "" : `, ≈${Math.round(perPack)} km each`;
  return `≈${Math.round(ampHours)} Ah at ${label} — ≈${Math.round(packs)} full packs${range}`;
}

/**
 * One raw reading for a detail line, marked when it is outside its band.
 *
 * ⚠️ Gates on `value` and prints `raw`. Identical for every key it is used with, since
 * all of them scale by the identity — but the day one of them does not, this shows the
 * unscaled number against a bound checked on the scaled one.
 */
function gated(field: FreezeFrameValue | null, key: string): string {
  if (!field) {
    return "–";
  }
  return withinBand(key, field.value) ? String(field.raw) : `⚠ ${field.raw}`;
}

/**
 * `AvgDOD`, whose equation is malformed in Energica's own data (`f(x)=x@&255`).
 *
 * `x & 255` is the reading the evidence supports — it gives 59 % then 58 % across the
 * two reads, where `x >> 8 & 255` gives 11 % then 100 %, and Energica's own tool
 * displayed 59 for the first of them. Still shown as a candidate, not a decode: the
 * high byte is unexplained either way.
 */
function depthOfDischargeRow(field: FreezeFrameValue | null): LifetimeRow {
  if (!field) {
    return missingRow("average_depth_of_discharge");
  }
  return row("average_depth_of_discharge", {
    status: "unscaled",
    raw: field.raw,
    note: `${field.raw & 0xff} % if Energica's malformed equation means x & 255 — their own tool agreed once, unconfirmed`,
  });
}

/**
 * The charge count, with its split — and the fourth number the other three imply.
 *
 * A fourth number rather than three that visibly fail to add up. It is a small slow
 * residue and not a decode fault: 31 on 2026-08-08 and 32 on 2026-09-08, so it grew
 * by one while 71 of 72 new charges classified.
 */
function chargesRow(
  total: FreezeFrameValue | null,
  alternating: FreezeFrameValue | null,
  direct: FreezeFrameValue | null
): LifetimeRow {
  if (!total || !alternating || !direct) {
    return missingRow("charges");
  }
  const residue = total.raw - alternating.raw - direct.raw;
  const impossible = residue < 0;
  return row("charges", {
    status: impossible ? "rejected" : "ok",
    value: impossible ? null : total.raw,
    raw: total.raw,
    detail: [`${alternating.raw} AC`, `${direct.raw} DC`, `${residue} neither`],
    note: impossible
      ? "the subtotals exceed the total, which no reading of these counters allows"
      : "the AC count most likely counts charger cycles rather than plug-ins — 68 of them in the month between the " +
        "two reads, on a bike left plugged in at home. The last number is counted in the total but in neither " +
        "subtotal: aborted or pre-counter sessions, unidentified.",
  });
}

/**
 * Cell spread as the headline, with the bounds and the ids under it.
 *
 * The spread is the number that says something about the pack; the two voltages are
 * what it is made of. ⚠️ Rejected as a whole when either bound is out of band — a
 * spread computed from a 0xFFFF sentinel is a plausible-looking number made of a dead
 * reading, which is the failure public/lib/bounds.js exists to prevent elsewhere.
 */
function cellSpreadRow(frame: FreezeFrame): LifetimeRow {
  const minimum = fieldOf(frame, "B_MIN_CELL");
  const maximum = fieldOf(frame, "B_MAX_CELL");
  if (!minimum || !maximum) {
    return missingRow("cell_spread_mv");
  }
  const detail = [
    `average ${gated(fieldOf(frame, "B_AVG_CELL"), "cell_avg_mv")} mV`,
    `weakest ${gated(minimum, "cell_min_mv")} mV (#${gated(fieldOf(frame, "B_MIN_CELL_ID"), "cell_min_id")})`,
    `strongest ${gated(maximum, "cell_max_mv")} mV (#${gated(fieldOf(frame, "B_MAX_CELL_ID"), "cell_max_id")})`,
    `at ${gated(fieldOf(frame, "B_SOC"), "state_of_charge")} % charge`,
  ];
  const bounded = withinBand("cell_min_mv", minimum.value) && withinBand("cell_max_mv", maximum.value);
  const spread = maximum.raw - minimum.raw;
  const rejected = !bounded || spread < 0 || !withinBand("cell_spread_mv", spread);
  return row("cell_spread_mv", {
    status: rejected ? "rejected" : "ok",
    value: rejected ? null : spread,
    unit: "mV",
    // ⚠️ NOT the computed spread when rejected. Two dead cells both reading 0xFFFF give
    // a spread of 0 — the most reassuring number this tile can show, made of the worst
    // reading it can get. There is no number here; the detail carries the sentinels.
    raw: rejected ? null : spread,
    detail,
    note: rejected
      ? "computed from a cell voltage outside 1500…4500 mV — a dead sensor or a sentinel, not a reading"
      : SOC_CONTEXT_NOTE,
  });
}

/** One decoded field as a row, gated against its physical band. */
function numberRow(
  key: string,
  label: string,
  field: FreezeFrameValue | null,
  note: string | null = null
): LifetimeRow {
  if (!field) {
    return missingRow(key);
  }
  if (field.value === null) {
    return row(key, { label, status: "unscaled", unit: field.unit, raw: field.raw, note: field.scalingNote });
  }
  const band = bandFor(key);
  if (band && !withinBand(key, field.value)) {
    return row(key, {
      label,
      status: "rejected",
      unit: field.unit,
      raw: field.raw,
      note: `outside ${band[0]}…${band[1]} ${field.unit} — a dead sensor or a sentinel, not a reading`,
    });
  }
  return row(key, { label, value: field.value, unit: field.unit, raw: field.raw, note });
}

function missingRow(key: string, outcome: string | null = null): LifetimeRow {
  const component = ROWS[key]?.component ?? null;
  return row(key, {
    status: "missing",
    note:
      component === null
        ? "not in the reply"
        : `component ${component} did not answer with a frame${outcome === null ? "" : ` — ${outcome}`}`,
  });
}

/**
 * A full pack, in amp-hours, as THIS bike reports it: `remaining_ah` tops out at 64.0
 * and stays there (22 samples at the ceiling, with a smooth run down from it), so this
 * is a measurement off the bike rather than a spec sheet.
 *
 * Used only to put the candidate scales into the unit a rider can judge — full packs,
 * and kilometres per pack. It decides nothing.
 */
const FULL_PACK_AH = 64;

/** One field of a frame by Energica's own name, or null when the shortlist does not carry it. */
export function fieldOf(frame: FreezeFrame, name: string): FreezeFrameValue | null {
  return frame.values.find(value => value.name === name) ?? null;
}
