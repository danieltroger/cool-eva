import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAuditRecord, recentAuditRecords, type AuditRecord } from "../src/vcu/write-audit.ts";

// The audit journal's reader, against real files in a temp directory.
//
//   node --experimental-strip-types scripts/check-write-audit.ts
//
// ⚠️ src/vcu/write-audit.ts had NO coverage at all until 2026-09-08 — neither the reader nor
// the appender — and it is the only record of what has been done to this motorcycle.
//
// ⚠️ WHAT THE NUL CASES DO AND DO NOT PROVE. A power cut leaves the block allocated and the
// write lost, so a record comes back as NUL bytes. Three shapes follow from that, and §5 is
// the fence between them: NULs alone are a hole (nothing to recover); NULs followed by bytes
// that will not parse are a hole whose neighbour was torn too; and NULs followed by bytes that
// DO parse are a hole that ended on a record boundary, where the surviving record is kept —
// the 2026-09-09 line 15 on this bike, an ECUReset of both micros, which the old reader threw
// away with a stack trace on every request (#189). A NUL anywhere but a contiguous leading run
// stays an ordinary damaged line: that is what stops this widening into "skip anything with a
// NUL in it". Every injury is named ONCE PER PROCESS, because the dashboard polls /vcu-write.
//
// ⚠️ EACH SECTION GETS ITS OWN DIRECTORY. The reader's once-per-process key is per file, line
// and shape, so sections sharing one temp directory would silently claim each other's keys —
// §3's whole claim is a warning COUNT, and it read zero rather than one when §2 had already
// warned about the same bytes at the same path.

let failures = 0;

function check(what: string, condition: boolean) {
  if (condition) {
    console.log(`  ✓ ${what}`);
    return;
  }
  console.error(`  ✗ ${what}`);
  failures += 1;
}

/** One journal line. Built through JSON.stringify so a shape change here follows the type. */
function line(record: Partial<AuditRecord> & { at: number }): string {
  return JSON.stringify({ clockTrustworthy: true, action: "parameter-write", status: "written", ...record });
}

const directories: string[] = [];

/** A directory nothing else has written to, so the reader's per-process key cannot be pre-claimed. */
async function freshDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "cool-eva-audit-"));
  directories.push(directory);
  return directory;
}

/** Writes one journal into its own directory and hands back the path. */
async function journalOf(...lines: string[]): Promise<string> {
  const directory = await freshDirectory();
  await writeFile(join(directory, "service-writes.jsonl"), lines.join("\n"), "utf-8");
  return directory;
}

/**
 * Runs `body` with console.warn and console.log captured.
 *
 * ⚠️ Restored in a `finally`. An assertion that throws while the console is hooked would
 * otherwise leave every later check in this file — and the suite's own output — mute.
 */
async function readCapturing(
  directory: string,
  limit: number,
  reads = 1
): Promise<{ records: AuditRecord[]; warned: string[]; logged: string[] }> {
  const warned: string[] = [];
  const logged: string[] = [];
  const realWarn = console.warn;
  const realLog = console.log;
  console.warn = (...args: unknown[]) => void warned.push(args.map(String).join(" "));
  console.log = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
  let records: AuditRecord[] = [];
  try {
    for (let attempt = 0; attempt < reads; attempt += 1) {
      records = await recentAuditRecords(directory, limit);
    }
  } finally {
    console.warn = realWarn;
    console.log = realLog;
  }
  return { records, warned, logged };
}

console.log("\n──── scripts/check-write-audit.ts ──────────────────────────────────────────────");
console.log("     the audit journal's reader: blank lines, NUL holes, torn tails, damage, order and limit");

const NUL_LINE = "\0".repeat(1710);
/** The hole on this bike's line 15, at its real size. docs/power-cuts.md §2. */
const REAL_HOLE = "\0".repeat(215);

// ── 1. Blank and whitespace-only lines are skipped, and everything else survives ──────
{
  const directory = await journalOf(line({ at: 1 }), "", line({ at: 2 }), "   ", "\t", line({ at: 3 }), "");
  const { records, warned } = await readCapturing(directory, 10);
  check("three records survive four blank or whitespace-only lines", records.length === 3);
  check("newest first", records[0].at === 3 && records[2].at === 1);
  check("nothing is warned about a blank line", warned.length === 0);
}

