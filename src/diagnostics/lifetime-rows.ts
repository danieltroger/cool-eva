import { BANDS, withinBand } from "./lifetime-bands.ts";
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

/** The counters, from component 52. Empty when it did not answer with a frame. */
export function counterRows(frame: FreezeFrame | null, odometerKm: number | null): LifetimeRow[] {
  if (!frame) {
    // ⚠️ EVERY row this component owns, not a representative pair. A half reading that
    // silently dropped two tiles would look like a bike that has fewer statistics, not
    // like a read that half failed.
    return [
      missingRow("charges", "charges", 52),
      missingRow("exchanged_ah", "charge moved", 52),
      missingRow("average_battery_temp_c", "average pack temperature", 52),
      missingRow("average_depth_of_discharge", "average depth of discharge", 52),
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
export function packRows(frame: FreezeFrame | null): LifetimeRow[] {
  if (!frame) {
    return [
      missingRow("odometer_km", "odometer", 51),
      missingRow("state_of_health", "state of health", 51),
      missingRow("cell_spread_mv", "cell spread", 51),
    ];
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
    return missingRow("exchanged_ah", "charge moved", 52);
  }
  if (field.value !== null) {
    // ⚠️ Derived, never asserted. If ./infokey-table.ts ever applies a scale to this
    // field again, this row shows the scaled number rather than going on printing
    // candidate scales beside a value that has stopped being a candidate.
    return numberRow("exchanged_ah", "charge moved", field);
  }
  return {
    key: "exchanged_ah",
    label: "charge moved",
    status: "unscaled",
    value: null,
    unit: "",
    raw: field.raw,
    detail: [
      describeCandidate(field.raw * 0.01, "×0.01", odometerKm),
      describeCandidate(field.raw / 64, "÷64", odometerKm),
    ],
    note:
      `Energica's own scaling would make it ${Math.round(field.raw * 0.1)} Ah — ` +
      `${Math.round((field.raw * 0.1) / FULL_PACK_AH)} full packs, ${odometerKm === null ? "" : `≈${Math.round(odometerKm / ((field.raw * 0.1) / FULL_PACK_AH))} km each, `}` +
      `which this pack's own logged current refutes by 7.4×. Which of the two above is right is unsettled; ` +
      `two reads bracketing one charge session would settle it.`,
  };
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

/** One raw reading for a detail line, marked when it is outside its band. */
function gated(field: FreezeFrameValue | null, key: string): string {
  if (!field) {
    return "?";
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
    return missingRow("average_depth_of_discharge", "average depth of discharge", 52);
  }
  return {
    key: "average_depth_of_discharge",
    label: "average depth of discharge",
    status: "unscaled",
    value: null,
    unit: "",
    raw: field.raw,
    detail: [],
    note: `${field.raw & 0xff} % if Energica's malformed equation means x & 255 — their own tool agreed once, unconfirmed`,
  };
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
    return missingRow("charges", "charges", 52);
  }
  const residue = total.raw - alternating.raw - direct.raw;
  const impossible = residue < 0;
  return {
    key: "charges",
    label: "charges",
    status: impossible ? "rejected" : "ok",
    value: impossible ? null : total.raw,
    unit: "",
    raw: total.raw,
    detail: [`${alternating.raw} AC`, `${direct.raw} DC`, `${residue} neither`],
    note: impossible
      ? "the subtotals exceed the total, which no reading of these counters allows"
      : "the AC count most likely counts charger cycles rather than plug-ins — 68 of them in the month between the " +
        "two reads, on a bike left plugged in at home. The last number is counted in the total but in neither " +
        "subtotal: aborted or pre-counter sessions, unidentified.",
  };
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
    return missingRow("cell_spread_mv", "cell spread", 51);
  }
  const detail = [
    describeCell("average", fieldOf(frame, "B_AVG_CELL"), "cell_avg_mv"),
    `${describeCell("weakest", minimum, "cell_min_mv")} (#${gated(fieldOf(frame, "B_MIN_CELL_ID"), "cell_min_id")})`,
    `${describeCell("strongest", maximum, "cell_max_mv")} (#${gated(fieldOf(frame, "B_MAX_CELL_ID"), "cell_max_id")})`,
    `at ${gated(fieldOf(frame, "B_SOC"), "state_of_charge")} % charge`,
  ];
  const bounded = withinBand("cell_min_mv", minimum.value) && withinBand("cell_max_mv", maximum.value);
  const spread = maximum.raw - minimum.raw;
  if (!bounded || spread < 0) {
    return {
      key: "cell_spread_mv",
      label: "cell spread",
      status: "rejected",
      value: null,
      unit: "mV",
      // ⚠️ NOT the computed spread. Two dead cells both reading 0xFFFF give a spread of
      // 0 — the most reassuring number this tile can show, made of the worst reading it
      // can get. There is no number here, and the detail carries the sentinels.
      raw: null,
      detail,
      note: "computed from a cell voltage outside 1500…4500 mV — a dead sensor or a sentinel, not a reading",
    };
  }
  return {
    key: "cell_spread_mv",
    label: "cell spread",
    status: "ok",
    value: spread,
    unit: "mV",
    raw: spread,
    detail,
    note: SOC_CONTEXT_NOTE,
  };
}

/** One cell voltage for the detail line, marked when it is outside its band. */
function describeCell(label: string, field: FreezeFrameValue | null, key: string): string {
  if (!field) {
    return `${label} –`;
  }
  return withinBand(key, field.value) ? `${label} ${field.raw} mV` : `${label} ⚠ ${field.raw}`;
}

/** One decoded field as a row, gated against its physical band. */
function numberRow(
  key: string,
  label: string,
  field: FreezeFrameValue | null,
  note: string | null = null
): LifetimeRow {
  if (!field) {
    return missingRow(key, label, null);
  }
  if (field.value === null) {
    return {
      key,
      label,
      status: "unscaled",
      value: null,
      unit: field.unit,
      raw: field.raw,
      detail: [],
      note: field.scalingNote,
    };
  }
  const band = BANDS[key];
  if (band && (field.value < band[0] || field.value > band[1])) {
    return {
      key,
      label,
      status: "rejected",
      value: null,
      unit: field.unit,
      raw: field.raw,
      detail: [],
      note: `outside ${band[0]}…${band[1]} ${field.unit} — a dead sensor or a sentinel, not a reading`,
    };
  }
  return { key, label, status: "ok", value: field.value, unit: field.unit, raw: field.raw, detail: [], note };
}

function missingRow(key: string, label: string, component: number | null): LifetimeRow {
  return {
    key,
    label,
    status: "missing",
    value: null,
    unit: "",
    raw: null,
    detail: [],
    note: component === null ? "not in the reply" : `component ${component} did not answer with a frame`,
  };
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
function fieldOf(frame: FreezeFrame, name: string): FreezeFrameValue | null {
  return frame.values.find(value => value.name === name) ?? null;
}
