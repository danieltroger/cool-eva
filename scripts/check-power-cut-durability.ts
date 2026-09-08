import { execFile } from "child_process";
import { generateKeyPair } from "crypto";
import { mkdir, mkdtemp, open, readdir, readFile, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { promisify } from "util";
import {
  appendDurably,
  durabilityCounters,
  replaceFileDurably,
  syncDirectory,
  syncFilesystems,
} from "../src/storage/durable.ts";
import { appendReading, closeEncryptedLog, flushEncryptedLog, initEncryptedLog } from "../src/storage/encrypted-log.ts";
import {
  clearPartialSweep,
  loadLatestSweep,
  loadPartialRows,
  openPartialSweepLog,
  writeSnapshot,
} from "../src/vcu/snapshot-store.ts";
import { writeLifetimeRead } from "../src/vcu/lifetime-store.ts";
import { appendAuditRecord, recentAuditRecords } from "../src/vcu/write-audit.ts";
import { loadLatestSnapshot } from "../src/http/vcu-params.ts";
import type { VcuParameterRow } from "../src/vcu/snapshot.ts";

// The five writes this Pi makes, against the power cut it takes every single ride.
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
//
// ⚠️ Four mutations this cannot catch, listed so nobody assumes otherwise. It catches the
// DELETION of a flush, never its misplacement, and it cannot provoke an fsync that fails:
//   1. delete `datasync()` inside flush(), leaving `counters.flushes` beside it
//   2. MOVE flush() to after rename() in replaceFileDurably — the counter still moves
//   3. syncDirectory warning instead of throwing when the FSYNC (not the open) fails
//   4. revert openForAppend's close-on-throw — a handle abandoned when the DIRECTORY
//      flush throws, which needs an fsync failure nothing here can provoke
// 2 and 4 are ordering and cleanup on paths whose failure needs a real EIO to reach. The
// fsync-before-rename ordering in particular is held by code structure and review, NOT by
// anything below — do not read a green run as covering it.

const execFileAsync = promisify(execFile);
const generateKeyPairAsync = promisify(generateKeyPair);

/** The observed shape: a mid-file run of NULs where the kernel never wrote the data back. */
const HOLE_BYTES = 1710;
const SEGMENTS_TO_SEAL = 24;

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
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
  await checkUncoveredWriters();
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

  // A missing DIRECTORY must stay an error — only EEXIST may fall through to a plain open.
  const appendCode = await rejectionCode(() => appendDurably(join(directory, "no-such-dir", "x.log"), "nope\n"));
  check("an append into a missing directory rejects with ENOENT rather than creating it", appendCode === "ENOENT");
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

  const mutant = await observeReplacement(
    join(directory, "mutant.json"),
    oldContent,
    newContent,
    async (target, data) => {
      // The mutant IS origin/main's writer: snapshot-store.ts:201,218 wrote in place.
      await writeFile(target, data, "utf-8");
    }
  );
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
  checkInjuriesTellApart("service-writes.jsonl", audit, "ends mid-record");

  await writeFile(join(directory, "sweep.partial.jsonl"), withHoleAndTornTail(partialLines()), "utf-8");
  const partial = await captureConsole(() => loadPartialRows(directory));
  check(
    "every intact sweep row comes back, keyed by index",
    partial.result.size === 2 && partial.result.get(1)?.status === "read"
  );
  check("the holed row is not silently invented", !partial.result.has(2));
  checkInjuriesTellApart("sweep.partial.jsonl", partial, "ends mid-row");

  const snapshot = JSON.stringify({ readAt: Date.now(), complete: true, micros: [], rows: [] });
  await writeFile(join(directory, "latest.json"), snapshot.slice(0, snapshot.length - 20), "utf-8");
  const truncated = await captureConsole(() => loadLatestSweep(directory));
  check("a truncated latest.json reads as null, so the table gate fails closed", truncated.result === null);
  check(
    "and it says the file could not be READ rather than that it was not a snapshot",
    truncated.warns.some(line => line.includes("could not read the baseline"))
  );
  const page = await captureConsole(() => loadLatestSnapshot(directory));
  check("the page says why rather than 'no sweep has run'", page.result.state === "unreadable");
  check(
    "and it too names the damage rather than staying quiet",
    page.warns.some(line => line.includes("not valid JSON"))
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

  // The fifth writer. ⚠️ A lifetime reading is the least reproducible file this Pi
  // holds: it costs a service stop and someone standing at the bike, and a truncated
  // one reads as null, so the page says "never read" and it is simply gone.
  const stored = await writeLifetimeRead(directory, {
    readAt: Date.now(),
    source: "service",
    replies: [
      { component: 52, payloadHex: "57 01 00 34 05 00 0A 0A C0 03 FA 03 C9 00 11 01 26 64 3A 05", failure: null },
    ],
  });
  const afterLifetime = durabilityCounters();
  check("a lifetime reading is stored at all", stored.stored);
  check("…and flushes the archive and lifetime.json", afterLifetime.flushes - afterSnapshot.flushes === 2);
  check("and the directory once per rename", afterLifetime.directorySyncs - afterSnapshot.directorySyncs === 2);

  // ⚠️ The refused write archives too — snapshot-store.ts rule 1. Refusing to overwrite
  // a good file is right; leaving the refused run's bytes only in a journal line is how
  // #160 lost a set of payloads.
  const refused = await writeLifetimeRead(directory, {
    readAt: Date.now(),
    source: "service",
    replies: [{ component: 52, payloadHex: null, failure: "no-session" }],
  });
  const afterRefused = durabilityCounters();
  check("a zero-answer reading is refused", !refused.stored);
  check("…and its archive is still flushed", afterRefused.flushes - afterLifetime.flushes === 1);
  check("…and the directory that holds it", afterRefused.directorySyncs - afterLifetime.directorySyncs === 1);
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

/**
 * The errno a rejection carried, or undefined if `body` resolved.
 *
 * ⚠️ Every caller asserts the CODE rather than merely that something rejected: a rejection
 * from a step earlier than the one under test would satisfy "it threw" while leaving the
 * assertion after it vacuous.
 */
async function rejectionCode(body: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await body();
    return undefined;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code;
  }
}

/** One append that is guaranteed to fail after the file has been created. */
async function failedAppend(path: string): Promise<void> {
  try {
    await appendDurably(path, undefined as unknown as string);
  } catch {
    // The failure is the point; the caller is measuring what it left behind.
  }
}

/**
 * How many descriptors this process holds. /dev/fd is present on both darwin and Linux;
 * an unreadable one would make the leak assertion vacuous rather than wrong, so it says so.
 */
async function openFileCount(): Promise<number> {
  try {
    return (await readdir("/dev/fd")).length;
  } catch (error) {
    console.warn("could not read /dev/fd, so the descriptor count is not being checked:", error);
    return 0;
  }
}

/**
 * Both halves of "the reader still tells the two injuries apart", named by file.
 *
 * ⚠️ WHERE the reader complained, not just what it returned. A torn tail is a process that
 * was killed; a holed middle is a DAMAGED FILE. A reader that stopped distinguishing them
 * would return exactly the same records, so the log level is the only thing carrying it.
 */
function checkInjuriesTellApart<T>(file: string, capture: ConsoleCapture<T>, tornPhrase: string): void {
  check(
    `${file}: the torn tail is reported as routine`,
    capture.logs.some(line => line.includes(tornPhrase))
  );
  check(
    `${file}: the holed line is reported as damage`,
    capture.warns.some(line => line.includes("is not valid JSON"))
  );
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
      { env: { ...process.env, RIDE_LOG_PRIVATE_KEY: privateKeyPath }, cwd: repoRoot }
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
 * §7 — the writers §1-§4 do not reach.
 *
 * The resume file's own writer, which had no coverage at all, the tidy-up flush after a
 * completed sweep, and two failure behaviours that can actually be provoked: a replace whose
 * rename fails must leave no `.tmp`, and a create whose write fails must already have
 * flushed the directory entry. Every one of these once passed under a mutation.
 */
async function checkUncoveredWriters(): Promise<void> {
  console.log("\n§7 the resume file and the tidy-up flush");
  const directory = join(workDir, "resume");
  await mkdirp(directory);

  const beforeOpen = durabilityCounters();
  const log = await openPartialSweepLog(directory);
  const afterOpen = durabilityCounters();
  check(
    "creating the resume file flushes its directory entry",
    afterOpen.directorySyncs - beforeOpen.directorySyncs === 1
  );
  check("but not the rows yet", afterOpen.flushes - beforeOpen.flushes === 0);

  await log.append(oneReadRow());
  const afterAppend = durabilityCounters();
  check("a row costs no flush at all — the 277-per-sweep argument", afterAppend.flushes - afterOpen.flushes === 0);

  await log.close();
  const afterClose = durabilityCounters();
  check("closing flushes the rows exactly once", afterClose.flushes - afterAppend.flushes === 1);
  check("the row is on disk", (await readFile(join(directory, "sweep.partial.jsonl"), "utf-8")).includes('"index":1'));

  // Reopening an existing resume file must not re-flush the directory entry.
  const reopened = await openPartialSweepLog(directory);
  const afterReopen = durabilityCounters();
  check(
    "reopening an existing resume file does not re-flush the directory",
    afterReopen.directorySyncs - afterClose.directorySyncs === 0
  );
  await reopened.close();

  const beforeClear = durabilityCounters();
  await clearPartialSweep(directory);
  const afterClear = durabilityCounters();
  check("clearing the resume file flushes the removal", afterClear.directorySyncs - beforeClear.directorySyncs === 1);
  check("and the file is gone", !(await exists(join(directory, "sweep.partial.jsonl"))));

  // ⚠️ Covers syncDirectory's OPEN failing, not its fsync failing. The second cannot be
  // provoked on a healthy filesystem, and is gap 3 in the header.
  const syncCode = await rejectionCode(() => syncDirectory(join(directory, "not-a-directory")));
  check("syncDirectory on a missing directory throws rather than warning", syncCode === "ENOENT");

  // ⚠️ A failure AFTER the temporary file exists, which is the only kind whose cleanup can
  // be observed: renaming onto a non-empty directory fails EISDIR, by which point the tmp
  // has been written, flushed and closed. A missing parent would fail at open() instead and
  // would prove nothing, because there would be no tmp to leave behind.
  const blocked = join(directory, "blocked.json");
  await mkdirp(join(blocked, "makes-it-non-empty"));
  const replaceCode = await rejectionCode(() => replaceFileDurably(blocked, "{}\n"));
  check("a replace whose rename fails rejects with EISDIR", replaceCode === "EISDIR");
  check("and removes its temporary file rather than orphaning it", !(await exists(`${blocked}.tmp`)));

  // ⚠️ Fault injection, deliberately: a create that succeeds followed by a write that fails
  // is the case where flushing the directory AFTER the write loses that entry for ever —
  // the retry then takes the EEXIST branch and never flushes it again.
  const halfMade = join(directory, "half-made.log");
  const beforeHalf = durabilityCounters();
  await failedAppend(halfMade);
  const afterHalf = durabilityCounters();
  check(
    "a create whose write then fails still flushed the directory entry",
    afterHalf.directorySyncs - beforeHalf.directorySyncs === 1
  );
  check("and the file it created is there to be appended to", await exists(halfMade));

  // ⚠️ Covers a handle abandoned when the WRITE throws — not the one abandoned when the
  // DIRECTORY FLUSH throws, which needs an fsync failure nothing here can provoke (gap 4 in
  // the header). It is still the right guard to have: one fd every 30 s
  // reaches the default 1024 in about eight hours, a dying card is a PERSISTENT error, and
  // the failure path is where a leak accrues. Counted rather than reasoned about.
  const leakDirectory = join(directory, "leak");
  await mkdirp(leakDirectory);
  for (let index = 0; index < 3; index += 1) {
    await failedAppend(join(leakDirectory, `warm-${index}.log`));
  }
  const openBefore = await openFileCount();
  // Eight, not forty: a real leak is one fd PER call, so eight separates it from noise just
  // as well and costs a fifth of the directory fsyncs.
  for (let index = 0; index < 8; index += 1) {
    await failedAppend(join(leakDirectory, `cold-${index}.log`));
  }
  const openAfter = await openFileCount();
  check(`8 failed creates leak no descriptors (${openBefore} → ${openAfter} open)`, openAfter - openBefore <= 1);
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
