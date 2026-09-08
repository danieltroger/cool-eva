import type { VcuParameter } from "../src/vcu/param-file.ts";
import { fingerprintTable, type ParameterTableDelta } from "../src/vcu/table-catalog.ts";

// The delta arithmetic shared by every way a table gets INTO src/vcu/table-catalog.data.ts:
// scripts/extract-vcu-tables.ts (from the manufacturer's binary) and
// scripts/import-em-table.ts (from a service-tool-analysis params JSON). One copy on purpose —
// the delta line format here has to stay in lockstep with the PARSER in
// src/vcu/table-catalog.ts, and a second copy is a second thing to keep true.
//
// Nothing here reads a bus, a binary or a clock: a bundle's records in, a delta out. The
// two callers differ only in how they get the records; from `toDelta` on they are the
// same path, which is why the fingerprint round-trip in either caller proves the same thing.

/** One record as Energica's `.emcpd` JSON writes it. `min`/`max` are datatype ranges and are ignored. */
export interface BundleRecord {
  id: number;
  name: string;
  datatype: string;
  signedness: string;
  ecu: string;
}

export interface ExtractedTable {
  tableType: number;
  /** `ParametersBundle.ExportToFile` stamps `yyyyMMddHHmm`; it names both files in the ZIP. */
  exportStamp: string;
  records: BundleRecord[];
}

/** One table as src/vcu/table-catalog.data.ts stores it: a delta against `params.ecf`'s 277 rows. */
export function toDelta(table: ExtractedTable, base: VcuParameter[]): ParameterTableDelta {
  const baseByIndex = new Map(base.map(parameter => [parameter.index, parameter]));
  const lines: string[] = [];
  for (const record of table.records) {
    assertInvariantsHold(table, record, baseByIndex.get(record.id));
    const baseRow = baseByIndex.get(record.id);
    const signed = record.signedness === "S";
    if (!baseRow) {
      lines.push(`+ ${record.id} ${record.name} ${record.datatype} ${record.signedness} ${record.ecu}`);
      continue;
    }
    if (baseRow.name === record.name && baseRow.signed === signed) {
      continue;
    }
    // The name is repeated even when only the signedness moved, so every line in the
    // delta says what the row IS rather than what changed about it. A line that only
    // carried "id 91 is signed now" would be unreadable next to a rename.
    lines.push(
      baseRow.signed === signed ? `${record.id} ${record.name}` : `${record.id} ${record.name} ${record.signedness}`
    );
  }
  for (const parameter of base) {
    if (!table.records.some(record => record.id === parameter.index)) {
      lines.push(`- ${parameter.index}`);
    }
  }
  return {
    tableType: table.tableType,
    exportStamp: table.exportStamp,
    // ⚠️ Taken from the BUNDLE, before any delta arithmetic. A fingerprint computed
    // from the reconstruction would agree with the reconstruction by construction and
    // would prove nothing at all.
    fingerprint: fingerprintTable(
      table.records.map(record => ({
        index: record.id,
        name: record.name,
        type: record.datatype,
        signed: record.signedness === "S",
        micro: record.ecu,
      }))
    ),
    delta: lines.length === 0 ? "" : `\n${lines.join("\n")}\n`,
  };
}

/**
 * ⚠️ `id → ecu` and `id → datatype` are invariant across every bundle Energica has
 * shipped, and the delta format has no way to express a table where they are not.
 *
 * That invariance is not a convenience — it is why a wrong table is DANGEROUS: a write
 * under the wrong names still goes to the right micro with the right number of bytes,
 * so nothing on the wire notices. If a future build breaks it, the right response is to
 * widen the format deliberately, not to have this quietly drop the difference.
 */
function assertInvariantsHold(table: ExtractedTable, record: BundleRecord, baseRow: VcuParameter | undefined): void {
  if (!baseRow) {
    return;
  }
  if (record.datatype !== baseRow.type) {
    throw new Error(
      `table-delta-build: table ${table.tableType} stores id ${record.id} as ${record.datatype} where params.ecf ` +
        `says ${baseRow.type}. id → datatype has been invariant across all shipped tables; a build that breaks ` +
        "that needs src/vcu/table-catalog.ts's delta format widened before it can be carried"
    );
  }
  if (record.ecu !== baseRow.micro) {
    throw new Error(
      `table-delta-build: table ${table.tableType} routes id ${record.id} to ${record.ecu} where params.ecf says ` +
        `${baseRow.micro}. id → ecu has been invariant across all shipped tables; see the note above this check`
    );
  }
}

/**
 * The catalogue a run should write: everything already committed, plus everything just yielded.
 *
 * ⚠️ Refuses on a content conflict rather than picking a side. Energica builds do not all
 * carry the same tables (2021 has 18 where 2024 has 28), so a straight overwrite from an
 * older install would delete tables the owner still needs; the merge is what keeps them.
 * A TABLE_TYPE present in both with DIFFERENT content STOPS the run: Energica reissued a
 * table or params.ecf moved underneath the catalogue, both worth a human deciding.
 * `replaceEverything` is the escape hatch.
 *
 * The per-table log line lives here because "new", "already had it" and "kept, this build
 * does not have it" are the three things somebody running this needs to see, and only this
 * function knows which is which.
 */
