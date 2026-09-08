import { readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { inflateRaw } from "zlib";
import { promisify } from "util";
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

// Pulls Energica's VCU parameter tables out of the manufacturer's service-tool
// executable and writes them into src/vcu/table-catalog.data.ts, which is the file the
// service actually reads.
//
//     node --experimental-strip-types scripts/extract-vcu-tables.ts /path/to/service-tool.exe
//
// ⚠️ THIS IS THE SCRIPT THAT MAKES THIS REPO USABLE ON SOMEBODY ELSE'S BIKE. A VCU
// addresses its parameters BY INDEX, and what an index means comes from the table it is
// running; if this repo does not carry yours, src/vcu/table-gate.ts refuses every write
// rather than put a number into whichever parameter our table gives your name to. Run
// this against your own install and commit the diff — README.md, "Adding your bike's VCU
// parameter table", is the walkthrough.
//
// ⚠️ IT MERGES, AND THAT IS NOT A NICETY. Energica builds do not all carry the same
// tables (the 2021 build has 18 where the 2024 has 28), so a straight overwrite from an
// older install would delete this repo's own bike's table and 19 others while the owner
// believed they had contributed something. A TABLE_TYPE present in both with DIFFERENT
// content STOPS the script: that means Energica reissued a table or params.ecf moved
// underneath the catalogue, both worth a human deciding. `--replace` is the escape hatch.
//
// ⚠️ THE RESOURCE NAME IS THE ANSWER. DO NOT BYTE-SCAN. Each table is a ZIP stored as a
// .NET `ManifestResource` named `_<TABLE_TYPE>`, and that name is the ONLY thing in the
// binary binding a table to the number the bike reports. Scanning for ZIP archives finds
// more of them and throws the binding away — which is how an earlier attempt identified
// the wrong table for the bike this repo runs on. Walk the resource directory, take the
// name, ignore anything not called `_<digits>`.
//
// What a bundle does and does not contain, why the output is a delta rather than 28
// tables, and what the fingerprint is for: docs/diagnostics-and-checks.md §12.

const inflateRawAsync = promisify(inflateRaw);

/** `0xBEEFCACE` — the .NET `ResourceReader` blob's magic number, little-endian. */
const RESOURCE_MAGIC = 0xbeefcace;

/** `System.Byte[]` in the `ResourceTypeCode` enum, which is how a bundle ZIP is stored. */
const RESOURCE_TYPE_BYTE_ARRAY = 32;

/** Local file header signature — the ZIPs here are small and stored back to back, so the central directory is not needed. */
const ZIP_LOCAL_HEADER = 0x04034b50;

/** The only compression method these bundles use. */
const ZIP_DEFLATE = 8;

const HERE = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(HERE, "..", "src", "vcu", "table-catalog.data.ts");

// The argument is a path on the contributor's own disk, so it is DESCRIBED rather than
// named: this is a public repo and the manufacturer's product name stays out of it
// (scripts/check-vendor-names.ts enforces that). Nothing here matches on the file's
// name, so the description costs the tool nothing — what it actually needs is a .NET
// assembly carrying `_<TABLE_TYPE>` resources, and the failure path below says exactly
// that when it gets something else.
const exePath = process.argv[2];
if (!exePath) {
  console.error(
    "usage: node --experimental-strip-types scripts/extract-vcu-tables.ts <service-tool.exe> [--stdout] [--replace]"
  );
  console.error("");
  console.error("Point it at the main executable of Energica's Windows service tool — the dealer diagnostic");
  console.error("application itself, not its installer. A 2024-era install puts it under");
  console.error("  C:\\Program Files (x86)\\Energica\\<the tool's own directory>\\");
  console.error("where it is by far the largest file (~137 MB in the 2024 build), because the parameter tables");
  console.error("are only a small part of it.");
  process.exit(1);
}

const assembly = await readFile(exePath);
console.log(`extract-vcu-tables: read ${exePath} (${(assembly.length / 1e6).toFixed(1)} MB)`);

const replaceEverything = process.argv.includes("--replace");
const tables = await extractTables(assembly);
if (tables.length === 0) {
  // Loud, and specific about the two ways this happens: the wrong file, or a build
  // whose resources are laid out differently. "0 tables" with a zero exit code would
  // be read as "my install has none", which is not a thing that happens.
  console.error(
    `extract-vcu-tables: found NO \`_<TABLE_TYPE>\` resources in ${exePath}, so nothing was written.\n` +
      "  • It has to be the service tool's own executable, not the installer. `energica-setup.msi` holds that\n" +
      "    exe inside a compressed CAB and nothing here can see through it — install it (or unpack the MSI) first.\n" +
      "  • If it IS that executable, this build stores its parameter bundles differently from the 2021 and 2024\n" +
      "    ones this was written against. Please open an issue with the build version — that is a finding, and\n" +
      "    the reader at the top of this file is where it would be fixed."
  );
  process.exit(1);
}

const base = parseParameterFile(PARAMETER_FILE_TEXT());
const extracted = tables.map(table => toDelta(table, base));
const deltas = mergeIntoCatalogue(PARAMETER_TABLE_DELTAS, extracted, replaceEverything);

// ⚠️ Round-tripped BEFORE anything is written: every delta is rebuilt through the same
// code the service uses and checked against its own fingerprint. The catalogue's own
// self-check (src/vcu/table-catalog.ts) and scripts/check-vcu-params.ts §1e would both
// catch a bad delta anyway — but they catch it one command later, and a contributor who
// has never run this repo's tests would have committed the file by then. Throwing here
// means the script that produced the fault is the thing that reports it.
for (const delta of deltas) {
  buildParameterTable(delta);
}

const source = renderModule(deltas);
if (process.argv.includes("--stdout")) {
  process.stdout.write(source);
} else {
  await writeFile(OUTPUT_PATH, source, "utf-8");
  console.log(
    `extract-vcu-tables: wrote ${deltas.length} table(s) to ${OUTPUT_PATH} (${(source.length / 1024).toFixed(1)} KB). ` +
      "Run `npx prettier --write src/vcu/table-catalog.data.ts && npm test` before committing."
  );
}

/**
 * Every `_<TABLE_TYPE>` resource in the assembly, as parsed bundle records.
 *
 * Walks each `ResourceReader` blob's own directory rather than scanning for ZIPs — see
 * the header for why that distinction is the whole point of this script.
 */
async function extractTables(assembly: Buffer): Promise<ExtractedTable[]> {
  const byTableType = new Map<number, ExtractedTable>();
  const { sets, skipped } = resourceSets(assembly);
  console.log(
    `extract-vcu-tables: ${sets.length} .NET resource set(s) read` +
      (skipped.length > 0 ? `, ${skipped.length} false magic match(es) skipped: ${skipped.join(", ")}` : "")
  );
  for (const resources of sets) {
    for (const [name, offset] of resources) {
      const match = /^_(\d+)$/.exec(name);
      if (!match) {
        continue;
      }
      const tableType = Number(match[1]);
      const bundle = await readBundle(assembly, offset);
      if (!bundle) {
        continue;
      }
      const existing = byTableType.get(tableType);
      if (existing) {
        // Every resource is stored twice in these builds. Identical twins are
        // expected and silent; a genuine disagreement is not, and would mean the
        // name→table binding is ambiguous, which is the one thing this script must
        // not paper over.
        if (JSON.stringify(existing.records) !== JSON.stringify(bundle.records)) {
          throw new Error(
            `extract-vcu-tables: resource _${tableType} appears twice with DIFFERENT contents ` +
              `(${existing.exportStamp} and ${bundle.exportStamp}) — the TABLE_TYPE → table binding is ambiguous ` +
              "in this build and cannot be resolved by picking one"
          );
        }
        continue;
      }
      byTableType.set(tableType, { tableType, exportStamp: bundle.exportStamp, records: bundle.records });
    }
  }
  return [...byTableType.values()];
}

/**
 * Yields `name → file offset of the value` for every .NET `ResourceReader` blob found.
 *
 * The layout is .NET's, not ours: magic, a length-prefixed reader type name, a version
 * header, a type table of length-prefixed UTF-8 names, 8-byte alignment, per-resource
 * name hashes, per-resource name offsets, then the name section (UTF-16 names each
 * followed by a 4-byte offset into the data section).
 *
 * ⚠️ Scans the WHOLE file for the magic rather than reading the CLI metadata tables,
 * which is why it needs no .NET tooling and works from macOS. A false positive is
 * possible in principle — four bytes can occur anywhere — so every parse is wrapped and
 * a blob that does not read as a resource set is skipped rather than fatal. The 2024
 * build yields 39 candidate sets of which one carries the 28 tables.
 */
function resourceSets(assembly: Buffer): { sets: Map<string, number>[]; skipped: string[] } {
  const magic = Buffer.alloc(4);
  magic.writeUInt32LE(RESOURCE_MAGIC);
  const sets: Map<string, number>[] = [];
  const skipped: string[] = [];
  let searchFrom = 0;
  for (;;) {
    const base = assembly.indexOf(magic, searchFrom);
    if (base < 0) {
      return { sets, skipped };
    }
    searchFrom = base + 4;
    try {
      sets.push(readResourceSet(assembly, base));
    } catch (err) {
      // Expected, and reported as a count rather than swallowed: a REAL resource set
      // failing to parse would otherwise be indistinguishable from four bytes of
      // ordinary data that happen to spell the magic, and would silently cost tables.
      skipped.push(`0x${base.toString(16)} (${err instanceof Error ? err.message : String(err)})`);
    }
  }
}

function readResourceSet(assembly: Buffer, base: number): Map<string, number> {
  let position = base + 8;
  position += 4 + assembly.readUInt32LE(position);
  const readerVersion = assembly.readUInt32LE(position);
  const resourceCount = assembly.readUInt32LE(position + 4);
  const typeCount = assembly.readUInt32LE(position + 8);
  position += 12;
  if (readerVersion !== 1 && readerVersion !== 2) {
    throw new Error(`reader version ${readerVersion}`);
  }
  if (resourceCount <= 0 || resourceCount > 100_000) {
    throw new Error(`${resourceCount} resources`);
  }
  for (let type = 0; type < typeCount; type += 1) {
    const [length, next] = readUnsignedLeb128(assembly, position);
    position = next + length;
  }
  position = base + Math.ceil((position - base) / 8) * 8;
  position += 4 * resourceCount; // name hashes, in sorted order — not needed to read by name
  const nameOffsets: number[] = [];
  for (let resource = 0; resource < resourceCount; resource += 1) {
    nameOffsets.push(assembly.readUInt32LE(position + 4 * resource));
  }
  position += 4 * resourceCount;
  const dataSection = base + assembly.readUInt32LE(position);
  const nameSection = position + 4;
  const resources = new Map<string, number>();
  for (const nameOffset of nameOffsets) {
    const [byteLength, after] = readUnsignedLeb128(assembly, nameSection + nameOffset);
    const name = assembly.subarray(after, after + byteLength).toString("utf16le");
    resources.set(name, dataSection + assembly.readUInt32LE(after + byteLength));
  }
  return resources;
}

/** The `.emcpd` inside one resource's ZIP, or null when the resource is not a bundle at all. */
async function readBundle(
  assembly: Buffer,
  offset: number
): Promise<{ exportStamp: string; records: BundleRecord[] } | null> {
  const [typeCode, afterType] = readUnsignedLeb128(assembly, offset);
  if (typeCode !== RESOURCE_TYPE_BYTE_ARRAY) {
    return null;
  }
  const length = assembly.readInt32LE(afterType);
  const archive = assembly.subarray(afterType + 4, afterType + 4 + length);
  if (archive.length < 4 || archive.readUInt32LE(0) !== ZIP_LOCAL_HEADER) {
    return null;
  }
  const entry = zipEntries(archive).find(candidate => candidate.name.endsWith(".emcpd"));
  if (!entry) {
    return null;
  }
  return { exportStamp: entry.name.replace(/\.emcpd$/, ""), records: parseBundleJson(entry, await decodeEntry(entry)) };
}

interface ZipEntry {
  name: string;
  /** 0 = stored, 8 = deflate. Anything else throws rather than being guessed at. */
  method: number;
  bytes: Buffer;
}

/**
 * Walks a ZIP's local file headers.
 *
 * These archives are written by .NET's own zip writer, in one pass, with every entry's
 * sizes filled in and no data descriptors — so the local headers are complete and the
 * central directory adds nothing. Anything unexpected throws.
 */
function zipEntries(archive: Buffer): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let position = 0;
  while (position + 30 <= archive.length && archive.readUInt32LE(position) === ZIP_LOCAL_HEADER) {
    const flags = archive.readUInt16LE(position + 6);
    const method = archive.readUInt16LE(position + 8);
    const compressedSize = archive.readUInt32LE(position + 18);
    const nameLength = archive.readUInt16LE(position + 26);
    const extraLength = archive.readUInt16LE(position + 28);
    const name = archive.subarray(position + 30, position + 30 + nameLength).toString("utf-8");
    if ((flags & 0x08) !== 0) {
      throw new Error(`extract-vcu-tables: ZIP entry ${name} uses a data descriptor, which this reader cannot follow`);
    }
    const dataAt = position + 30 + nameLength + extraLength;
    entries.push({ name, method, bytes: archive.subarray(dataAt, dataAt + compressedSize) });
    position = dataAt + compressedSize;
  }
  return entries;
}

