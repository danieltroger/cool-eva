import { counterRows, packRows } from "./lifetime-rows.ts";
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
