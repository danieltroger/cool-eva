import { interpretRecord } from "./param-codec.ts";
import { parameterAtIndex, type ParameterStorageType, type VcuMicro } from "./param-table.ts";
import type { VcuReadOutcome } from "./kwp-client.ts";

// What a parameter read looks like once it has been written down: one flat row per
// parameter, a snapshot of many of them, and the diff between two snapshots.
//
// Pure — no I/O, no clock beyond the caller-supplied timestamp. Which is the point:
// the diff is the part that decides whether the bike has been reconfigured, and it
// can be exercised against two files on a laptop.
//
// ── Why a snapshot and not a signal ──────────────────────────────────────────
// These are configuration, not telemetry. They do not move while riding, so
// logging 277 of them as time series at any rate is storage spent on re-recording
// a constant — the deadband reasoning in src/can/registry.ts counts rows/day onto
// a Pi Zero's SD card for signals that genuinely change, and these do not.
// Neither do they belong in `liveState`, which src/ws.ts re-broadcasts WHOLE every
// five seconds; src/diagnostics/stored-codes.ts already declined to put 39 trouble
// codes there for exactly that reason, and this would be seven times worse.
//
// What IS worth knowing is that one of them CHANGED, because that means something
// reconfigured the bike. That is a diff between two snapshots, not a sample rate —
// hence this file.

/** One parameter, as read (or as failed to be read). Flat on purpose: this is a wire and file shape. */
export interface VcuParameterRow {
  index: number;
  /** `0x1000 | index`. */
  identifier: number;
  micro: VcuMicro;
  /**
   * From the name table, or null for an identifier it does not describe. Null is NOT
   * an error: the table covers 1…277 with no gaps, so null means an index outside that
   * range, and a variant with more parameters than this file knows would show up here
   * the same way — with its raw value intact. (260/262/263/265 are named EVSE
   * placeholders that read 0 on this bike, not unnamed slots.)
   */
  name: string | null;
  section: string | null;
  type: ParameterStorageType | null;
  signed: boolean | null;
  /** Which of VcuReadOutcome's cases this row records. */
  status: VcuReadOutcome["status"];
  /** Exactly what the bike sent, or null if it sent nothing. */
  rawHex: string | null;
  /** Big-endian unsigned reading of those bytes. Null only when there are none. */
  unsigned: number | null;
  /** Typed per the table's S/U column; null when there is no honest typed reading. See VcuParameterValue. */
  value: number | null;
  /** The reply's length contradicts the table's TYPE column. */
  widthMismatch: boolean;
  /**
   * The value the OTHER bike's params.ecf carries. NEVER this bike's — see the
   * warning in ./param-table.ts. Carried so a diff can say "this now matches the
   * variant file where it used to differ", and so the page can label a comparison
   * column honestly. Anything rendering it MUST say whose value it is.
   */
  otherBikeValue: number | null;
  /** Why a non-`read` row is not a value: the refusal, the reason, the NRC. Null on a clean read. */
  note: string | null;
}

export interface VcuParameterSnapshot {
  /**
   * Wall clock at the last row, for display. Date.now() is right here — this stamps
   * WHEN something happened rather than measuring a duration (see ../monotonic.ts).
   */
  readAt: number;
  /**
   * False when the sweep did not finish: the link dropped, Ctrl-C, a micro went
   * quiet. The rows that were read are still every bit as true, so a partial
   * snapshot is kept and labelled rather than discarded — which is the whole reason
   * this flag exists rather than the file simply being absent.
   */
  complete: boolean;
  /** Which micros were asked. A sweep of one micro must not look like the other's parameters vanished. */
  micros: VcuMicro[];
  rows: VcuParameterRow[];
}

/** Turns one read outcome into a row, folding in whatever the name table knows. */
export function toParameterRow(outcome: VcuReadOutcome): VcuParameterRow {
  const parameter = parameterAtIndex(outcome.index);
  const base = {
    index: outcome.index,
    identifier: outcome.identifier,
    micro: outcome.micro,
    name: parameter?.name ?? null,
    section: parameter?.section ?? null,
    type: parameter?.type ?? null,
    signed: parameter?.signed ?? null,
    status: outcome.status,
    otherBikeValue: parameter?.otherBikeValue ?? null,
  };
  if (outcome.status !== "read") {
    return {
      ...base,
      rawHex: null,
      unsigned: null,
      value: null,
      widthMismatch: false,
      note: describeFailure(outcome),
    };
  }
  const interpreted = interpretRecord(outcome.record, parameter);
  return {
    ...base,
    rawHex: interpreted.rawHex,
    unsigned: interpreted.unsigned,
    value: interpreted.value,
    widthMismatch: interpreted.widthMismatch,
    note: interpreted.widthMismatch
      ? `record is ${outcome.record.length} byte(s); the name table says ${parameter?.type} — value withheld, raw kept`
      : null,
  };
}