// ── 2. A NUL-only line MID-FILE — the 2026-09-08 artifact, at its real size ───────────
{
  const directory = await journalOf(line({ at: 1 }), line({ at: 2 }), NUL_LINE, line({ at: 3 }), line({ at: 4 }));
  const { records, warned, logged } = await readCapturing(directory, 10);
  check("every record around a 1 710-byte NUL hole is returned", records.length === 4);
  check("and they are the right ones", records.map(record => record.at).join(",") === "4,3,2,1");
  // ⚠️ THE ASSERTIONS THAT ARE RED ON THE OLD READER. The two above pass on both.
  check("a hole is still reported as damage, not as routine", warned.length === 1);
  check("it is named as a hole rather than as invalid JSON", warned[0]?.includes("NUL bytes") === true);
  check(
    "and it does not claim to be a parse error",
    warned.every(entry => !entry.includes("is not valid JSON"))
  );
  check(
    "the line number and byte count are in the message",
    warned.some(entry => entry.includes("line 3") && entry.includes("1710"))
  );
  check("and no stack trace rides along", logged.length === 0 && warned.every(entry => !entry.includes("SyntaxError")));
}

// ── 3. Read three times, the injury is named ONCE — not once per request ──────────────
{
  // The journal is read on every GET and POST to /vcu-write (write-runner.ts's status()), and the
  // dashboard polls it, so "once per read" is dozens of lines a minute about one damaged line.
  const directory = await journalOf(line({ at: 1 }), NUL_LINE, line({ at: 2 }));
  const { records, warned } = await readCapturing(directory, 10, 3);
  check("three reads name the hole once", warned.filter(entry => entry.includes("NUL bytes")).length === 1);
  check("the records still come back on every read", records.length === 2);
  check("and the message says it is said once", warned[0]?.includes("once per process") === true);

  // ⚠️ The mutation this pairs with: a dedupe that degenerates into "warn once ever" also passes
  // the assertion above. A SECOND, DIFFERENT injury must still get its own line.
  const second = await journalOf(line({ at: 1 }), NUL_LINE, line({ at: 2 }), "{not json at all", line({ at: 3 }));
  const twice = await readCapturing(second, 10, 3);
  check(
    "a second, different injury in the same file is still named",
    twice.warned.filter(entry => entry.includes("NUL bytes")).length === 1 &&
      twice.warned.filter(entry => entry.includes("not valid JSON")).length === 1
  );
}

// ── 4. A NUL-only LAST line — a torn append that landed in a hole ─────────────────────
{
  const directory = await journalOf(line({ at: 1 }), NUL_LINE);
  const { records, warned } = await readCapturing(directory, 10);
  check("the record before a trailing NUL hole survives", records.length === 1 && records[0].at === 1);
  check(
    "and a trailing hole is damage too — a hole is not a torn tail",
    warned.some(e => e.includes("NUL bytes"))
  );
}

// ── 5. THE FENCE: what a NUL prefix does and does not license ─────────────────────────
//
// ⚠️ This is what stops the fix widening into "skip anything with a NUL in it". Each case gets
// its own directory: the reader's key is per line and shape, and three fixtures at the same
// path could claim one another's.
{
  // 5a — the REAL shape of this bike's line 15: a hole, then a whole record the lost newline
  // glued on. The record is KEPT. Skipping it would lower the count of what was done to this
  // bike, and the one it would lose is an ECUReset of both VCU micros.
  const recovered = `${REAL_HOLE}${line({ at: 2, action: "reset-vcu", status: "reset" })}`;
  const directory = await journalOf(line({ at: 1 }), recovered, line({ at: 3 }));
  const { records, warned, logged } = await readCapturing(directory, 10);
  check("5a the record after a hole is recovered, not dropped", records.length === 3);
  check(
    "5a and it is the right record",
    records.map(record => record.at).join(",") === "3,2,1" && records[1].action === "reset-vcu"
  );
  check("5a the hole is still reported", warned.length === 1 && warned[0].includes("215 bytes"));
  check("5a the warning says the tail was kept", warned[0]?.includes("are kept") === true);
  check(
    "5a and it is not called a parse error",
    logged.length === 0 && warned.every(entry => !entry.includes("not valid JSON") && !entry.includes("SyntaxError"))
  );
}
{
  // 5b — the shape #189 describes: a hole whose neighbour was torn too. Skipped, one line, no
  // stack trace. This is the planted line the issue asks for.
  const torn = `${REAL_HOLE}{"at":17`;
  const directory = await journalOf(line({ at: 1 }), torn, line({ at: 3 }));
  const { records, warned, logged } = await readCapturing(directory, 10, 3);
  check("5b a torn tail after a hole costs only itself", records.length === 2);
  check("5b it is named once over three reads", warned.length === 1);
  check(
    "5b named as a power cut rather than as invalid JSON",
    warned[0]?.includes("215 NUL bytes then 8 bytes that are not a record") === true
  );
  check(
    "5b and no stack trace on any read",
    logged.length === 0 && warned.every(entry => !entry.includes("SyntaxError"))
  );
}
{
  // 5c — ⚠️ THE FENCE ITSELF. A NUL in the MIDDLE is not a power-cut prefix. This is red on any
  // reader that switches on `line.includes("\0")` rather than on a contiguous leading run.
  const scattered = `{"at":1,"no${"\0".repeat(40)}te":"x"}`;
  const directory = await journalOf(line({ at: 1 }), scattered, line({ at: 3 }));
  const { records, warned } = await readCapturing(directory, 10);
  check("5c a NUL in the middle is not recovered", records.length === 2);
  check(
    "5c and it stays an ordinary damaged line",
    warned.some(entry => entry.includes("not valid JSON")) &&
      warned.every(entry => !entry.includes("NUL bytes") && !entry.includes("are kept"))
  );
}
{
  // 5d — salvaged bytes get a stricter bar than an ordinary line. A tail that parses but is not
  // a record is not one.
  const bare = await journalOf(line({ at: 1 }), `${REAL_HOLE}5`, line({ at: 3 }));
  const bareRead = await readCapturing(bare, 10);
  check("5d a hole followed by a bare number recovers nothing", bareRead.records.length === 2);
  const partial = await journalOf(line({ at: 1 }), `${REAL_HOLE}{"status":"written"}`, line({ at: 3 }));
  const partialRead = await readCapturing(partial, 10);
  check("5d nor one followed by an object with no `at` and no `action`", partialRead.records.length === 2);
  // All three fields, one at a time: every record has `at`, `action` and `status`, and salvaged
  // bytes missing any of them are a fragment that happens to parse rather than a record.
  const noStatus = await journalOf(line({ at: 1 }), `${REAL_HOLE}{"at":2,"action":"clear-dtcs"}`, line({ at: 3 }));
  const noStatusRead = await readCapturing(noStatus, 10);
  check("5d nor one with an `at` and an `action` but no `status`", noStatusRead.records.length === 2);
}
{
  // 5e — precedence. A hole at the END of the file is still damage: §4 already holds that for an
  // all-NUL trailing line, and a torn tail after a hole is the same injury one byte along. Only a
  // line with NO NULs that fails to parse last is the routine "killed mid-write" case.
  const directory = await journalOf(line({ at: 1 }), `${REAL_HOLE}{"at":17`);
  const { records, warned, logged } = await readCapturing(directory, 10);
  check("5e a torn tail after a hole is damage even as the last line", records.length === 1 && warned.length === 1);
  check(
    "5e it is warned, not logged as routine",
    logged.every(entry => !entry.includes("mid-record"))
  );
}

