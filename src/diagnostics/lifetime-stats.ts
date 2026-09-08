import { BANDS, withinBand } from "./lifetime-bands.ts";
import type { FreezeFrame, FreezeFrameResponse, FreezeFrameValue } from "./freeze-frame.ts";

// The bike's own lifetime battery statistics, out of the two freeze frames that carry
// them: component 51 `P1050 BATTERY STATISTICS INFO1` and component 52 `P1051 INFO2`.
// Pure — decoded frames in, presentable rows out — so the whole feature is exercised
// from a laptop against captured replies (scripts/check-lifetime-stats.ts).
//
// ⚠️ These are NOT broadcast signals. Nothing on the bus carries them
// (obd-garage/DC_CHARGE_LIMITS.md §10.6 proves that twice over), so they cannot be
// store signals with an arrival time and a staleness, and this module deliberately
// produces rows rather than emitting into src/can/signals.ts.
//
// What each key means, why `TotalExchangedAh` is shown unscaled, and what would
// settle it: docs/lifetime-battery-statistics.md.

/**
 * A full pack, in amp-hours, as THIS bike reports it: `remaining_ah` tops out at 64.0
 * and stays there (22 samples at the ceiling, with a smooth run down from it), so this
 * is a measurement off the bike rather than a spec sheet.
 *
 * Used only to put the candidate scales into the unit a rider can judge — full packs,
 * and kilometres per pack. It decides nothing.
 */
const FULL_PACK_AH = 64;

/** Component 60 is `P1052 INFO3` and its shortlist is empty, so it is not read here — see the doc. */
export const LIFETIME_COMPONENTS = { packState: 51, counters: 52 } as const;

/** How a number came out. `unscaled` is a real answer, not a failure — see `TotalExchangedAh`. */
export type LifetimeRowStatus = "ok" | "unscaled" | "rejected" | "missing";

/** One number as the dashboard should show it. Formatting is the caller's; policy is not. */
export interface LifetimeRow {
  /** Stable id, for the UI to key on. */
  key: string;
  label: string;
  status: LifetimeRowStatus;
  /** The number to show, or null when there is not one to show. */
  value: number | null;
  unit: string;
  /** Exactly what the bytes said. Present whenever a field was decoded at all. */
  raw: number | null;
  /** Why the value is missing, refused or worth a caveat. Shown verbatim under the number. */
  note: string | null;
  /**
   * Numbers that belong WITH this one rather than beside it — the AC/DC split under
   * the charge count, the cell bounds under the spread.
   *
   * Formatted here rather than in the browser because what belongs together, and what
   * a rejected constituent should look like, is the same judgement as the row itself.
   * The All tab is one screen scanned at a glance; eleven tiles was not that.
   */
  detail: string[];
}

/** What one component answered, kept whether or not it answered usefully. */
export interface LifetimeComponentOutcome {
  component: number;
  /** `frame`, `refused`, `component-mismatch` or `unrecognised` — the decoder's own kinds. */
  kind: FreezeFrameResponse["kind"];
  obdCode: string | null;
  /**
   * The trailing byte: key cycles since this record was stored, not times it happened.
   *
   * It advances by exactly one per power/ignition cycle with every other byte of the
   * payload frozen. ⚠️ Not an OBD aging counter — those count fault-free cycles and
   * reset on recurrence. Measured 2026-09-08 across five components over one VCU reset
   * and one key-off/key-on; docs/diagnostics-and-checks.md.
   */
  cyclesSinceStored: number | null;
  /** Everything the bike sent, so a bad read is still evidence. */
  rawHex: string;
}

/** A whole reading, as stored and as served. */
export interface LifetimeStatistics {
  /** Pi wall clock when the bike was asked. Rendered with `ageInWords`, never subtracted from a phone clock. */
  readAt: number;
  /** True only when BOTH components decoded to a frame. A half reading is kept and labelled. */
  complete: boolean;
  rows: LifetimeRow[];
  components: LifetimeComponentOutcome[];
}

