import { record } from "../can/signals.ts";
import { monotonicNow, since } from "../monotonic.ts";
import { formatObdDtc, lookupByObdCode, type DtcTableEntry } from "./dtc-table.ts";
import { describeNegativeResponseCode, type DtcListKind, type ObdTroubleCode } from "./obd-dtc.ts";
import { describeReadOutcome, type DtcReadOutcome } from "../can/obd-dtc.ts";

// The side-effecting half of reading trouble codes over OBD-II: keeps the latest
// answer for each of the three lists, records the counts as signals, and hands the
// whole thing to /stored-dtcs for the dashboard. Kept out of obd-dtc.ts so that
// decoder stays pure and replayable, the same split record.ts makes for the hub's
// active list.
//
// ⚠️ THE CENTRAL DISTINCTION THIS FILE EXISTS TO PROTECT: "the bike says there are
// no codes" and "the bike said nothing" are different claims, and every state below
// keeps them apart. Modes 07 and 0A have never answered on this bike — six
// requests, silence rather than a refusal — so we cannot tell an ECU that does not
// implement pending/permanent codes from one that implements them and will not say.
// Rendering that as "0 pending" would be inventing a reassurance the bike never
// gave. It is `no-response`, all the way to the screen.
//
// Only counts become signals. The list itself does not: 39 stored codes would mean
// 39 more keys in liveState, which ws.ts broadcasts whole every 5 seconds, for a
// list that changes about as often as the bike is serviced. The codes go out over
// /stored-dtcs instead, and the journal names every one of them when the list
// changes — which is where the evidence lives if a future ride needs it.

/** What we currently know about one of the three lists. */
export type TroubleCodeListState =
  /** Never asked this run — the poller has not reached its first read yet. */
  | { state: "not-read" }
  /** The bike answered. `codes` may legitimately be empty. */
  | { state: "codes"; codes: TroubleCodeRow[]; declaredCount: number; truncated: boolean }
  /** Asked; nothing came back at all. NOT "no codes". */
  | { state: "no-response" }
  /**
   * Never made it onto the bus — our socket, not the bike. Deliberately not folded
   * into `no-response`: that one is a claim about the VCU, and this one is a claim
   * about us. `can0` drops whenever the service restarts, and attributing that to
   * the bike would be exactly the kind of invented answer this file exists to avoid.
   */
  | { state: "not-asked"; reason: string }
  /** A transfer started every time and never finished. Distinct from silence. */
  | { state: "incomplete"; reason: string }
  /** The bike refused, by name. */
  | { state: "refused"; negativeResponseCode: number; description: string }
  /** Something answered, but not in a shape we recognise. */
  | { state: "unrecognised"; reason: string };

/** One code, with Energica's own row folded in where the table has one. */
export interface TroubleCodeRow {
  /** The 16-bit field exactly as the bike sent it. */
  raw: number;
  /** What a scan tool would print, e.g. "P0514". */
  obdCode: string;
  /** Energica's "COD."/"SYMPTOM" pair, when the code is in their table. */
  component: number | null;
  symptom: number | null;
  /** The generic OBD name, e.g. "BATTERY TEMPERATURE SENSOR CIRCUIT RANGE/PERFORMANCE". */
  name: string | null;
  /** What Energica means by it on this vehicle. */
  description: string | null;
  /** Whether this code lights the malfunction indicator lamp, or null if unlisted. */
  illuminatesMil: boolean | null;
}

export interface TroubleCodeSnapshot {
  stored: TroubleCodeListState;
  pending: TroubleCodeListState;
  permanent: TroubleCodeListState;
  /**
   * Mode 01 PID 02 — the code that was set when the freeze frame was captured, i.e.
   * in practice the one that lit the lamp. Null until the PID has been polled;
   * `raw: 0` is the bike's own way of saying no freeze frame is stored.
   */
  freezeFrame: TroubleCodeRow | null;
  /** Wall clock of the last completed read round, for display. */
  readAt: number | null;
  /**
   * Age of that read on the MONOTONIC clock — this process steps its own wall clock
   * from GPS (see ../monotonic.ts), so a Date.now() difference here could come back
   * negative or hours wide. Null before the first read.
   */
  ageMs: number | null;
}

/** The counts that do become signals, so the ride log keeps their history. */
const COUNT_SIGNAL_KEYS: Record<DtcListKind, string> = {
  stored: "dtc_stored_count",
  pending: "dtc_pending_count",
  permanent: "dtc_permanent_count",
};

/** Mode 01 PID 02's freeze-frame code, recorded raw so it can be formatted anywhere. */
export const FREEZE_FRAME_DTC_KEY = "freeze_frame_dtc";

const state: Record<DtcListKind, TroubleCodeListState> = {
  stored: { state: "not-read" },
  pending: { state: "not-read" },
  permanent: { state: "not-read" },
};
let freezeFrame: TroubleCodeRow | null = null;
let readAtWallClock: number | null = null;
let readAtMonotonic: number | null = null;

// The lists are re-read on a timer, so only say something when one changes.
// Keyed per list: mode 03 changing must not silence a change in mode 07.
const lastSignature: Record<DtcListKind, string | null> = { stored: null, pending: null, permanent: null };

/**
 * Files one read outcome: updates the snapshot, records the count signal, and logs
 * the list the first time it appears or whenever it changes.
 *
 * A count is recorded ONLY when the bike actually answered. Recording 0 for a
 * silent mode would put a confident "no pending codes" into the ride log and onto
 * the dashboard, which is the one thing this module must never do — and record()
 * refreshes a signal's timestamp on every call, so it would also look freshly
 * confirmed forever.
 */