// ── 6. Ordinary corruption still warns; a torn LAST line does not ─────────────────────
{
  const damaged = await journalOf(line({ at: 1 }), "{not json at all", line({ at: 3 }));
  const { records, warned } = await readCapturing(damaged, 10);
  check("a damaged mid-file line costs only itself", records.length === 2);
  check(
    "and it is warned about, with its line number",
    warned.some(entry => entry.includes("line 2"))
  );

  const tornDirectory = await journalOf(line({ at: 1 }), '{"at":2,"acti');
  const torn = await readCapturing(tornDirectory, 10);
  check("a torn last line costs only itself", torn.records.length === 1);
  check(
    "a torn last line is logged, not warned",
    torn.warned.length === 0 && torn.logged.some(e => e.includes("mid-record"))
  );
}

// ── 7. The limit, and a journal that is not there ─────────────────────────────────────
{
  const many = Array.from({ length: 20 }, (_, index) => line({ at: index + 1 }));
  const directory = await journalOf(...many);
  const records = await recentAuditRecords(directory, 5);
  check(
    "the limit slices the NEWEST records, not the oldest",
    records.length === 5 && records[0].at === 20 && records[4].at === 16
  );

  const empty = await freshDirectory();
  const absent = await readCapturing(empty, 5);
  check("a journal that does not exist reads as no records", absent.records.length === 0);
  check("and ENOENT is not warned about — an absent journal is not an unreadable one", absent.warned.length === 0);
}

// ── 8. Round trip, and the stamp read's own record ────────────────────────────────────
{
  const fresh = await freshDirectory();
  await appendAuditRecord(fresh, {
    at: 1788869826358,
    clockTrustworthy: true,
    action: "read-service-stamp",
    status: "read",
    before: "2000-01-01T00:00:00.000Z",
    after: 0,
    rawHex: "13E8=0000 13E9=0000 13EA=0000 13EB=0000",
    note: "reads zero — no service point has ever been set on this bike, or A8 answered with an empty cell",
  });
  const [record] = await recentAuditRecords(fresh, 5);
  check("a record written by appendAuditRecord reads back", record?.action === "read-service-stamp");
  // ⚠️ The four WORDs are the ONLY primary evidence of the 2026-09-08 read, and before this
  // they survived nowhere: before/after keep what the bytes MEAN. docs/service-stamp.md §3.
  check("and its rawHex survives the round trip", record?.rawHex === "13E8=0000 13E9=0000 13EA=0000 13EB=0000");
}

for (const directory of directories) {
  await rm(directory, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\nFAILED: ${failures} assertion(s)`);
  process.exit(1);
}
console.log("\n✓ the audit reader keeps what a hole left behind, names each injury once, and orders newest first");
