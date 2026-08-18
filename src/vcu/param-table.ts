import {
  KNOWN_TABLE_TYPES,
  contentTwinsOf,
  describeTableType,
  parameterTableFor,
  type VcuParameterTable,
} from "./table-catalog.ts";
import type { VcuMicro, VcuParameter } from "./param-file.ts";

// WHICH of Energica's parameter tables this software is currently reading names out
// of, how a bike changes that, and what a `TABLE_TYPE` reading means.
//
// ./param-file.ts holds `params.ecf`'s text; ./table-catalog.ts holds all 28 tables
// built from it. This module is the one everything else imports, and it answers exactly
// one question the other two cannot: *whose bike is this*.
//
// ── ⚠️ Why there is an ACTIVE table rather than one table ────────────────────
// A parameter is addressed by index, and what an index means comes from the table the
// VCU runs. This repo used to encode one — 16407, the Ribelle it was written for — and
// refuse everything else. That was safe and it was narrow: on another owner's bike every
// name could be wrong, and on the 20 tables where ids 70–94 are `RegenFade_0…24` rather
// than the battery cell block, "wrong" means calling a regen curve `CELL_COUNT`.
//
// So the names are now selected from what the bike reports at 276/277 instead of being
// assumed. Reads name themselves correctly on any of the 28; writes still refuse unless
// the bike named a table this software carries (./table-gate.ts).
//
// ⚠️ THE ACTIVE TABLE IS NOT WHAT MAKES A WRITE SAFE, and must never be relied on for
// that. It is module state, it is set from a snapshot on disk, and it is right only for
// as long as the Pi is bolted to the bike it was last swept on. The write path re-derives
// the bike's table from the raw `TABLE_TYPE` words in the report it is handed, every
// time, and additionally checks that this table encodes the allowlist's five parameters
// the same way that one does — see ./table-gate.ts and ./write-targets.ts. Selection is
// for NAMES; the gate is for BYTES.

/**
 * The table used before any bike has said otherwise: **16407**, the Eva Ribelle this
 * repo was built on and around.
 *
 * ⚠️ A default, not a claim. It is here because a Pi has to name parameters before the
 * first sweep finishes and because one bike's owner should not have to configure
 * anything — not because a bike that has said nothing is presumed to be that one. Every
 * message that shows a name off an unconfirmed table says so, and no write is permitted
 * on the strength of it.
 *
 * 16407 was measured, not chosen: obd-garage/kwp_scan_raw.txt line 233 is
 * `A9 B1 0114 2 4017` — identifier `0x0114` = index 276 `TABLE_TYPE_uC`, a 2-byte record
 * holding `0x4017` = 16407, off that bike's A9 on 2026-06-14.
 */
export const DEFAULT_TABLE_TYPE = 0x4017;

/** Indices 276 `TABLE_TYPE_uC` (A9) and 277 `TABLE_TYPE_uS` (A8) — the two micros' own copies. */
export const TABLE_TYPE_INDICES: readonly number[] = [276, 277];

/** The table names are currently being read out of. Never null: selection either succeeds or leaves this alone. */
export function activeParameterTable(): VcuParameterTable {
  return active;
}

/** Every parameter the active table knows, ascending by index. */
export function parameterTable(): VcuParameter[] {
  return active.parameters;
}

/** The parameter at a given index, or null if the active table does not describe it. */
export function parameterAtIndex(index: number): VcuParameter | null {
  return active.byIndex.get(index) ?? null;
}

/**
 * Every parameter with this name, case-insensitively — an ARRAY because four names are
 * not unique (see ./param-file.ts). Empty when the name is unknown.
 */
export function parametersNamed(name: string): VcuParameter[] {
  return active.byName.get(name.trim().toUpperCase()) ?? [];
}

/** Names that describe more than one index in the active table, so callers can warn about them once. */
export function ambiguousParameterNames(): string[] {
  return [...active.byName.entries()].filter(([, matches]) => matches.length > 1).map(([name]) => name);
}

/** What selecting a table did. Returned as well as logged, so a caller can put it on a page. */
export interface TableSelectionOutcome {
  /** True when the active table is now `tableType`. False leaves the previous one in place. */
  ok: boolean;
  /** What was asked for. */
  tableType: number;
  /** One line, ready to log or render. Never empty. */
  message: string;
}

/**
 * Points the name lookups at the table a bike says it is running.
 *
 * ⚠️ Refuses rather than throws for an unknown table, and leaves the previous table in
 * place. A bike this software does not carry the table for must still be readable — the
 * names will be another table's and every surface says so, and the way OUT of that state
 * is a read. Throwing here would take the service down on the one bike that most needs
 * to be able to report what it saw.
 *
 * ⚠️ It throws for one thing only: a table in the catalogue that does not rebuild to its
 * recorded fingerprint (./table-catalog.ts). That is this repo's own data disagreeing
 * with itself, which is worse than carrying one hardcoded table, and it is not
 * survivable by carrying on with different names.
 *
 * Logs on every change and on every refusal, because this decides what every parameter
 * on the dashboard is called and a silent switch is exactly the kind of thing that is
 * baffling six months later in a garage.
 */
