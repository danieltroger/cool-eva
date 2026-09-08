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
// ⚠️ WHAT THE NUL CASES DO AND DO NOT PROVE. A line of 1 710 NUL bytes appeared in the Pi's
// journal after a power cut. On the OLD reader it reached JSON.parse and warned with a
// SyntaxError and a stack trace, on every GET and every POST to /vcu-write, about a line
// whose NULs the error message renders as spaces. It is still a WARNING here — a hole is a
// damaged file and a torn tail is not, and the level is what carries that
// (check-power-cut-durability.ts §3) — but it names the injury and carries no stack trace.
// The RECORDS AND THEIR COUNT ARE IDENTICAL EITHER WAY, so the only assertions that change
// colour are about what was said, and nothing here recovers anything: 1 710 NUL bytes are
// not a record. The mechanism, measured: docs/power-cuts.md — #164 fixed the WRITER so no
// new hole is punched, which does not repair the file that already has one.

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
console.log("     the audit journal's reader: blank lines, NUL holes, damaged lines, order and limit");

const directory = await mkdtemp(join(tmpdir(), "cool-eva-audit-"));
const NUL_LINE = "\0".repeat(1710);

// ── 1. Blank and whitespace-only lines are skipped, and everything else survives ──────
{
  const text = [line({ at: 1 }), "", line({ at: 2 }), "   ", "\t", line({ at: 3 }), ""].join("\n");
  await writeFile(join(directory, "service-writes.jsonl"), text, "utf-8");
  const { records, warned } = await readCapturing(directory, 10);
  check("three records survive four blank or whitespace-only lines", records.length === 3);
  check("newest first", records[0].at === 3 && records[2].at === 1);
  check("nothing is warned about a blank line", warned.length === 0);
}

// ── 2. A NUL-only line MID-FILE — the 2026-09-08 artifact, at its real size ───────────
{
  const before = [line({ at: 1 }), line({ at: 2 })];
  const after = [line({ at: 3 }), line({ at: 4 })];
  await writeFile(join(directory, "service-writes.jsonl"), [...before, NUL_LINE, ...after].join("\n"), "utf-8");
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

// ── 3. Read three times, the noise is three lines and not three stack traces ──────────
{
  const { warned, logged } = await readCapturing(directory, 10, 3);
  // The journal is read on every GET and POST to /vcu-write (write-runner.ts's status()),
  // so a stack trace per damaged line is a stack trace per request.
  // The COUNT is this section's claim; §2 already proved the wording over the same bytes.
  check("three reads name the hole three times", warned.filter(entry => entry.includes("NUL bytes")).length === 3);
}

// ── 4. A NUL-only LAST line — a torn append that landed in a hole ─────────────────────
{
  await writeFile(join(directory, "service-writes.jsonl"), [line({ at: 1 }), NUL_LINE].join("\n"), "utf-8");
  const { records, warned } = await readCapturing(directory, 10);
  check("the record before a trailing NUL hole survives", records.length === 1 && records[0].at === 1);
  check(
    "and a trailing hole is damage too — a hole is not a torn tail",
    warned.some(e => e.includes("NUL bytes"))
  );
}

// ── 5. THE FENCE: NULs plus real content stay a damaged line ──────────────────────────
{
  // ⚠️ This is what stops the fix widening into "skip anything that will not parse". A line
  // with bytes in it lost a record that partly survived, and that is worth a warning.
  const damaged = `${"\0".repeat(40)}{"at":2,"action":"clear-dtcs"`;
  await writeFile(
    join(directory, "service-writes.jsonl"),
    [line({ at: 1 }), damaged, line({ at: 3 })].join("\n"),
    "utf-8"
  );
  const { records, warned, logged } = await readCapturing(directory, 10);
  check("the readable records around a part-NUL line are returned", records.length === 2);
  check(
    "a part-NUL line is still reported as damaged",
    warned.some(entry => entry.includes("not valid JSON"))
  );
  check(
    "and is NOT counted as a hole",
    warned.every(entry => !entry.includes("NUL bytes"))
  );
}

// ── 6. Ordinary corruption still warns; a torn LAST line does not ─────────────────────
{
  await writeFile(
    join(directory, "service-writes.jsonl"),
    [line({ at: 1 }), "{not json at all", line({ at: 3 })].join("\n"),
    "utf-8"
  );
  const { records, warned } = await readCapturing(directory, 10);
  check("a damaged mid-file line costs only itself", records.length === 2);
  check(
    "and it is warned about, with its line number",
    warned.some(entry => entry.includes("line 2"))
  );

  await writeFile(join(directory, "service-writes.jsonl"), [line({ at: 1 }), '{"at":2,"acti'].join("\n"), "utf-8");
  const torn = await readCapturing(directory, 10);
  check("a torn last line costs only itself", torn.records.length === 1);
  check(
    "a torn last line is logged, not warned",
    torn.warned.length === 0 && torn.logged.some(e => e.includes("mid-record"))
  );
}

// ── 7. The limit, and a journal that is not there ─────────────────────────────────────
{
  const many = Array.from({ length: 20 }, (_, index) => line({ at: index + 1 }));
  await writeFile(join(directory, "service-writes.jsonl"), many.join("\n"), "utf-8");
  const records = await recentAuditRecords(directory, 5);
  check(
    "the limit slices the NEWEST records, not the oldest",
    records.length === 5 && records[0].at === 20 && records[4].at === 16
  );

  const empty = await mkdtemp(join(tmpdir(), "cool-eva-audit-none-"));
  const absent = await readCapturing(empty, 5);
  check("a journal that does not exist reads as no records", absent.records.length === 0);
  check("and ENOENT is not warned about — an absent journal is not an unreadable one", absent.warned.length === 0);
  await rm(empty, { recursive: true, force: true });
}

// ── 8. Round trip, and the stamp read's own record ────────────────────────────────────
{
  const fresh = await mkdtemp(join(tmpdir(), "cool-eva-audit-rt-"));
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
  await rm(fresh, { recursive: true, force: true });
}

await rm(directory, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\nFAILED: ${failures} assertion(s)`);
  process.exit(1);
}
console.log("\n✓ the audit reader skips holes, keeps damage loud, and orders newest first");
