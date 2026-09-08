import { readFile, writeFile } from "fs/promises";
import { basename, dirname, join } from "path";
import { fileURLToPath } from "url";
import { PARAMETER_FILE_TEXT, parseParameterFile } from "../src/vcu/param-file.ts";
import { buildParameterTable } from "../src/vcu/table-catalog.ts";
import { PARAMETER_TABLE_DELTAS } from "../src/vcu/table-catalog.data.ts";
import {
  mergeIntoCatalogue,
  renderModule,
  toDelta,
  type BundleRecord,
  type ExtractedTable,
} from "./table-delta-build.ts";

// Adds a VCU parameter table to src/vcu/table-catalog.data.ts from a service-tool-analysis
// `<TABLE_TYPE>.json` parameter file, for a table this bike REPORTS but the
// manufacturer's binary we extracted from did not carry.
//
//     node --experimental-strip-types scripts/import-em-table.ts <param JSON dir> <TABLE_TYPE>...
//
// ⚠️ SECOND-HAND PROVENANCE, AND THAT IS THE ONE DIFFERENCE FROM extract-vcu-tables.ts.
// That script reads Energica's own executable and fingerprints each table from the bundle
// bytes Energica shipped. The service-tool analysis's JSON is itself a decompiled extraction one step
// removed from that binary — so the fingerprint here is taken over the analysis's records,
// not an Energica ZIP, and the `exportStamp` is set to "service-tool-analysis" rather than the
// `yyyyMMddHHmm` the binary path recovers. Both are visible in the committed catalogue on
// purpose: a reader can tell which tables came first-party and which did not. Everything
// downstream of the records — the delta arithmetic, the invariant checks, the fingerprint
// round-trip, the merge that refuses on a content conflict — is the SAME code path
// (./table-delta-build.ts), so an imported table that disagrees with one we already
// carry still stops the run.
//
// The delta format, why it is a delta and not 33 whole tables, and what the fingerprint
// proves and does not: src/vcu/table-catalog.ts and docs/vcu-parameters.md §3.

/** Marks a table as extracted from the service-tool analysis rather than from Energica's binary. */
const EM_EXPORT_STAMP = "service-tool-analysis";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(HERE, "..", "src", "vcu", "table-catalog.data.ts");

const emParamsDir = process.argv[2];
const tableTypeArgs = process.argv.slice(3).filter(argument => !argument.startsWith("--"));
if (!emParamsDir || tableTypeArgs.length === 0) {
  console.error(
    "usage: node --experimental-strip-types scripts/import-em-table.ts <param JSON dir> <TABLE_TYPE>... " +
      "[--stdout] [--replace]"
  );
  console.error("");
  console.error("Point it at the analysis's parameter-JSON directory and name the TABLE_TYPE(s) to import — the");
  console.error("decimal number the bike reports at parameter 277, which is also the JSON filename. Import only the");
  console.error("table(s) you have verified your bike is on; this is not a bulk sync.");
  process.exit(1);
}

const tableTypes = tableTypeArgs.map(argument => {
  const value = Number(argument);
  if (!Number.isInteger(value) || value <= 0) {
    console.error(`import-em-table: “${argument}” is not a TABLE_TYPE number`);
    process.exit(1);
  }
  return value;
});

const replaceEverything = process.argv.includes("--replace");
const tables: ExtractedTable[] = [];
for (const tableType of tableTypes) {
  const path = join(emParamsDir, `${tableType}.json`);
  const records = await readTableFile(path, tableType);
  console.log(`import-em-table: read ${path} (${records.length} records)`);
  tables.push({ tableType, exportStamp: EM_EXPORT_STAMP, records });
}

const base = parseParameterFile(PARAMETER_FILE_TEXT());
const extracted = tables.map(table => toDelta(table, base));
const deltas = mergeIntoCatalogue(PARAMETER_TABLE_DELTAS, extracted, replaceEverything);

// ⚠️ Round-tripped BEFORE anything is written, exactly as extract-vcu-tables.ts does it:
// every delta is rebuilt through the same code the service uses and checked against its
// own fingerprint, so a bad delta is reported by the script that produced it rather than
// by `npm test` one command later.
for (const delta of deltas) {
  buildParameterTable(delta);
}

const source = renderModule(deltas);
if (process.argv.includes("--stdout")) {
  process.stdout.write(source);
} else {
  await writeFile(OUTPUT_PATH, source, "utf-8");
  console.log(
    `import-em-table: wrote ${deltas.length} table(s) to ${OUTPUT_PATH} (${(source.length / 1024).toFixed(1)} KB). ` +
      "Run `npx prettier --write src/vcu/table-catalog.data.ts && npm test` before committing."
  );
}

/**
 * Reads and validates one service-tool-analysis parameter table into bundle records.
 *
 * ⚠️ Strict on the record shape — the same bargain the ZIP parser in
 * extract-vcu-tables.ts makes: a file this does not fully understand must throw, not
 * become a table with quietly-missing rows. `min`/`max` are present in the JSON and
 * ignored, the way the `.emcpd` path ignores them.
 */
async function readTableFile(path: string, tableType: number): Promise<BundleRecord[]> {
  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch (err) {
    throw new Error(
      `import-em-table: could not read ${path} for TABLE_TYPE ${tableType} — the analysis names each table's ` +
        `file after its decimal TABLE_TYPE, so ${basename(path)} is what to expect there (${
          err instanceof Error ? err.message : String(err)
        })`
    );
  }
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    throw new Error(`import-em-table: ${path} is not a JSON array`);
  }
  return parsed.map(record => {
    const fields = record as Partial<BundleRecord>;
    if (
      typeof fields.id !== "number" ||
      typeof fields.name !== "string" ||
      typeof fields.datatype !== "string" ||
      typeof fields.signedness !== "string" ||
      typeof fields.ecu !== "string"
    ) {
      throw new Error(`import-em-table: ${path} has a record missing id/name/datatype/signedness/ecu`);
    }
    return {
      id: fields.id,
      name: fields.name,
      datatype: fields.datatype,
      signedness: fields.signedness,
      ecu: fields.ecu,
    };
  });
}
