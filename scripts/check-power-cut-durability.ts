import { execFile } from "child_process";
import { generateKeyPair } from "crypto";
import { mkdir, mkdtemp, open, readdir, readFile, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { promisify } from "util";
import {
  appendDurably,
  durabilityCounters,
  replaceFileDurably,
  syncDirectory,
  syncFilesystems,
} from "../src/storage/durable.ts";
import { appendReading, closeEncryptedLog, flushEncryptedLog, initEncryptedLog } from "../src/storage/encrypted-log.ts";
import { loadLatestSweep, loadPartialRows, writeSnapshot } from "../src/vcu/snapshot-store.ts";
import { appendAuditRecord, recentAuditRecords } from "../src/vcu/write-audit.ts";
import { loadLatestSnapshot } from "../src/http/vcu-params.ts";
import type { VcuParameterRow } from "../src/vcu/snapshot.ts";

// The four writes this Pi makes, against the power cut it takes every single ride.
//
//   node --experimental-strip-types scripts/check-power-cut-durability.ts
//
// ⚠️ macOS proves the CODE PATH, not durability: darwin's fsync is not F_FULLFSYNC, so a
// green run here says the calls are made in the right order. The durability claim is an
// ext4-on-Linux claim. docs/power-cuts.md.
//
// §2 is the one with teeth. Holding an fd open across a write distinguishes an in-place
// writeFile from a tmp+rename with no race at all: in-place hands the held reader the new
// bytes through the same inode — the very path by which a cut hands it a hole — while a
// rename leaves that reader on the complete old file and moves the inode.

const execFileAsync = promisify(execFile);
const generateKeyPairAsync = promisify(generateKeyPair);

/** The observed shape: a mid-file run of NULs where the kernel never wrote the data back. */
const HOLE_BYTES = 1710;
const SEGMENTS_TO_SEAL = 24;

const workDir = await mkdtemp(join(tmpdir(), "cool-eva-power-cut-check-"));
let failures = 0;

function check(what: string, condition: boolean): void {
  if (condition) {
    console.log(`  ✓ ${what}`);
  } else {
    console.error(`  ✗ ${what}`);
    failures += 1;
  }
}

try {
  await checkAppendDurably();
  await checkAtomicReplace();
  await checkCrashShapedCorpus();
  await checkCounters();
  await checkHoledRideLog();
  await checkSyncFilesystems();
} finally {
  await rm(workDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall power-cut durability checks passed");

/** §1 — appendDurably is an append, and says whether it created the file. */
async function checkAppendDurably(): Promise<void> {
  console.log("\n§1 appendDurably keeps append semantics");
  const directory = join(workDir, "append");
  await mkdirp(directory);
  const path = join(directory, "log.jsonl");

  const before = durabilityCounters();
  await appendDurably(path, "one\n");
  const afterCreate = durabilityCounters();
  await appendDurably(path, "two\n");
  const afterAppend = durabilityCounters();

  check("content accumulates rather than truncating", (await readFile(path, "utf-8")) === "one\ntwo\n");
  check("the creating call flushes the directory too", afterCreate.directorySyncs - before.directorySyncs === 1);
  check(
    "a later append does not re-flush the directory",
    afterAppend.directorySyncs - afterCreate.directorySyncs === 0
  );
  check("both calls flushed the file", afterAppend.flushes - before.flushes === 2);
  check("nothing failed", afterAppend.failures - before.failures === 0);

  // A missing DIRECTORY must stay an error — only EEXIST may fall through to a plain open.
  let rejected = false;
  try {
    await appendDurably(join(directory, "no-such-dir", "x.log"), "nope\n");
  } catch {
    rejected = true;
  }
  check("an append into a missing directory rejects rather than being created", rejected);
}

/**
 * §2 — the atomicity discriminator, and the mutant it must separate us from.
 *
 * ⚠️ Old and new content are the SAME LENGTH on purpose: the held fd reads that many bytes
 * at offset 0, so a shorter mutant would short-read and turn a clear failure into a
 * confusing one.
 */
async function checkAtomicReplace(): Promise<void> {
  console.log("\n§2 replaceFileDurably swaps the file rather than rewriting it");
  const directory = join(workDir, "atomic");
  await mkdirp(directory);
  const oldContent = `${"OLD".repeat(400)}\n`;
  const newContent = `${"NEW".repeat(400)}\n`;

  const mutant = await observeReplacement(join(directory, "mutant.json"), oldContent, newContent, async (p, data) => {
    // The mutant IS origin/main's writer: snapshot-store.ts:201,218 wrote in place.
    await writeFile(p, data, "utf-8");
  });
  check("MUTANT in-place writeFile: the held reader sees the new bytes", mutant.heldRead === newContent);
  check("MUTANT in-place writeFile: the inode does not change", !mutant.inodeChanged);

  const ours = await observeReplacement(join(directory, "ours.json"), oldContent, newContent, replaceFileDurably);
  check("the held reader still sees the whole OLD file", ours.heldRead === oldContent);
  check("the target's inode changed, so the swap was a rename", ours.inodeChanged);
  check("the new content is on disk", (await readFile(join(directory, "ours.json"), "utf-8")) === newContent);
  check("no .tmp is left behind", !(await exists(join(directory, "ours.json.tmp"))));
}

interface ReplacementObservation {
  heldRead: string;
  inodeChanged: boolean;
}

/** Runs `write` over an existing file while a reader holds the original open. */
async function observeReplacement(
  path: string,
  oldContent: string,
  newContent: string,
  write: (path: string, data: string) => Promise<void>
): Promise<ReplacementObservation> {
  await writeFile(path, oldContent, "utf-8");
  const held = await open(path, "r");
  try {
    const inodeBefore = (await held.stat()).ino;
    await write(path, newContent);
    const buffer = Buffer.alloc(oldContent.length);
    await held.read(buffer, 0, buffer.length, 0);
    return { heldRead: buffer.toString("utf-8"), inodeChanged: (await stat(path)).ino !== inodeBefore };
  } finally {
    await held.close();
  }
}

/**
 * §3 — crash-shaped files through the real readers.
 *
 * The first coverage any of these readers has had: nothing else in scripts/ references
 * recentAuditRecords, loadPartialRows or loadLatestSweep.
 */
async function checkCrashShapedCorpus(): Promise<void> {
  console.log("\n§3 the readers survive the shapes a power cut leaves");
  const directory = join(workDir, "corpus");
  await mkdirp(directory);

  await writeFile(join(directory, "service-writes.jsonl"), withHoleAndTornTail(auditLines()), "utf-8");
  const audit = await captureConsole(() => recentAuditRecords(directory, 50));
  check("every intact audit record comes back", audit.result.length === 2);
  check(
    "the records are newest first",
    audit.result[0]?.status === "ok-last" && audit.result[1]?.status === "ok-first"
  );
  // ⚠️ WHERE the reader complained, not just what it returned. The two injuries mean
  // different things about a motorcycle — a torn tail is a process that was killed, a
  // holed middle is a DAMAGED FILE — and a reader that stopped telling them apart would
  // return exactly the same records. That is what the log level is carrying.
  check(
    "the torn tail is reported as routine",
    audit.logs.some(line => line.includes("ends mid-record"))
  );
  check(
    "the holed line is reported as damage",
    audit.warns.some(line => line.includes("is not valid JSON"))
  );

  await writeFile(join(directory, "sweep.partial.jsonl"), withHoleAndTornTail(partialLines()), "utf-8");
  const partial = await captureConsole(() => loadPartialRows(directory));
  check(
    "every intact sweep row comes back, keyed by index",
    partial.result.size === 2 && partial.result.get(1)?.status === "read"
  );
  check("the holed row is not silently invented", !partial.result.has(2));
  check(
    "the torn tail is reported as routine",
    partial.logs.some(line => line.includes("ends mid-row"))
  );
  check(
    "the holed line is reported as damage",
    partial.warns.some(line => line.includes("is not valid JSON"))
  );

  const snapshot = JSON.stringify({ readAt: Date.now(), complete: true, micros: [], rows: [] });
  await writeFile(join(directory, "latest.json"), snapshot.slice(0, snapshot.length - 20), "utf-8");
  const truncated = await captureConsole(() => loadLatestSweep(directory));
  check("a truncated latest.json reads as null, so the table gate fails closed", truncated.result === null);
  check(
    "and it says the file could not be READ rather than that it was not a snapshot",
    truncated.warns.some(line => line.includes("could not read the baseline"))
  );
  check(
    "the page says why rather than 'no sweep has run'",
    (await loadLatestSnapshot(directory)).state === "unreadable"
  );

  await writeFile(join(directory, "latest.json"), "{}", "utf-8");
  const notASnapshot = await captureConsole(() => loadLatestSweep(directory));
  check("a latest.json that parses but is not a snapshot also reads as null", notASnapshot.result === null);
  check(
    "and that one is reported as the different failure it is",
    notASnapshot.warns.some(line => line.includes("is not a parameter snapshot"))
  );
}

/**
 * §4 — the real writers go through the durable path.
 *
 * ⚠️ Driven through appendAuditRecord and writeSnapshot rather than the helpers directly,
 * because that is the regression worth catching: a CALL SITE reverted to appendFile or
 * writeFile moves no counters and turns this red. Calling the helpers here would only
 * assert that the helpers call themselves.
 *
 * ⚠️ What this canNOT do is prove the syscall happened. Delete the `datasync()` inside
 * flush() and leave the counter beside it and every assertion here still passes — no
 * userspace observation exists for that. The counters prove the durable path was taken,
 * which is a smaller claim than it looks and is stated here so nobody reads it as bigger.
 */
async function checkCounters(): Promise<void> {
  console.log("\n§4 the real writers go through the durable path");
  const directory = join(workDir, "counters");
  await mkdirp(directory);

  const beforeAudit = durabilityCounters();
  await appendAuditRecord(directory, { at: Date.now(), clockTrustworthy: true, action: "rtc-sync", status: "ok" });
  const afterAudit = durabilityCounters();
  check("the audit journal's first record flushes the file", afterAudit.flushes - beforeAudit.flushes === 1);
  check("and the directory that now holds it", afterAudit.directorySyncs - beforeAudit.directorySyncs === 1);

  await appendAuditRecord(directory, { at: Date.now(), clockTrustworthy: true, action: "clear-dtcs", status: "ok" });
  const afterSecond = durabilityCounters();
  check("a second record flushes the file but not the directory again", afterSecond.flushes - afterAudit.flushes === 1);
  check("the directory is left alone", afterSecond.directorySyncs - afterAudit.directorySyncs === 0);

  // Incomplete, so clearPartialSweep's own directory flush stays out of the count — and
  // carrying one READ row, because rule 5 keeps the old latest.json when a run read nothing
  // and the archive would then be the only write.
  await writeSnapshot(directory, {
    readAt: Date.now(),
    complete: false,
    micros: ["A9"],
    rows: [oneReadRow()],
  });
  const afterSnapshot = durabilityCounters();
  check("writing a snapshot flushes the archive and latest.json", afterSnapshot.flushes - afterSecond.flushes === 2);
  check("and the directory once per rename", afterSnapshot.directorySyncs - afterSecond.directorySyncs === 2);
  check("no failures counted on a healthy path", afterSnapshot.failures - beforeAudit.failures === 0);
}

/** The smallest row that counts as a real value, so rule 5 lets latest.json be replaced. */
function oneReadRow(): VcuParameterRow {
  return {
    index: 1,
    identifier: 0x1001,
    micro: "A9",
    name: null,
    section: null,
    type: null,
    signed: null,
    status: "read",
    rawHex: "0001",
    unsigned: 1,
    value: 1,
    widthMismatch: false,
    otherBikeValue: null,
    note: null,
  };
}

interface ConsoleCapture<T> {
  result: T;
  logs: string[];
  warns: string[];
}

/**
 * Runs `body` with console.log/console.warn collected rather than printed.
 *
 * Restored in a `finally`: leaving them replaced would silently swallow every later
 * check() line, which is the one failure mode a test helper must not have.
 */
async function captureConsole<T>(body: () => Promise<T>): Promise<ConsoleCapture<T>> {
  const logs: string[] = [];
  const warns: string[] = [];
  const realLog = console.log;
  const realWarn = console.warn;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.warn = (...args: unknown[]) => warns.push(args.map(String).join(" "));
  try {
    return { result: await body(), logs, warns };
  } finally {
    console.log = realLog;
    console.warn = realWarn;
  }
}

/**
 * §5 — a real .celog with a real hole, through the real reader.
 *
 * The subprocess is the point: scripts/check-ride-log-status.ts:757 carries a MIRRORED copy
 * of decrypt-log.ts's openSegment(), and a mirror cannot catch the mirror drifting. This
 * runs the tool Daniel actually runs. It is also the only section that would notice
 * appendDurably breaking the framing outright — an accidental "w" flag would cost a day.
 *
 * ⚠️ decrypt-log.ts:124 exits 2 whenever it skipped a segment, which is exactly what this
 * check causes on purpose, so a non-zero exit here is the success path.
 */
async function checkHoledRideLog(): Promise<void> {
  console.log("\n§5 a holed ride log loses only the segments inside the hole");
  const directory = join(workDir, "ride-log");
  await mkdirp(directory);

  const pair = await generateKeyPairAsync("x25519", {});
  const privateKeyPath = join(workDir, "throwaway.private.pem");
  const publicKeyPath = join(workDir, "throwaway.public.pem");
  await writeFile(privateKeyPath, pair.privateKey.export({ type: "pkcs8", format: "pem" }));
  await writeFile(publicKeyPath, pair.publicKey.export({ type: "spki", format: "pem" }));

  const enabled = await initEncryptedLog({ publicKeyPath, directory, segmentIntervalMs: 3_600_000 });
  if (!enabled) {
    check("initEncryptedLog accepted the throwaway key", false);
    return;
  }
  // One reading per segment, and the file size after each seal, so the check knows exactly
  // which byte range belongs to which segment rather than assuming a segment size.
  const segmentEnds: number[] = [];
  let path = "";
  for (let index = 0; index < SEGMENTS_TO_SEAL; index += 1) {
    appendReading(Date.now(), "coolant_in", 20 + index, "°C", "cooling", "sensor");
    await flushEncryptedLog();
    if (!path) {
      const [name] = (await readdir(directory)).filter(entry => entry.endsWith(".celog"));
      if (!name) {
        check("the seals landed in a .celog file", false);
        await closeEncryptedLog();
        return;
      }
      path = join(directory, name);
    }
    segmentEnds.push((await stat(path)).size);
  }
  await closeEncryptedLog();

  const intact = await readFile(path);
  // A third of the way in, so there are whole segments on BOTH sides of it — a hole running
  // off the end would only prove the reader gives up, not that it comes back.
  const holeStart = Math.floor(intact.length / 3);
  const holeEnd = Math.min(holeStart + HOLE_BYTES, intact.length);
  const damaged = Buffer.from(intact);
  damaged.fill(0, holeStart, holeEnd);
  await writeFile(path, damaged);

  // A segment survives exactly when its bytes do not meet the hole. That is the resync
  // contract, stated over the real byte ranges rather than an assumed segment size.
  const survivors = segmentEnds.filter((end, index) => {
    const start = index === 0 ? 0 : segmentEnds[index - 1];
    return start >= holeEnd || end <= holeStart;
  }).length;
  check("the hole leaves whole segments on both sides", survivors > 0 && survivors < SEGMENTS_TO_SEAL);

  const report = await decryptLog(directory, privateKeyPath, join(workDir, "holed.db"));
  check("the reader reported skipped segments rather than failing outright", report.skipped > 0);
  check(
    `every segment outside the hole was recovered (${survivors} of ${SEGMENTS_TO_SEAL})`,
    report.segments === survivors
  );
  check("and one reading came back per recovered segment", report.records === survivors);
  // The number goes in docs/power-cuts.md and the PR body, not into an equality assertion —
  // an exact reading count would be a tripwire for any future deadband or gzip change.
  console.log(
    `    measured: a ${HOLE_BYTES}-byte hole at byte ${holeStart} of ${intact.length} cost ` +
      `${SEGMENTS_TO_SEAL - survivors} of ${SEGMENTS_TO_SEAL} segments; ${report.records} readings recovered`
  );
}

interface DecryptReport {
  segments: number;
  skipped: number;
  records: number;
}

/** Runs scripts/decrypt-log.ts the way Daniel runs it, and reads its own numbers back. */
async function decryptLog(directory: string, privateKeyPath: string, outPath: string): Promise<DecryptReport> {
  let stdout = "";
  let stderr = "";
  try {
    const result = await execFileAsync(
      process.execPath,
      ["--experimental-strip-types", "scripts/decrypt-log.ts", directory, "--out", outPath],
      { env: { ...process.env, RIDE_LOG_PRIVATE_KEY: privateKeyPath }, cwd: repoRoot() }
    );
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    // Exit 2 IS the expected path here: it is what the tool returns when it skipped
    // segments, which this check plants a hole to cause.
    const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
    if (failure.code !== 2) {
      throw error;
    }
    stdout = failure.stdout ?? "";
    stderr = failure.stderr ?? "";
  }
  const summary = /(\d+) readings from (\d+) segments/.exec(stdout);
  const skipped = /(\d+) segment\(s\) could not be decrypted/.exec(stderr);
  return {
    records: summary ? Number(summary[1]) : 0,
    segments: summary ? Number(summary[2]) : 0,
    skipped: skipped ? Number(skipped[1]) : 0,
  };
}

/** §6 — the flush that runs before the service restart. */
async function checkSyncFilesystems(): Promise<void> {
  console.log("\n§6 syncFilesystems reports rather than throws");
  check("a real sync() reports no failure", (await syncFilesystems()) === null);
  const failure = await syncFilesystems("cool-eva-definitely-not-a-command");
  check("a missing command comes back as a sentence, not a throw", typeof failure === "string");
  check("the sentence names the command", (failure ?? "").includes("cool-eva-definitely-not-a-command"));
}

/**
 * Punches the observed injury into a file: a NUL run over one whole middle line, then a
 * torn last line. Both are what a cut leaves behind — the NULs are the unwritten-back
 * blocks, the torn tail is the append that was still in flight.
 *
 * ⚠️ The run covers the MIDDLE LINE exactly, not the byte midpoint. A hole placed by byte
 * offset straddles two lines and costs a second record, which makes the assertion below
 * about arithmetic rather than about the reader.
 */
function withHoleAndTornTail(lines: string[]): string {
  const buffer = Buffer.from(lines.join(""), "utf-8");
  const middle = Math.floor(lines.length / 2);
  const start = Buffer.byteLength(lines.slice(0, middle).join(""), "utf-8");
  // Up to the newline, so the line structure around the hole is untouched.
  buffer.fill(0, start, start + Buffer.byteLength(lines[middle], "utf-8") - 1);
  return `${buffer.toString("utf-8")}{"at":1757000000000,"torn":`;
}

function auditLines(): string[] {
  return [
    `${JSON.stringify({ at: 1, clockTrustworthy: true, action: "parameter-write", status: "ok-first" })}\n`,
    `${JSON.stringify({ at: 2, clockTrustworthy: true, action: "clear-dtcs", status: "swallowed-by-the-hole" })}\n`,
    `${JSON.stringify({ at: 3, clockTrustworthy: true, action: "rtc-sync", status: "ok-last" })}\n`,
  ];
}

function partialLines(): string[] {
  return [
    `${JSON.stringify({ at: 1, index: 1, status: "read" })}\n`,
    `${JSON.stringify({ at: 2, index: 2, status: "swallowed-by-the-hole" })}\n`,
    `${JSON.stringify({ at: 3, index: 3, status: "read" })}\n`,
  ];
}

async function mkdirp(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
}

/** Absence is the answer here, so ENOENT is a result and anything else is a real problem. */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`could not stat ${path}:`, error);
    }
    return false;
  }
}

function repoRoot(): string {
  return dirname(dirname(new URL(import.meta.url).pathname));
}