export function selectParameterTable(tableType: number): TableSelectionOutcome {
  if (tableType === active.tableType) {
    return { ok: true, tableType, message: `vcu-table: already using ${describeTableType(tableType)}` };
  }
  const table = parameterTableFor(tableType);
  if (!table) {
    const message =
      `vcu-table: ⚠️  this bike reports ${describeTableType(tableType)}, which this software does not carry — ` +
      `keeping ${describeTableType(active.tableType)}'s names, which may be WRONG for this bike. ` +
      `Add the table with scripts/extract-vcu-tables.ts (README: "Adding your bike's VCU parameter table"). ` +
      `Carried: ${KNOWN_TABLE_TYPES.join(", ")}.`;
    console.warn(message);
    return { ok: false, tableType, message };
  }
  const differing = countDifferences(active, table);
  const previous = active;
  active = table;
  const message =
    `vcu-table: now naming parameters from ${describeTableType(table.tableType)} ` +
    `(Energica bundle ${table.exportStamp}), was ${describeTableType(previous.tableType)} — ` +
    `${differing} of ${table.parameters.length} ids are named differently between the two`;
  console.log(message);
  return { ok: true, tableType, message };
}

/** What a `TABLE_TYPE` reading means for the names this software would show. */
export interface TableTypeVerdict {
  index: number;
  /** 276 is the A9's copy, 277 the A8's. Which one disagrees matters — the two are separate EEPROMs. */
  micro: VcuMicro;
  value: number;
  /**
   * ⚠️ True when this software CARRIES the table the bike named — not when the bike
   * agrees with some table we prefer.
   *
   * That is the whole shift from the version of this file that only ever accepted
   * 16407: a recognised table is a bike we can serve, whichever of the 28 it is.
   */
  recognised: boolean;
  /** One line, ready to log or render. Loud when `recognised` is false. */
  message: string;
}

/**
 * Judges a `TABLE_TYPE` reading: is this a bike whose parameter names this software has?
 *
 * Returns null for any index that is not 276 or 277, so a caller can run it over a whole
 * snapshot without knowing which rows to pick out.
 *
 * ⚠️ An unrecognised table is not cosmetic. Routing (`id → micro`) and record width
 * (`id → datatype`) are invariant across all 28 of Energica's tables, so a wrong table
 * still reads and still writes the right number of bytes to the right micro — it just
 * believes the wrong NAME for them. 151 of 278 ids carry a different name in at least one
 * other table, and on 20 of the 28 ids 70–94 are a regen curve where the other 8 have the
 * battery cell block. There is no NRC, no reply shape and no read-back anywhere that can
 * report that; this function is the only thing that can.
 */
export function checkTableType(index: number, value: number): TableTypeVerdict | null {
  const parameter = parameterAtIndex(index);
  if (!parameter || !TABLE_TYPE_INDICES.includes(index)) {
    return null;
  }
  const identity = `${parameter.name} (${index}, ${parameter.micro})`;
  const table = parameterTableFor(value);
  if (table) {
    const twins = contentTwinsOf(value);
    return {
      index,
      micro: parameter.micro,
      value,
      recognised: true,
      message:
        `${identity} = ${describeTableType(value)} — carried, from Energica bundle ${table.exportStamp}` +
        (twins.length > 0 ? ` (identical content to ${twins.join(", ")})` : "") +
        (value === active.tableType
          ? ""
          : `; names are currently being shown from ${describeTableType(active.tableType)}`),
    };
  }
  return {
    index,
    micro: parameter.micro,
    value,
    recognised: false,
    message:
      `*** ${identity} = ${describeTableType(value)}, which this software does NOT carry. *** Every parameter ` +
      `NAME shown for the ${parameter.micro} is ${describeTableType(active.tableType)}'s and may belong to a ` +
      "different parameter — routing and record widths are the same across all of Energica's tables, so a wrong " +
      "name still reads and still writes cleanly. On 20 of the 28 tables shipped in 2024, ids 70–94 are a regen " +
      "curve rather than the battery cell block, so this is not a small difference. Do not write anything by " +
      "name until the table is added: run scripts/extract-vcu-tables.ts against your own service-tool install (see " +
      `README.md) and send the diff. Carried today: ${KNOWN_TABLE_TYPES.join(", ")}.`,
  };
}

/** How many ids the two tables name differently. The one number that says how much a switch changed. */
function countDifferences(from: VcuParameterTable, to: VcuParameterTable): number {
  let differing = 0;
  for (const parameter of to.parameters) {
    const before = from.byIndex.get(parameter.index);
    if (!before || before.name !== parameter.name || before.signed !== parameter.signed) {
      differing += 1;
    }
  }
  return differing;
}

/**
 * The catalogue's entry for the default, resolved at module load.
 *
 * ⚠️ Throws if it is missing or does not rebuild to its fingerprint — a service whose
 * own name table is inconsistent must refuse to start rather than name 277 parameters
 * out of something nobody checked. That is the same bargain the previous version of
 * this module struck when it threw because `params.ecf` had stopped saying what a
 * hardcoded correction expected; ./table-catalog.ts generalises the check to all 28.
 */
function loadDefaultTable(): VcuParameterTable {
  const table = parameterTableFor(DEFAULT_TABLE_TYPE);
  if (!table) {
    throw new Error(
      `param-table: DEFAULT_TABLE_TYPE is ${describeTableType(DEFAULT_TABLE_TYPE)}, which is not in ` +
        `src/vcu/table-catalog.data.ts (it carries ${KNOWN_TABLE_TYPES.join(", ")}). One of the two is wrong, and ` +
        "naming parameters out of whichever table happened to be first is not an option"
    );
  }
  return table;
}

let active: VcuParameterTable = loadDefaultTable();

export {
  CALIBRATION_BANK,
  PARAMETER_FILE_TEXT,
  parseParameterFile,
  recordLengthFor,
  type ParameterStorageType,
  type VcuMicro,
  type VcuParameter,
} from "./param-file.ts";
export {
  BASE_TABLE_TYPE,
  KNOWN_TABLE_TYPES,
  contentTwinsOf,
  decodeTableType,
  describeCatalogue,
  describeTableType,
  parameterTableFor,
  type VcuParameterTable,
  type VcuTableType,
} from "./table-catalog.ts";
