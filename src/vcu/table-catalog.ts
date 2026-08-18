import {
  CALIBRATION_BANK,
  PARAMETER_FILE_TEXT,
  parseParameterFile,
  type ParameterStorageType,
  type VcuMicro,
  type VcuParameter,
} from "./param-file.ts";
import { PARAMETER_TABLE_DELTAS } from "./table-catalog.data.ts";

// EVERY parameter table Energica ships, keyed by the number the VCU reports for itself.
// Pure data plus a rebuilder; nothing here touches a bus and nothing here decides which
// table a given bike is on — that is ./param-table.ts.
//
// ── ⚠️ Why a repo that runs on one motorcycle carries 28 name tables ─────────
// A VCU calibration parameter is addressed BY INDEX. What index 258 IS depends on which
// table the VCU runs, and Energica has shipped many: the 2024 service-tool build selects 28,
// and `id → name` differs at 151 of 278 ids somewhere among them. Routing (`id → micro`)
// and record width (`id → datatype`) are IDENTICAL in all 28 — measured, PARAM_TABLES.md
// §2 — which is precisely what makes the wrong table dangerous instead of obvious: a
// write under a wrong name goes to the right micro with the right number of bytes, gets
// a positive response, and reads back exactly as sent.
//
// The worst instance is not hypothetical and is the reason this file exists. On 20 of
// the 28 tables, ids 70–94 are `RegenFade_0` … `RegenFade_24`, a regen-shaping curve. On
// the other 8 the same ids are the BATTERY CELL BLOCK — `CELL_COUNT`, `CELL_OVERVOLTAGE`,
// `CELL_TARGET_AC`, `CELLV_KA`. Another owner's tool has a live bug of exactly that
// shape: it writes a regen curve into the cell configuration. Carrying one hardcoded
// table and hoping is how you ship that bug; carrying all of them and refusing when the
// bike names one we do not have is how you do not. See ./table-gate.ts.
//
// ── How they are stored: deltas against params.ecf ───────────────────────────
// ./table-catalog.data.ts holds one entry per TABLE_TYPE, each a list of the ids whose
// NAME or S/U column differs from ./param-file.ts's `params.ecf` text (which is itself
// table 16406). ~32 KB for all 28, against ~1.1 MB for 28 standalone JSON tables — this
// runs on a Pi Zero, and 27 of those copies would be re-saying the same 277 rows.
//
// It is also the more reviewable artefact. A contributed table's diff is exactly the
// list of ids it renames, which is the thing a reviewer needs to look at.
//
// ── Measured, 2026-08-18 (laptop; a Pi Zero 2 W is several times slower) ─────
//   46 KB of source for all 28 tables, ~1.1 MB if they were standalone JSON
//   6.5 ms   importing ./param-table.ts: parse params.ecf, build the default table, fingerprint it
//   0.26 ms  building one further table on demand
//   3.8 ms   building all 28, for +1.87 MiB of heap
// So they are built LAZILY: a Pi bolted to one motorcycle builds one table and keeps
// ~1.9 MiB it would otherwise spend saying the same 277 rows 27 more times. Verifying
// all 28 belongs in scripts/check-vcu-params.ts §1e, which runs in CI on every change
// to this data and is where a corrupt delta gets caught before it reaches a garage.
//
// ── ⚠️ The self-check: a fingerprint per table, taken from Energica's bundle ─
// A delta is only as good as the base it was computed against, and the base is a text
// file one owner copied off one bike. If that text is ever re-copied, re-ordered or
// edited, all 28 reconstructions move together and nothing about them looks wrong.
//
// So each entry carries a fingerprint of the WHOLE table, computed by
// scripts/extract-vcu-tables.ts from the bundle's own records before any delta
// arithmetic, and buildTable() recomputes it from the reconstruction and throws if they
// disagree. That is the generalisation of the check this module replaced, which threw at
// module load when `params.ecf` stopped saying what a hardcoded one-id correction
// expected. 16406's own entry has an empty delta, so its fingerprint check is a load-time
// proof that the embedded text really is table 16406 — a claim that used to live only in
// a comment.
//
// ⚠️ A fingerprint proves the delta rebuilds the bundle it was taken from. It cannot
// prove the bundle was labelled correctly in the first place; that comes from the
// resource NAME inside the service-tool executable, which is the one thing binding a
// table to a TABLE_TYPE. scripts/extract-vcu-tables.ts explains why a byte-scan loses it.
//
// ── ⚠️ What is NOT in Energica's bundles ─────────────────────────────────────
// No values (`vehicleValue` is null in all 28) and no `[SECTION]` grouping. Both come
// from `params.ecf` and therefore describe a 16406 bike. dropWhereRenamed() below is the
// rule that keeps that honest.