/**
 * Turns the two decoded replies into a reading.
 *
 * Takes whatever came back, including the three non-`frame` outcomes: on a bus where
 * an answer to somebody else's question is a thing that happens, `component-mismatch`
 * is not hypothetical, and dropping it would leave the screen saying nothing rather
 * than saying what went wrong.
 */
export function summariseLifetimeStatistics(
  readAt: number,
  responses: readonly { component: number; response: FreezeFrameResponse }[]
): LifetimeStatistics {
  const packState = frameFor(responses, LIFETIME_COMPONENTS.packState);
  const counters = frameFor(responses, LIFETIME_COMPONENTS.counters);
  return {
    readAt,
    complete: packState !== null && counters !== null,
    // The odometer comes from the OTHER component, so the counters' rows are built with
    // it in hand: kilometres per full pack is the only form of the charge counter a
    // rider can weigh, and it needs both frames.
    rows: [...counterRows(counters, odometerOf(packState)), ...packRows(packState)],
    components: responses.map(entry => describeOutcome(entry.component, entry.response)),
  };
}

/** The counters, from component 52. Empty when it did not answer with a frame. */
function counterRows(frame: FreezeFrame | null, odometerKm: number | null): LifetimeRow[] {
  if (!frame) {
    return [missingRow("charges", "charges", 52), missingRow("exchanged_ah", "charge moved", 52)];
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
function packRows(frame: FreezeFrame | null): LifetimeRow[] {
  if (!frame) {
    return [missingRow("odometer_km", "odometer", 51), missingRow("state_of_health", "state of health", 51)];
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
  const perPack = odometerKm === null ? null : odometerKm / packs;
  const range = perPack === null ? "" : `, ≈${Math.round(perPack)} km each`;
  return `≈${Math.round(ampHours)} Ah at ${label} — ≈${Math.round(packs)} full packs${range}`;
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
    `${describeCell("weakest", minimum, "cell_min_mv")} (#${fieldOf(frame, "B_MIN_CELL_ID")?.raw ?? "?"})`,
    `${describeCell("strongest", maximum, "cell_max_mv")} (#${fieldOf(frame, "B_MAX_CELL_ID")?.raw ?? "?"})`,
    `at ${fieldOf(frame, "B_SOC")?.raw ?? "?"} % charge`,
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
      raw: spread,
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

/** The frame for one component, or null when it answered anything else. */
function frameFor(
  responses: readonly { component: number; response: FreezeFrameResponse }[],
  component: number
): FreezeFrame | null {
  const entry = responses.find(candidate => candidate.component === component);
  return entry && entry.response.kind === "frame" ? entry.response.frame : null;
}

/** The odometer in km, or null when component 51 did not answer. */
function odometerOf(frame: FreezeFrame | null): number | null {
  return frame ? (fieldOf(frame, "V_ODOMETER")?.value ?? null) : null;
}

/** One field of a frame by Energica's own name, or null when the shortlist does not carry it. */
function fieldOf(frame: FreezeFrame, name: string): FreezeFrameValue | null {
  return frame.values.find(value => value.name === name) ?? null;
}

function describeOutcome(component: number, response: FreezeFrameResponse): LifetimeComponentOutcome {
  if (response.kind !== "frame") {
    return { component, kind: response.kind, obdCode: null, cyclesSinceStored: null, rawHex: response.rawHex };
  }
  const trailing = response.frame.trailingHex;
  return {
    component,
    kind: "frame",
    obdCode: response.frame.obdCode,
    // More than one byte would mean the layout moved, so it is reported as unknown
    // rather than parsed out of something this reading does not describe.
    cyclesSinceStored: trailing !== null && /^[0-9A-F]{2}$/.test(trailing) ? Number.parseInt(trailing, 16) : null,
    rawHex: response.frame.rawHex,
  };
}