/** What changed between two snapshots. */
export type VcuParameterChange = {
  index: number;
  name: string | null;
  micro: VcuMicro;
} & (
  | { kind: "value-changed"; from: string; to: string; fromValue: number | null; toValue: number | null }
  /** Readable before, not now (or the other way round). Worth seeing, but it is a claim about the read, not the bike's config. */
  | { kind: "status-changed"; from: VcuParameterRow["status"]; to: VcuParameterRow["status"] }
  /** In the new snapshot only. Ordinary when the two sweeps covered different micros or index sets. */
  | { kind: "appeared" }
  /** In the old snapshot only. Same caveat. */
  | { kind: "disappeared" }
);

/**
 * Compares two snapshots by parameter index.
 *
 * `value-changed` is the one that means something: a calibration parameter this
 * bike used to hold at one value now holds another, i.e. something wrote to the
 * VCU's EEPROM between the two reads. The comparison is on the RAW BYTES rather
 * than the decoded number, so a change is a change even where the name table has
 * no opinion about width or sign.
 *
 * The other three kinds are about the reads, not the bike. They are reported
 * separately precisely so that "the A8 was asleep this time" cannot be read as
 * "the bike lost 44 parameters".
 */
export function diffSnapshots(previous: VcuParameterSnapshot, current: VcuParameterSnapshot): VcuParameterChange[] {
  const before = new Map(previous.rows.map(row => [row.index, row]));
  const after = new Map(current.rows.map(row => [row.index, row]));
  const changes: VcuParameterChange[] = [];

  for (const [index, currentRow] of after) {
    const previousRow = before.get(index);
    const identity = { index, name: currentRow.name, micro: currentRow.micro };
    if (!previousRow) {
      changes.push({ ...identity, kind: "appeared" });
      continue;
    }
    if (previousRow.status !== currentRow.status) {
      changes.push({ ...identity, kind: "status-changed", from: previousRow.status, to: currentRow.status });
      continue;
    }
    if (previousRow.rawHex !== null && currentRow.rawHex !== null && previousRow.rawHex !== currentRow.rawHex) {
      changes.push({
        ...identity,
        kind: "value-changed",
        from: previousRow.rawHex,
        to: currentRow.rawHex,
        fromValue: previousRow.value,
        toValue: currentRow.value,
      });
    }
  }
  for (const [index, previousRow] of before) {
    if (!after.has(index)) {
      changes.push({ index, name: previousRow.name, micro: previousRow.micro, kind: "disappeared" });
    }
  }
  return changes.sort((left, right) => left.index - right.index);
}

/** One change as a log line. `value-changed` leads, because it is the only one about the bike. */
export function describeChange(change: VcuParameterChange): string {
  const who = `${change.index} ${change.name ?? "(not in the name table)"} on ${change.micro}`;
  switch (change.kind) {
    case "value-changed":
      return `CHANGED  ${who}: ${change.from} → ${change.to}  (${change.fromValue ?? "?"} → ${change.toValue ?? "?"})`;
    case "status-changed":
      return `read     ${who}: ${change.from} → ${change.to} (about the read, not the parameter)`;
    case "appeared":
      return `new      ${who}: present in this snapshot only`;
    case "disappeared":
      return `missing  ${who}: present in the previous snapshot only`;
  }
}

/** One row as a log line, in the same vocabulary as the page. */
export function describeRow(row: VcuParameterRow): string {
  const name = `${String(row.index).padStart(3)} ${(row.name ?? "?").padEnd(30)}`;
  if (row.status !== "read") {
    return `${name} ${row.status}${row.note ? ` — ${row.note}` : ""}`;
  }
  const value = row.value === null ? `raw ${row.unsigned}` : String(row.value);
  const comparison =
    row.otherBikeValue === null || row.value === null || row.otherBikeValue === row.value
      ? ""
      : `   (the other bike's file says ${row.otherBikeValue})`;
  return `${name} ${String(value).padStart(8)}  [${row.rawHex}]${comparison}${row.note ? ` — ${row.note}` : ""}`;
}

function describeFailure(outcome: VcuReadOutcome): string {
  switch (outcome.status) {
    case "refused":
      return `refused with NRC ${outcome.description}`;
    case "no-response":
      return "no reply in an open session — not the same claim as “no such parameter”";
    case "no-session":
      return outcome.reason;
    case "multi-frame":
      return `reply was a ${outcome.totalLength}-byte multi-frame transfer, which a bank-1 record cannot be`;
    case "unrecognised":
      return outcome.reason;
    case "not-sent":
      return `never asked — ${outcome.reason}`;
    default:
      return outcome.status;
  }
}
