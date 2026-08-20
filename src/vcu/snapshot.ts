import { interpretRecord } from "./param-codec.ts";
import {
  TABLE_TYPE_INDICES,
  activeParameterTable,
  checkTableType,
  contentTwinsOf,
  describeTableType,
  parameterAtIndex,
  parameterTableFor,
  recordLengthFor,
  type ParameterStorageType,
  type TableTypeVerdict,
  type VcuMicro,
  type VcuParameter,
  type VcuParameterTable,
} from "./param-table.ts";
import type { VcuReadOutcome } from "./kwp-client.ts";

// What a parameter read looks like once it has been written down: one flat row per
// parameter, a snapshot of many of them, and the diff between two snapshots.
//
// Pure — no I/O, no clock beyond the caller-supplied timestamp. Which is the point: the
// diff is the part that decides whether the bike has been reconfigured, and it can be
// exercised against two files on a laptop.
//
// These are configuration, not telemetry: they do not move while riding, so they are a
// snapshot and a diff rather than 277 time series or 277 more keys in `liveState`. What is
// worth knowing is that one of them CHANGED, because that means something reconfigured the
// bike. The storage arithmetic behind that: docs/vcu-parameters.md §14.

/** One parameter, as read (or as failed to be read). Flat on purpose: this is a wire and file shape. */
export interface VcuParameterRow {
  index: number;
  /** `0x1000 | index`. */
  identifier: number;
  micro: VcuMicro;
  /**
   * From the table this bike named, or null.
   *
   * ⚠️ Null is NOT an error. It means an index that table does not describe, a bike with
   * more parameters than any table here knows, or — the case that matters — the owning
   * micro named a table this software does not carry, so nothing can say what this index is
   * called. retableSnapshot() strips the name rather than borrowing the other micro's, and
   * `note` says so. The three cases in full: docs/vcu-parameters.md §3.
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

/** What a snapshot says about which of Energica's parameter tables this bike runs. */
export interface TableTypeReport {
  /**
   * One per `TABLE_TYPE` index that yielded a usable typed value. NOT one per index
   * that was read — see `unusable`, where a row answered and still named no table.
   */
  verdicts: TableTypeVerdict[];
  /**
   * ⚠️ True only when BOTH micros answered usably, both named a table this software
   * carries, and the two name the same table.
   *
   * One micro answering is not confirmation of the other: they hold separate EEPROMs,
   * are asked separately, and can genuinely disagree. `unread`, `unusable` and `split`
   * say which are missing and why.
   */
  confirmed: boolean;
  /**
   * The table this snapshot's readings agree on, or null when they do not name exactly
   * one that this software carries.
   *
   * ⚠️ This is what NAMES are taken from, and it is deliberately looser than
   * `confirmed`: one micro naming a carried table is enough to name parameters far
   * better than a default would, while still being nowhere near enough to permit a
   * write. ./table-gate.ts applies the strict rule to writes.
   *
   * Two `TABLE_TYPE`s whose 277 rows are byte-identical (4119 and 16407, for instance)
   * count as agreeing — they are the same table under two vehicle-line tags, and
   * calling that a disagreement would block a bike for a difference in a nibble nothing
   * reads.
   */
  tableType: number | null;
  /**
   * ⚠️ True when the two micros named tables with DIFFERENT contents.
   *
   * A finding, not something to average or to resolve by preferring one. The micros hold
   * separate EEPROMs and can have been flashed at different times; if they disagree, some
   * ids are one table's and some are the other's, and no single set of names is right for
   * the whole bike.
   */
  split: boolean;
  /** Indices in TABLE_TYPE_INDICES that this snapshot has no reading for at all. */
  unread: number[];
  /**
   * ⚠️ Indices that DID answer, with a record whose length contradicts the table — so
   * they named no table, and the reply itself is the finding. `TABLE_TYPE` is a plain
   * 2-byte WORD on both micros; a reply of any other length means the record framing
   * is off, which puts every other typed value on the same sweep in question too.
   * Kept apart from `unread` because telling someone to go and read a parameter that
   * already replied sends them after the wrong fault.
   */
  unusable: number[];
  /**
   * ⚠️ True when a micro named a table this software does not CARRY. Its parameter
   * NAMES are then not to be trusted, and nothing should be written by name.
   *
   * Note what this no longer means: it is not "the bike is not the one this repo was
   * written for". All 28 tables Energica ships in the 2024 build are carried, so a bike
   * reaching this state is one whose table nobody has extracted yet — and
   * scripts/extract-vcu-tables.ts is how it stops being true.
   */
  mismatched: boolean;
  /** Ready to log or render, worst first. Never empty — "not read" is itself a finding. */
  lines: string[];
}

/**
 * Reads a snapshot's own answer to "which parameter table is this bike running".
 *
 * Every sweep reads its own table type back out and says whether the names it just printed
 * describe the bike that answered — the check that stops the 2026-08-16 correction from
 * being a one-off, when the embedded table was 16406 for a week while the bike had been
 * reporting 16407 in an already-taken dump that nobody had looked at.
 *
 * ⚠️ The two micros are asked SEPARATELY and can disagree: 276 `TABLE_TYPE_uC` is the A9's,
 * 277 `TABLE_TYPE_uS` is the A8's, and they sit in separate EEPROMs. A per-micro verdict is
 * what makes "they disagree" expressible at all, and `split` is what stops a disagreement
 * being averaged away. Which of the two this bike has actually answered:
 * docs/vcu-parameters.md §3.
 */
export function reportTableType(snapshot: VcuParameterSnapshot): TableTypeReport {
  const readRows = new Map(snapshot.rows.filter(row => row.status === "read").map(row => [row.index, row]));
  const verdicts: TableTypeVerdict[] = [];
  const unread: number[] = [];
  const unusable: [index: number, row: VcuParameterRow][] = [];
  for (const index of TABLE_TYPE_INDICES) {
    const row = readRows.get(index);
    // `value` only, never falling back to `unsigned`. For these two indices `value` is
    // null in exactly one case — the reply's width contradicted the table — and that is
    // precisely where the raw bytes must NOT be compared: a 1-byte reply read as a
    // number would name some other table and be reported as a mismatch, when what
    // actually happened is that the record was malformed.
    const verdict = row?.value == null ? null : checkTableType(index, row.value);
    if (verdict) {
      verdicts.push(verdict);
    } else if (row) {
      unusable.push([index, row]);
    } else {
      unread.push(index);
    }
  }
  const mismatched = verdicts.some(verdict => !verdict.recognised);
  const agreed = agreedTableType(verdicts);
  const split = agreed === null && verdicts.filter(verdict => verdict.recognised).length > 1;
  // Worst first: micros that named different tables, then one that named a table we do
  // not carry, then one whose reply was malformed, then one nobody asked, then the ones
  // that agree. The malformed reply outranks the unasked micro deliberately — "the
  // record framing is off" is a bigger problem than "this parameter has not been read",
  // and it questions the whole sweep.
  const lines = [
    ...(split ? [`🚨  ${describeSplit(verdicts)}`] : []),
    ...verdicts.filter(verdict => !verdict.recognised).map(verdict => `🚨  ${verdict.message}`),
    ...unusable.map(([index, row]) => `🚨  ${describeUnusableTableType(index, row)}`),
    ...unread.map(index => `⚠️  ${describeUnreadTableType(index)}`),
    ...verdicts.filter(verdict => verdict.recognised).map(verdict => `✅  ${verdict.message}`),
  ];
  return {
    verdicts,
    confirmed: unread.length === 0 && unusable.length === 0 && !mismatched && !split,
    tableType: agreed,
    split,
    unread,
    unusable: unusable.map(([index]) => index),
    mismatched,
    lines,
  };
}

/**
 * The one table every recognised reading in a report points at, or null.
 *
 * ⚠️ "The same table" means the same CONTENT, not the same number. 4119 and 16407 are
 * byte-identical 277-row tables under two vehicle-line tags; a bike whose A9 says one and
 * whose A8 says the other is not split in any way that could give a parameter the wrong
 * name, and blocking it would be a refusal over a nibble nothing reads.
 *
 * The A9's copy (276) wins when both are present and content-identical, so the number
 * reported is the control micro's own word rather than whichever happened to sort first.
 */
function agreedTableType(verdicts: TableTypeVerdict[]): number | null {
  // ⚠️ A micro that named a table we do not carry VETOES the answer, rather than being
  // filtered out and letting the other micro speak for the whole VCU. It has told us it
  // is running something else; naming its 44 parameters out of the table it just denied
  // would be exactly the confident-wrong-label this module exists to prevent. What
  // happens to those rows instead is retableSnapshot()'s per-micro rule.
  if (verdicts.some(verdict => !verdict.recognised)) {
    return null;
  }
  const recognised = verdicts.filter(verdict => verdict.recognised);
  if (recognised.length === 0) {
    return null;
  }
  const [first, ...rest] = recognised;
  const identical = rest.every(
    verdict => verdict.value === first.value || contentTwinsOf(first.value).includes(verdict.value)
  );
  if (!identical) {
    return null;
  }
  return recognised.find(verdict => verdict.index === 276)?.value ?? first.value;
}

/**
 * ⚠️ The line for two micros that named genuinely different tables.
 *
 * Spelled out rather than reduced to "mismatch" because the remedy depends on HOW they
 * differ, and because the honest answer may be that the bike really is like that: the two
 * micros hold separate EEPROMs and can have been flashed at different times. What must not
 * happen is picking one — half the ids would then be named out of the wrong table with
 * nothing to show for it.
 */
function describeSplit(verdicts: TableTypeVerdict[]): string {
  const named = verdicts
    .filter(verdict => verdict.recognised)
    .map(verdict => `the ${verdict.micro} says ${describeTableType(verdict.value)}`)
    .join(" and ");
  return (
    `*** The two micros name DIFFERENT parameter tables: ${named}. *** They hold separate EEPROMs and are asked ` +
    "separately, so this can be true of the bike rather than a fault — but no single set of names is then right " +
    "for the whole VCU, and this software does not carry a per-micro table. Reading is unaffected; writing is " +
    "refused until they agree or until src/vcu/param-table.ts learns to hold one table per micro."
  );
}

/**
 * One line for a micro that answered with a record the table's width column forbids.
 *
 * It is NOT "was not read": the parameter replied, and telling someone to go and read
 * it again sends them after the wrong fault. What is wrong is the reply. `TABLE_TYPE`
 * is a 2-byte WORD on both micros, so any other length means the record framing or the
 * KWP layer is off — which makes every other typed value on the same sweep suspect,
 * not just this one. That is why it is filed with the mismatches rather than with the
 * unasked micros.
 */
function describeUnusableTableType(index: number, row: VcuParameterRow): string {
  const parameter = parameterAtIndex(index);
  const identity = parameter ? `${parameter.name} (${index}, ${parameter.micro})` : `parameter ${index}`;
  const expected = parameter ? `${recordLengthFor(parameter.type)}-byte ${parameter.type}` : "2-byte WORD";
  const got = row.rawHex === null ? "nothing" : `[${row.rawHex}]`;
  return (
    `*** ${identity} answered ${got}, which the name table says should be a ${expected}. *** It has named no ` +
    "table, and a wrong-width record here puts the framing of every other value in this sweep in question."
  );
}

/**
 * One line for a micro that did not name its table.
 *
 * Not silence, and not folded into "the other micro said 16407 so we are fine". On the
 * bike this repo runs on this is the line 277 produces on every sweep, and it is the
 * honest state: the A8 owns id 249, id 249 is the only id where 16406 and 16407 disagree,
 * and the A8 has never been asked. A green report that omitted it would be the feature
 * failing in exactly the case it was built for.
 */
function describeUnreadTableType(index: number): string {
  const parameter = parameterAtIndex(index);
  const identity = parameter ? `${parameter.name} (${index}, ${parameter.micro})` : `parameter ${index}`;
  const owner = parameter ? `the ${parameter.micro}'s` : "this micro's";
  return (
    `${identity} was not read, so nothing confirms ${owner} names are ` +
    `${describeTableType(activeParameterTable().tableType)}'s, which is what is being shown. Reading it costs one ` +
    "frame in a 10 81 session."
  );
}

/**
 * Re-derives every row's name, section, width, sign and value from the table the snapshot itself named.
 *
 * ⚠️ This is what makes a sweep of somebody else's bike come out right. A row is named when
 * it arrives, from whatever table was active then — a default on a first sweep. Without it
 * the first snapshot off a `RegenFade` bike would be stored, served, exported and diffed
 * with ids 70–94 labelled `CELL_COUNT` and `CELL_OVERVOLTAGE`.
 *
 * ⚠️ PER MICRO, because the two answer separately and can disagree; a micro naming a table
 * we do NOT carry loses its rows' names rather than borrowing the other's. All three cases:
 * docs/vcu-parameters.md §3.
 *
 * ⚠️ The typed `value` is recomputed from `rawHex`: signedness varies at 30 ids, so the same
 * two bytes are −350 under one table and 65186 under another.
 */
export function retableSnapshot(snapshot: VcuParameterSnapshot, report: TableTypeReport): VcuParameterSnapshot {
  const byMicro = new Map<VcuMicro, VcuParameterTable | null>();
  for (const verdict of report.verdicts) {
    byMicro.set(verdict.micro, verdict.recognised ? parameterTableFor(verdict.value) : null);
  }
  const agreed = report.tableType === null ? null : parameterTableFor(report.tableType);
  // agreedTableType() is null for an empty verdict list, so `agreed` cannot be set here.
  if (byMicro.size === 0) {
    return snapshot;
  }
  return {
    ...snapshot,
    rows: snapshot.rows.map(row => {
      const table = byMicro.has(row.micro) ? (byMicro.get(row.micro) ?? null) : agreed;
      const contradicted = byMicro.get(row.micro) === null && !TABLE_TYPE_INDICES.includes(row.index);
      if (table === null && !contradicted) {
        // ⚠️ 276/277 land here for a contradicted micro, and that is the point: they are
        // `TABLE_TYPE_uC`/`_uS`, WORD U, on the same micro in ALL 28 tables
        // (scripts/check-vcu-params.ts §1e asserts it), which is the invariance the whole
        // selection mechanism rests on — you can ask a bike which table it runs without
        // knowing the answer first, and that is exactly as true of a 29th table nobody
        // has extracted. Stripping them would erase the reading that IS the
        // contradiction: a stored snapshot whose 277 has no `value` comes back from disk
        // as "answered with a malformed record", so `mismatched` would flip to false one
        // restart later and the other micro's table would quietly become the whole VCU's.
        // Measured before it was fixed, not imagined.
        return row;
      }
      return retableRow(row, table?.byIndex.get(row.index) ?? null, contradicted ? row.micro : null);
    }),
  };
}

function retableRow(
  row: VcuParameterRow,
  parameter: VcuParameter | null,
  contradictedBy: VcuMicro | null
): VcuParameterRow {
  const unnameable = contradictedBy
    ? `the ${contradictedBy} named a parameter table this software does not carry, so nothing here can say what ` +
      "this index is called — the raw bytes are the bike's, the name is not available"
    : null;
  const renamed = {
    ...row,
    name: parameter?.name ?? null,
    section: parameter?.section ?? null,
    type: parameter?.type ?? null,
    signed: parameter?.signed ?? null,
    otherBikeValue: parameter?.otherBikeValue ?? null,
  };
  if (row.rawHex === null) {
    // A row that never carried bytes: the NRC, the timeout or the refusal in `note` is
    // the only thing it has, and it is not this function's to overwrite. Both facts fit.
    return { ...renamed, note: note(row.note, unnameable) };
  }
  const record = bytesFromHex(row.rawHex);
  if (record === null) {
    // ⚠️ The stored hex is not hex, so nothing here may re-type it — and it must not keep
    // the OLD table's number under the NEW table's name either, which is the same
    // "value the name's own S/U column contradicts" this function exists to avoid.
    // The name is still re-derived, because that comes from the bike's own table and is
    // right; the reading is withheld, the way interpretRecord() withholds one whose
    // width contradicts the table.
    return {
      ...renamed,
      unsigned: null,
      value: null,
      widthMismatch: false,
      note: note(row.note, unnameable, `stored record “${row.rawHex}” is not hex, so it could not be re-typed`),
    };
  }
  const interpreted = interpretRecord(record, parameter);
  return {
    ...renamed,
    unsigned: interpreted.unsigned,
    value: interpreted.value,
    widthMismatch: interpreted.widthMismatch,
    note: note(
      interpreted.widthMismatch
        ? `record is ${record.length} byte(s); the name table says ${parameter?.type} — value withheld, raw kept`
        : null,
      unnameable
    ),
  };
}

/**
 * Joins whatever a row has to say about itself, or null when it has nothing.
 *
 * ⚠️ Concatenates rather than picking. `note` is the only place a failed row's NRC lives
 * — `describeRow` and the page both print it and nothing else — so an earlier version of
 * this that wrote the "no name available" sentence OVER it lost the reason a parameter
 * had not been read, on exactly the rows a person would be investigating.
 */
function note(...parts: (string | null)[]): string | null {
  const said = parts.filter(part => part !== null && part.length > 0);
  return said.length === 0 ? null : said.join(" — ");
}

/**
 * `"00 4B"` back to bytes, or null when it is not that.
 *
 * ⚠️ Not coerced. `Number.parseInt("ZZ", 16)` is NaN and `Uint8Array.from` would turn
 * that into a confident `0x00` — a row that then comes back with a typed value, no width
 * mismatch and no note, as if the bike had sent a zero. This function is now run over
 * `latest.json` files this build never wrote (src/http/vcu-params.ts re-tables on every
 * serve, deliberately, for files from older builds), so "the stored hex is not hex" is a
 * reachable state, and it is a damaged file rather than a reading. Everything else here
 * refuses rather than substitutes when a reading is not honest — `interpretRecord`
 * withholds `value` on a width mismatch, ./param-file.ts's parser throws on a line it does
 * not fully understand — and this follows them.
 */
function bytesFromHex(rawHex: string): Uint8Array | null {
  const parts = rawHex.split(/\s+/).filter(part => part.length > 0);
  if (!parts.every(part => /^[0-9a-fA-F]{1,2}$/.test(part))) {
    console.warn(`vcu-snapshot: “${rawHex}” is not a hex record, so that row is served with no typed value`);
    return null;
  }
  return Uint8Array.from(parts, byte => Number.parseInt(byte, 16));
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