/** One table as ./table-catalog.data.ts stores it. Written by scripts/extract-vcu-tables.ts, not by hand. */
export interface ParameterTableDelta {
  /**
   * The number the VCU reports at parameters 276/277, and the `_<TABLE_TYPE>` resource
   * name inside the service-tool executable.
   */
  tableType: number;
  /** Energica's `yyyyMMddHHmm` export stamp for the bundle. Provenance, and how two builds' copies are compared. */
  exportStamp: string;
  /** FNV-1a over the bundle's own rows — see fingerprintTable() and the header. */
  fingerprint: string;
  /** The rows that differ from `params.ecf`, in the line format ./table-catalog.data.ts documents. Empty string ⇒ identical. */
  delta: string;
}

/** A whole parameter table, rebuilt and checked, with the lookups callers need. */
export interface VcuParameterTable {
  tableType: number;
  exportStamp: string;
  fingerprint: string;
  /** Every parameter, ascending by index. */
  parameters: VcuParameter[];
  byIndex: Map<number, VcuParameter>;
  /** Upper-cased name → every parameter with it. An ARRAY because four names are not unique — see ./param-file.ts. */
  byName: Map<string, VcuParameter[]>;
}

/**
 * `params.ecf`'s own table. Every delta in the catalogue is expressed against it, and
 * its entry in the catalogue has an empty delta.
 */
export const BASE_TABLE_TYPE = 16406;

/** Every `TABLE_TYPE` this software can describe a bike with, ascending. 28 in the 2024 service-tool build. */
export const KNOWN_TABLE_TYPES: readonly number[] = PARAMETER_TABLE_DELTAS.map(delta => delta.tableType).sort(
  (left, right) => left - right
);

/**
 * The table a VCU reporting `tableType` is running, or **null when this software does
 * not carry it**.
 *
 * ⚠️ Null is the important case and must never be softened into "here is our best
 * guess". A bike on a table we do not have is a bike whose parameter names we do not
 * know, and ./table-gate.ts turns that null into a refusal to write plus an instruction
 * for adding the table. Returning the default table instead would produce a plausible,
 * confident, wrong set of names — which on a `RegenFade` bike means calling id 70
 * `CELL_COUNT`.
 *
 * Built on first use and cached, so a Pi that only ever sees one bike only ever pays for
 * one table. Throws if the rebuild does not match the recorded fingerprint: that is a
 * fault in this repo's own data, and a name table that disagrees with itself is worse
 * than one that is merely narrow.
 */
export function parameterTableFor(tableType: number): VcuParameterTable | null {
  const cached = builtTables.get(tableType);
  if (cached) {
    return cached;
  }
  const delta = PARAMETER_TABLE_DELTAS.find(candidate => candidate.tableType === tableType);
  if (!delta) {
    return null;
  }
  const table = buildParameterTable(delta);
  builtTables.set(tableType, table);
  return table;
}

/**
 * `TABLE_TYPE` decomposed. Energica packs it as `(family << 12) | revision`.
 *
 * Families 1, 2, 3, 4, 5, 6 and 15 all exist and the nibble is a vehicle-line tag, not a
 * version: the same revision in two families is often byte-identical content (4119 and
 * 16407, for instance). Nothing here routes on the family — see contentTwinsOf().
 */
export interface VcuTableType {
  /** The raw 16-bit word, e.g. 16407. */
  raw: number;
  family: number;
  /** The low 12 bits. Revisions `0x005`…`0x017` exist. */
  revision: number;
}

/** Splits a raw `TABLE_TYPE` word into its family and revision halves. */
export function decodeTableType(raw: number): VcuTableType {
  return { raw, family: (raw >> 12) & 0xf, revision: raw & 0xfff };
}

/** `16407 (0x4017 — family 4, revision 0x017)`. The form every message in this repo uses. */
export function describeTableType(raw: number): string {
  const decoded = decodeTableType(raw);
  const hex = `0x${raw.toString(16).toUpperCase().padStart(4, "0")}`;
  return `${raw} (${hex} — family ${decoded.family}, revision 0x${decoded.revision.toString(16).toUpperCase().padStart(3, "0")})`;
}

/**
 * Other `TABLE_TYPE`s whose 277 rows are identical to this one's, ascending.
 *
 * ⚠️ Derived from the fingerprints rather than listed. The previous version of this
 * module hardcoded one twin pair (16407 ⇄ 4119) as a constant, which was true and would
 * have silently stopped being the whole truth the moment a 29th table arrived. Seven
 * such groups exist across the 28.
 *
 * Useful for saying "your bike is on 4119, which is the same table as 16407" rather than
 * making that sound like a different bike — but NOT used to decide anything, because
 * nothing needs it to: a twin is carried in the catalogue under its own number and
 * resolves on its own.
 */