export function mergeIntoCatalogue(
  existing: ParameterTableDelta[],
  extracted: ParameterTableDelta[],
  replaceEverything: boolean
): ParameterTableDelta[] {
  const merged = new Map<number, ParameterTableDelta>();
  if (!replaceEverything) {
    for (const delta of existing) {
      merged.set(delta.tableType, delta);
    }
  }
  let added = 0;
  for (const delta of extracted) {
    const priorEntry = merged.get(delta.tableType);
    if (priorEntry && priorEntry.fingerprint !== delta.fingerprint) {
      throw new Error(
        `table-delta-build: table ${delta.tableType} is already in src/vcu/table-catalog.data.ts with a ` +
          `DIFFERENT content (fingerprint ${priorEntry.fingerprint}, export ${priorEntry.exportStamp}) from the one ` +
          `being imported (${delta.fingerprint}, export ${delta.exportStamp}). Every table shared between the ` +
          "sources seen so far is byte-identical, so this is a real finding: either Energica reissued a table under " +
          "the same TABLE_TYPE, or src/vcu/param-file.ts's params.ecf text has changed underneath the catalogue. " +
          "Please open an issue with both export stamps. `--replace` writes only this source's tables, discarding " +
          "every table it does not have."
      );
    }
    if (!priorEntry) {
      added += 1;
    }
    merged.set(delta.tableType, delta);
  }
  const catalogue = [...merged.values()].sort((left, right) => left.tableType - right.tableType);
  const fromThisSource = new Set(extracted.map(delta => delta.tableType));
  const carriedBefore = new Set(existing.map(delta => delta.tableType));
  for (const delta of catalogue) {
    const rows = deltaRowCount(delta);
    const provenance = !fromThisSource.has(delta.tableType)
      ? "kept — not in this source"
      : carriedBefore.has(delta.tableType) && !replaceEverything
        ? "already carried, unchanged"
        : "NEW";
    console.log(
      `  ${String(delta.tableType).padStart(5)}  export=${delta.exportStamp}  fingerprint=${delta.fingerprint}  ` +
        `${String(rows).padStart(3)} row(s) differ from params.ecf   ${provenance}`
    );
  }
  console.log(
    `table-delta-build: ${extracted.length} table(s) in this source, ${added} of them new; ` +
      `catalogue goes from ${replaceEverything ? 0 : existing.length} to ${catalogue.length}`
  );
  return catalogue;
}

function deltaRowCount(delta: ParameterTableDelta): number {
  return delta.delta.split("\n").filter(line => line.trim().length > 0).length;
}

export function renderModule(deltas: ParameterTableDelta[]): string {
  const entries = deltas
    .map(delta =>
      [
        "  {",
        `    tableType: ${delta.tableType},`,
        `    exportStamp: "${delta.exportStamp}",`,
        `    fingerprint: "${delta.fingerprint}",`,
        `    delta: \`${delta.delta}\`,`,
        "  },",
      ].join("\n")
    )
    .join("\n");
  return `${moduleHeader()}\nexport const PARAMETER_TABLE_DELTAS: ParameterTableDelta[] = [\n${entries}\n];\n`;
}

/** The generated file's own header. A function so it can sit down here with the other helpers. */
function moduleHeader(): string {
  return `import type { ParameterTableDelta } from "./table-catalog.ts";

// GENERATED FILE — do not edit by hand. Regenerate with:
//
//     node --experimental-strip-types scripts/extract-vcu-tables.ts /path/to/service-tool.exe
//     npx prettier --write src/vcu/table-catalog.data.ts
//
// Energica's VCU parameter tables, one entry per \`TABLE_TYPE\` the manufacturer's
// service tool can select, each stored as a DELTA against \`params.ecf\` (which is table
// 16406 — see ./param-file.ts). ./table-catalog.ts rebuilds the full table from a delta
// and checks the result against the fingerprint recorded here, which was taken from
// Energica's own bundle rather than from the delta.
//
// Delta format, one row per line — the same columns as params.ecf, minus the ones that
// cannot differ:
//
//     <index> <NAME>              the id is renamed; signedness unchanged
//     <index> <NAME> <S|U>        renamed and/or the S/U column differs
//     + <index> <NAME> <TYPE> <S|U> <MICRO>   an id params.ecf does not have
//     - <index>                   an id params.ecf has and this table does not
//
// An empty delta means the table is byte-identical to params.ecf.
//
// ⚠️ Adding your own bike's table is a supported thing to do and does not mean editing
// this file by hand — see README.md, "Adding your bike's VCU parameter table".
`;
}