function parseBundleJson(entry: ZipEntry, text: string): BundleRecord[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    throw new Error(`extract-vcu-tables: ${entry.name} is not a JSON array`);
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
      throw new Error(`extract-vcu-tables: ${entry.name} has a record missing id/name/datatype/signedness/ecu`);
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

/**
 * One ZIP entry as text. Every bundle in the 2024 build is deflated (method 8); stored
 * (method 0) is accepted too because it costs one branch, and anything else throws
 * rather than being handed to the inflater and failing further away from the cause.
 *
 * `promisify(inflateRaw)` rather than `inflateRawSync` — CLAUDE.md's no-blocking-calls
 * rule is about the service rather than a script, but there is no reason for a script
 * to model the wrong habit.
 */
async function decodeEntry(entry: ZipEntry): Promise<string> {
  if (entry.method === 0) {
    return entry.bytes.toString("utf-8");
  }
  if (entry.method !== ZIP_DEFLATE) {
    throw new Error(`extract-vcu-tables: ${entry.name} uses compression method ${entry.method}, not stored or deflate`);
  }
  return (await inflateRawAsync(entry.bytes)).toString("utf-8");
}

/** .NET writes string lengths and resource type codes as 7-bit-per-byte LEB128. */
function readUnsignedLeb128(assembly: Buffer, position: number): [value: number, next: number] {
  let value = 0;
  let shift = 0;
  let cursor = position;
  for (;;) {
    if (cursor >= assembly.length) {
      // ⚠️ Loud rather than `undefined & 0x80 === 0` quietly terminating the loop with a
      // plausible number. This runs on candidate blobs found by scanning for four magic
      // bytes anywhere in a 137 MB file, so running off the end is a normal way for a
      // FALSE match to end — and it has to land in `skipped` as one, not produce a
      // resource map that looks real.
      throw new Error(`LEB128 at 0x${position.toString(16)} runs off the end of the file`);
    }
    const byte = assembly[cursor];
    cursor += 1;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return [value, cursor];
    }
    shift += 7;
    if (shift > 28) {
      throw new Error(`LEB128 at 0x${position.toString(16)} does not terminate`);
    }
  }
}