export function contentTwinsOf(tableType: number): number[] {
  const self = PARAMETER_TABLE_DELTAS.find(candidate => candidate.tableType === tableType);
  if (!self) {
    return [];
  }
  return PARAMETER_TABLE_DELTAS.filter(
    candidate => candidate.fingerprint === self.fingerprint && candidate.tableType !== tableType
  )
    .map(candidate => candidate.tableType)
    .sort((left, right) => left - right);
}

/** The rows a fingerprint is taken over. Loose enough for a raw bundle record and for a built VcuParameter. */
export interface FingerprintableRow {
  index: number;
  name: string;
  type: string;
  signed: boolean;
  micro: string;
}

/**
 * A table's identity as eight hex digits: FNV-1a 32-bit over every row's index, name,
 * width, signedness and micro, in index order.
 *
 * ⚠️ Not a security hash and not trying to be — nothing here is defending against a
 * chosen-collision attack, and a 32-bit digest over 28 tables is nowhere near a birthday
 * problem. What it has to catch is a delta that no longer rebuilds its bundle: a stale
 * base, a hand-edit, a dropped row, a transposed name. Every one of those changes the
 * digest.
 *
 * Deliberately covers exactly the five fields that make a table a table. `section` and
 * `otherBikeValue` are `params.ecf`'s and are not in a bundle at all, so including them
 * would make the fingerprint uncomparable with the one the extractor takes.
 */