export function recordTroubleCodeRead(result: DtcReadOutcome, list: DtcListKind): void {
  const previous = lastSignature[list];
  const line = describeReadOutcome(result);

  state[list] = toListState(result);
  const current = state[list];
  if (current.state === "codes") {
    record(COUNT_SIGNAL_KEYS[list], current.codes.length);
  }

  // Only when a question actually reached the bus. "Last read: 3 s ago" next to a
  // list we failed to send would be the screen inventing a freshness it does not
  // have — the whole point of keeping `not-asked` separate.
  if (current.state !== "not-asked") {
    readAtWallClock = Date.now();
    readAtMonotonic = monotonicNow();
  }

  // Signed on the CODES, not on the summary line. `describeReadOutcome` says "39
  // stored code(s)" and nothing more, so a service that cleared one code and set
  // another would leave the count at 39, match the previous signature, and never
  // print the list — silencing the journal for exactly the change worth finding
  // later. The counts are the only signals here, so this journal is the only
  // durable record of WHICH codes were stored.
  const next = current.state === "codes" ? `${line} :: ${current.codes.map(code => code.obdCode).join(",")}` : line;
  if (next === previous) {
    return;
  }
  lastSignature[list] = next;
  console.log(`obd-dtc: ${line}`);
  if (current.state === "codes") {
    for (const code of current.codes) {
      const named = code.description ?? "not in Energica's table";
      console.log(`obd-dtc:   ${code.obdCode} — ${named}${code.illuminatesMil ? " [MIL]" : ""}`);
    }
  }
}

/**
 * Files mode 01 PID 02's freeze-frame code. Separate from the lists above because
 * it comes down the ordinary single-frame PID poll, not over ISO-TP — but it
 * belongs in the same snapshot, since it is the one field that says WHICH of the
 * stored codes is the reason the lamp is on.
 */
export function recordFreezeFrameDtc(raw: number): void {
  const changed = freezeFrame?.raw !== raw;
  // A row with `raw: 0` and an EMPTY obdCode, rather than null and rather than
  // "P0000". Null is reserved for "PID 02 has not answered yet", which the dashboard
  // has to be able to tell apart from the bike saying there is no freeze frame; and
  // P0000 is not a code — formatting 0 as one would put a phantom on the screen.
  freezeFrame = raw === 0 ? { raw, obdCode: "", ...unlisted() } : describeTroubleCode(raw);
  if (!changed) {
    return;
  }
  if (raw === 0) {
    console.log("obd-dtc: freeze-frame DTC = 0000 (no freeze frame stored)");
    return;
  }
  console.log(`obd-dtc: freeze-frame DTC = ${freezeFrame.obdCode} — ${freezeFrame.description ?? "not in the table"}`);
}

/** Everything known about the three lists, as plain data for /stored-dtcs. */
export function troubleCodeSnapshot(): TroubleCodeSnapshot {
  return {
    stored: state.stored,
    pending: state.pending,
    permanent: state.permanent,
    // A raw of 0 is "no freeze frame stored", which is a real answer and not the
    // same as "not polled yet" — so it survives as a row rather than becoming null.
    freezeFrame,
    readAt: readAtWallClock,
    ageMs: readAtMonotonic === null ? null : Math.round(since(readAtMonotonic)),
  };
}

function toListState(result: DtcReadOutcome): TroubleCodeListState {
  if (result.outcome === "silent") {
    return { state: "no-response" };
  }
  if (result.outcome === "not-sent") {
    return { state: "not-asked", reason: result.reason };
  }
  if (result.outcome === "truncated") {
    return { state: "incomplete", reason: result.reason };
  }
  const { response } = result;
  if (response.kind === "negative") {
    return {
      state: "refused",
      negativeResponseCode: response.negativeResponseCode,
      description: describeNegativeResponseCode(response.negativeResponseCode),
    };
  }
  if (response.kind === "unrecognised") {
    return { state: "unrecognised", reason: response.reason };
  }
  return {
    state: "codes",
    codes: response.codes.map(toRow),
    declaredCount: response.declaredCount,
    truncated: response.truncated,
  };
}

function toRow(code: ObdTroubleCode): TroubleCodeRow {
  return { raw: code.raw, obdCode: code.code, ...fromEntry(code.entry) };
}

/** Formats and names a bare 16-bit DTC — used for the freeze-frame field. */
function describeTroubleCode(raw: number): TroubleCodeRow {
  const obdCode = formatObdDtc(raw);
  return { raw, obdCode, ...fromEntry(lookupByObdCode(obdCode)) };
}

function fromEntry(entry: DtcTableEntry | null): Omit<TroubleCodeRow, "raw" | "obdCode"> {
  if (!entry) {
    return unlisted();
  }
  return {
    component: entry.component,
    symptom: entry.symptom,
    name: entry.name,
    description: entry.description,
    illuminatesMil: entry.illuminatesMil,
  };
}

/**
 * Nulls, not empty strings or `false`: a code Energica's table does not list has no
 * MIL column, and rendering that absence as "warning lamp: no" would be an answer
 * we do not have.
 */
function unlisted(): Omit<TroubleCodeRow, "raw" | "obdCode"> {
  return { component: null, symptom: null, name: null, description: null, illuminatesMil: null };
}