export function fingerprintTable(rows: FingerprintableRow[]): string {
  let hash = 0x811c9dc5;
  for (const row of [...rows].sort((left, right) => left.index - right.index)) {
    const line = `${row.index}\t${row.name}\t${row.type}\t${row.signed ? "S" : "U"}\t${row.micro}\n`;
    for (let position = 0; position < line.length; position += 1) {
      hash ^= line.charCodeAt(position);
      // FNV-1a's 16777619 multiply, kept in 32 bits without BigInt: Math.imul is the
      // only multiplication in JavaScript that does not lose the low bits to a double.
      hash = Math.imul(hash, 0x01000193);
    }
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** One line per table, for a startup log or a check script. Ascending, twins noted. */
export function describeCatalogue(): string[] {
  return [...PARAMETER_TABLE_DELTAS]
    .sort((left, right) => left.tableType - right.tableType)
    .map(delta => {
      const twins = contentTwinsOf(delta.tableType);
      const differing = deltaLines(delta.delta).length;
      return (
        `${String(delta.tableType).padStart(5)}  export=${delta.exportStamp}  ${String(differing).padStart(3)} row(s) ` +
        `differ from params.ecf${twins.length > 0 ? `  (identical to ${twins.join(", ")})` : ""}`
      );
    });
}

const builtTables = new Map<number, VcuParameterTable>();

/** Parsed once. Every table in the catalogue is this plus a delta. */
let baseParameters: VcuParameter[] | null = null;

function baseTable(): VcuParameter[] {
  baseParameters ??= parseParameterFile(PARAMETER_FILE_TEXT());
  return baseParameters;
}

/**
 * Rebuilds one table from `params.ecf` plus its delta, and refuses to hand back
 * something that does not match the fingerprint Energica's own bundle produced.
 *
 * Exported for scripts/extract-vcu-tables.ts, which round-trips every delta through this
 * before writing the file — so a contributor whose extraction does not rebuild finds out
 * from the script rather than from `npm test` one command later. Nothing in the service
 * calls it directly; parameterTableFor() is the memoised way in.
 */
export function buildParameterTable(delta: ParameterTableDelta): VcuParameterTable {
  const byIndex = new Map(baseTable().map(parameter => [parameter.index, { ...parameter }]));
  for (const [lineNumber, line] of deltaLines(delta.delta).entries()) {
    applyDeltaLine(delta, line, lineNumber + 1, byIndex);
  }
  const parameters = [...byIndex.values()].sort((left, right) => left.index - right.index);
  const rebuilt = fingerprintTable(parameters);
  if (rebuilt !== delta.fingerprint) {
    // Loud, and at the moment of use rather than deferred to whatever reads a name
    // next. The remedy is named because it is a real one: the extractor rewrites the
    // whole file from the exe, so nobody has to work out which line drifted.
    throw new Error(
      `table-catalog: rebuilding table ${delta.tableType} from params.ecf plus its delta gives fingerprint ` +
        `${rebuilt}, but src/vcu/table-catalog.data.ts records ${delta.fingerprint} for it. The delta and the ` +
        "params.ecf text in src/vcu/param-file.ts no longer agree, so every NAME this table would give is a " +
        "guess. Regenerate with `node --experimental-strip-types scripts/extract-vcu-tables.ts <service-tool.exe>`."
    );
  }
  return {
    tableType: delta.tableType,
    exportStamp: delta.exportStamp,
    fingerprint: delta.fingerprint,
    parameters,
    byIndex,
    byName: groupByName(parameters),
  };
}

function deltaLines(delta: string): string[] {
  return delta
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.length > 0);
}

/**
 * Applies one delta line. Strict, and throws naming the table and the line — the same
 * bargain ./param-file.ts's parser makes, for the same reason: a line this file does not
 * fully understand must not become a row that is quietly missing or quietly wrong.
 */
function applyDeltaLine(
  delta: ParameterTableDelta,
  line: string,
  lineNumber: number,
  byIndex: Map<number, VcuParameter>
): void {
  const columns = line.split(/\s+/);
  const fail = (why: string): never => {
    throw new Error(`table-catalog: table ${delta.tableType} delta line ${lineNumber} (“${line}”) ${why}`);
  };
  if (columns[0] === "-") {
    const index = Number(columns[1]);
    if (columns.length !== 2 || !byIndex.delete(index)) {
      fail("removes an index params.ecf does not have, or is not exactly `- <index>`");
    }
    return;
  }
  if (columns[0] === "+") {
    if (columns.length !== 6) {
      fail("adds a row but is not `+ <index> <NAME> <TYPE> <S|U> <MICRO>`");
    }
    const [, indexText, name, type, sign, micro] = columns;
    const index = Number(indexText);
    if (!Number.isInteger(index) || index < 1) {
      fail("adds a row with a non-index");
    }
    if (byIndex.has(index)) {
      fail("adds an index params.ecf already has — a rename is written without the `+`");
    }
    byIndex.set(index, {
      index,
      identifier: (CALIBRATION_BANK << 12) | index,
      name,
      type: assertStorageType(type, fail),
      signed: assertSign(sign, fail),
      micro: assertMicro(micro, fail),
      // ⚠️ Both null, always: `params.ecf` has no row here at all, so it has neither a
      // section nor a value to lend. 61451/61452's id 300 `MOTORING_MAP` is the only
      // instance across the 28.
      section: null,
      otherBikeValue: null,
    });
    return;
  }
  if (columns.length !== 2 && columns.length !== 3) {
    fail("is neither `<index> <NAME>` nor `<index> <NAME> <S|U>`");
  }
  const index = Number(columns[0]);
  const existing = byIndex.get(index);
  if (!existing) {
    fail("renames an index params.ecf does not have — an added row needs the `+` form");
    return;
  }
  byIndex.set(index, {
    ...dropWhereRenamed(existing, columns[1]),
    name: columns[1],
    signed: columns.length === 3 ? assertSign(columns[2], fail) : existing.signed,
  });
}

/**
 * ⚠️ `params.ecf`'s `[SECTION]` heading and its bike's value describe THE PARAMETER IT
 * NAMED. When another table calls the same id something else, they are facts about a
 * parameter that is not there, and carrying them across is how a page ends up showing
 * "RegenFade_0 · RESS · the other bike says 80" — three fields, one of them the name of
 * a battery configuration parameter that this bike does not have at that id.
 *
 * So they travel exactly as far as the name does. That is the "degrade gracefully"
 * half of keeping `params.ecf`'s presentation data: a bike on 16406 or 16407 keeps all
 * 277 sections, a bike on a `RegenFade` table keeps the ~177 that still mean what they
 * said, and nobody gets a confident wrong label.
 */
function dropWhereRenamed(parameter: VcuParameter, name: string): VcuParameter {
  if (parameter.name === name) {
    return parameter;
  }
  return { ...parameter, section: null, otherBikeValue: null };
}

function assertStorageType(value: string, fail: (why: string) => never): ParameterStorageType {
  if (value !== "BYTE" && value !== "WORD" && value !== "BOOL") {
    fail(`has an unknown storage type ${value}`);
  }
  return value as ParameterStorageType;
}

function assertSign(value: string, fail: (why: string) => never): boolean {
  if (value !== "S" && value !== "U") {
    fail(`has an unknown sign column ${value}`);
  }
  return value === "S";
}

function assertMicro(value: string, fail: (why: string) => never): VcuMicro {
  if (value !== "A8" && value !== "A9") {
    fail(`names an unknown micro ${value}`);
  }
  return value as VcuMicro;
}

function groupByName(parameters: VcuParameter[]): Map<string, VcuParameter[]> {
  const grouped = new Map<string, VcuParameter[]>();
  for (const parameter of parameters) {
    const key = parameter.name.toUpperCase();
    const existing = grouped.get(key);
    if (existing) {
      existing.push(parameter);
    } else {
      grouped.set(key, [parameter]);
    }
  }
  return grouped;
}
