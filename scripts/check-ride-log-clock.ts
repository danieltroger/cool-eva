import { execFile } from "child_process";
import {
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPair,
  hkdf,
  randomBytes,
} from "crypto";
import type { KeyObject } from "crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { gunzip, gzip } from "zlib";
import Database from "better-sqlite3";
import { defineSignals, record } from "../src/can/signals.ts";
import { monotonicNow, since } from "../src/monotonic.ts";
import { appendReading, closeEncryptedLog, flushEncryptedLog, initEncryptedLog } from "../src/storage/encrypted-log.ts";
import { startSealOnPark } from "../src/storage/seal-on-park.ts";
import { MAX_RUNS_PER_SEAL, mostPessimistic, splitByTrust } from "../src/storage/trust-runs.ts";
import { MIN_MS_BETWEEN_PARK_SEALS } from "../src/storage/seal-on-park.ts";
import type { ClockTrust } from "../src/gps/clock.ts";

// The ride log against a Pi with no RTC, and the seal that parking buys (#188, #57).
//
//   node --experimental-strip-types scripts/check-ride-log-clock.ts
//
// No bike, no Pi, no local-only files: a throwaway X25519 keypair in a temp directory,
// through the real src/storage/encrypted-log.ts and the real framing.
//
//   §1  splitByTrust is contiguous, ordered and bounded
//   §2  an untrusted reading goes to rides-boot-<session>, a trusted one to rides-<date>
//   §3  a buffer straddling the change seals as TWO segments, each labelled and filed right
//   §4  the header is v3 and carries `trust`; a v2 segment still decodes
//   §5  a failed second run re-queues BOTH runs, in order, and nothing is written twice
//   §6  the park seal fires on an observed entry into state 60, and only then
//   §7  it seals the new rows even when a seal is already in flight
//   §8  the park seal's rate limit is monotonic — a SOURCE assertion, and it says so
//   §9  the real decrypt-log.ts carries the trust into rides.db and rewrites no timestamp
//
// ⚠️ §6 and §7 settle asynchronously — the listener runs in a microtask and the seal is
// async — so they poll to a monotonic deadline rather than sleeping a fixed time. A
// mutation that removes the behaviour fails by timing out, which is slow but never flaky.

const gunzipAsync = promisify(gunzip);
const gzipAsync = promisify(gzip);
const execFileAsync = promisify(execFile);
const hkdfAsync = promisify(hkdf);
const generateKeyPairAsync = promisify(generateKeyPair);

// The framing, restated rather than imported: those constants are not exported, and a check
// that borrowed the producer's own idea of the format could not notice the producer changing
// it. scripts/decrypt-log.ts and scripts/check-ride-log-status.ts keep their own copies too.
const MAGIC = Buffer.from("COOLEVA1");
const EPHEMERAL_KEY_BYTES = 32;
const NONCE_BYTES = 12;
const LENGTH_BYTES = 4;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + EPHEMERAL_KEY_BYTES + NONCE_BYTES + LENGTH_BYTES;
const HKDF_INFO = Buffer.from("cool-eva ride log v1");
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

/** Long enough that a millisecond of gzip and crypto never races it, short enough to notice. */
const SETTLE_DEADLINE_MS = 4_000;

const workDir = await mkdtemp(join(tmpdir(), "cool-eva-ride-log-clock-"));
let failures = 0;
/** What initEncryptedLog is told the clock is worth. Injected, so no real clock is touched. */
let trust: ClockTrust = "satellite-backed";
/**
 * The throwaway recipient keypair, generated once and shared by every section.
 *
 * Up here rather than beside the helpers that use it because `let` does not hoist: the
 * driver below runs at the top level, so a declaration after it is still in its temporal
 * dead zone when the first section calls startLog().
 */
let recipientPrivate: KeyObject | undefined;
let recipientPublicRaw: Buffer | undefined;

function check(what: string, condition: boolean): void {
  if (condition) {
    console.log(`  ✓ ${what}`);
  } else {
    console.error(`  ✗ ${what}`);
    failures += 1;
  }
}

try {
  checkSplitting();
  await checkNaming();
  await checkStraddle();
  await checkHeaderVersions();
  await checkFailedSecondRun();
  await checkParkTrigger();
  await checkParkDuringSeal();
  await checkRateLimitIsMonotonic();
  await checkTrustReachesTheDatabase();
} finally {
  await rm(workDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall ride-log clock checks passed");

/** §1 — the pure part: contiguous runs, order preserved, and a hard cap on how many. */
function checkSplitting(): void {
  console.log("\n§1 splitByTrust is contiguous, ordered and bounded");
  const trustOf = (reading: { trust: ClockTrust }): ClockTrust => reading.trust;

  const straddling = [at("never-synced"), at("never-synced"), at("satellite-backed")];
  const runs = splitByTrust(straddling, trustOf);
  check("a buffer that crosses the boundary once splits into two runs", runs.length === 2);
  check(
    "each run carries its own trust and its own readings",
    runs[0].trust === "never-synced" && runs[0].readings.length === 2 && runs[1].trust === "satellite-backed"
  );

  const uniform = [at("contested"), at("contested")];
  check("a buffer of one trust stays one run", splitByTrust(uniform, trustOf).length === 1);
  check("an empty buffer produces no runs", splitByTrust([], trustOf).length === 0);

  // Flapping trust is what the cap exists for: ../src/gps/clock.ts sets and clears
  // `clockContested` from GPS frames at ~2 Hz from two transports.
  const flapping = [
    at("satellite-backed"),
    at("contested"),
    at("satellite-backed"),
    at("never-synced"),
    at("satellite-backed"),
  ];
  const capped = splitByTrust(flapping, trustOf);
  check(`five alternating runs collapse to ${MAX_RUNS_PER_SEAL} or fewer`, capped.length <= MAX_RUNS_PER_SEAL);
  check("the collapsed run keeps every reading, in order", sameOrder(capped, flapping));
  check(
    "and takes the most pessimistic trust present, so the label can only over-state doubt",
    capped.length === 1 && capped[0].trust === "contested"
  );

  check(
    "contested outranks never-synced, which outranks satellite-backed",
    mostPessimistic(["never-synced", "contested"]) === "contested" &&
      mostPessimistic(["satellite-backed", "never-synced"]) === "never-synced" &&
      mostPessimistic(["satellite-backed"]) === "satellite-backed"
  );
}

/** §2 — an unconfirmed clock must not name a file. */
async function checkNaming(): Promise<void> {
  console.log("\n§2 the file name follows the clock's trust, not the clock");
  const directory = await startLog("naming");

  trust = "never-synced";
  appendReading(Date.now(), "soc", 41, "%", "battery", "stream");
  await flushEncryptedLog();
  trust = "satellite-backed";
  appendReading(Date.now(), "soc", 42, "%", "battery", "stream");
  await flushEncryptedLog();
  trust = "contested";
  appendReading(Date.now(), "soc", 43, "%", "battery", "stream");
  await flushEncryptedLog();
  await closeEncryptedLog();

  const files = (await readdir(directory)).filter(entry => entry.endsWith(".celog")).sort();
  const bootFiles = files.filter(entry => entry.startsWith("rides-boot-"));
  const dayFiles = files.filter(entry => !entry.startsWith("rides-boot-"));
  check(
    "the trusted seal made a day file",
    dayFiles.length === 1 && /^rides-\d{4}-\d{2}-\d{2}\.celog$/.test(dayFiles[0])
  );
  check("both untrusted seals share ONE file named for the run, not one file each", bootFiles.length === 1);
  check("and that name carries no date at all", !/\d{4}-\d{2}-\d{2}/.test(bootFiles[0]));

  const boot = await openAll(join(directory, bootFiles[0]));
  const day = await openAll(join(directory, dayFiles[0]));
  check("the untrusted readings are in the boot file", valuesOf(boot).join() === "41,43");
  check("the trusted reading is in the day file", valuesOf(day).join() === "42");
  check(
    "and each segment says which clock it was written under",
    boot.map(segment => segment.header.trust).join() === "never-synced,contested" &&
      day[0].header.trust === "satellite-backed"
  );
}

/**
 * §3 — the case a seal-time sample gets wrong.
 *
 * Over rides.db's 130 boots the median gap between boot and the clock step is 15.9 s against
 * a 30 s segment timer, so for the median boot EVERY wrongly-stamped reading sits in a
 * segment sealed after the step. One buffer, two clocks, two segments.
 */
async function checkStraddle(): Promise<void> {
  console.log("\n§3 one buffer spanning the clock step seals as two labelled segments");
  const directory = await startLog("straddle");

  trust = "never-synced";
  appendReading(1_000, "soc", 10, "%", "battery", "stream");
  appendReading(1_100, "soc", 11, "%", "battery", "stream");
  trust = "satellite-backed";
  appendReading(1_788_000_000_000, "soc", 12, "%", "battery", "stream");
  await flushEncryptedLog();
  await closeEncryptedLog();

  const files = (await readdir(directory)).filter(entry => entry.endsWith(".celog")).sort();
  check("one seal produced two files", files.length === 2);
  const boot = await openAll(join(directory, files.find(f => f.startsWith("rides-boot-"))!));
  const day = await openAll(join(directory, files.find(f => !f.startsWith("rides-boot-"))!));
  check("the pre-step readings are labelled never-synced", boot[0]?.header.trust === "never-synced");
  check("both of them, not just the first", valuesOf(boot).join() === "10,11");
  check("the post-step reading is labelled satellite-backed", day[0]?.header.trust === "satellite-backed");
  check("and it alone is in the day file", valuesOf(day).join() === "12");
  check(
    "no timestamp was rewritten to make them agree",
    boot.flatMap(s => s.rows).every(row => row[0] < 2_000) && day[0].rows[0][0] === 1_788_000_000_000
  );
  check("seq still orders every reading across the two files", areConsecutive(seqOf([...boot, ...day])));
}

/** §4 — v3 is additive: nothing reads `v`, so an older segment decodes unchanged. */
async function checkHeaderVersions(): Promise<void> {
  console.log("\n§4 the header is v3, and a v2 segment still decodes beside it");
  const directory = await startLog("versions");
  trust = "satellite-backed";
  appendReading(2_000, "soc", 55, "%", "battery", "stream");
  await flushEncryptedLog();
  await closeEncryptedLog();

  const [name] = (await readdir(directory)).filter(entry => entry.endsWith(".celog"));
  const segments = await openAll(join(directory, name));
  check("the version is bumped to 3", segments[0]?.header.v === 3);
  check("and `trust` rides beside `session`, not instead of it", typeof segments[0]?.header.session === "string");

  // A v2 segment, sealed by hand the way the Pi sealed them until today: no `trust` key.
  const legacy = await sealByHand({ v: 2, session: "0123456789abcdef", signals: {} }, [[2_100, "soc", 56, 7]]);
  const mixedPath = join(directory, "mixed.celog");
  await writeFile(mixedPath, Buffer.concat([await readFile(join(directory, name)), legacy]));
  const mixed = await openAll(mixedPath);
  check("both segments open from one file", mixed.length === 2);
  check("the v2 segment's readings survive", valuesOf(mixed).join() === "55,56");
  check(
    "and it reports no trust rather than a good one — unknown is not the same as believed",
    mixed[1].header.trust === undefined
  );
}

/**
 * §5 — the retry, now that a seal has runs behind it.
 *
 * A directory sitting where the day file goes makes the SECOND run fail while the first
 * succeeds: `open(path, "ax")` cannot create a file over a directory. That is the shape the
 * plan review asked for, and the only one that exercises the re-queue.
 */
async function checkFailedSecondRun(): Promise<void> {
  console.log("\n§5 a failed second run re-queues both runs, in order, and writes nothing twice");
  const directory = await startLog("retry");
  const blocked = join(directory, `rides-${new Date().toISOString().slice(0, 10)}.celog`);
  await mkdir(blocked);

  trust = "never-synced";
  appendReading(3_000, "soc", 20, "%", "battery", "stream");
  trust = "satellite-backed";
  appendReading(3_100, "soc", 21, "%", "battery", "stream");
  const failing = flushEncryptedLog();
  // ⚠️ Queued WHILE that seal runs, so it is in the buffer when the re-queue happens.
  // Appending it after the failure instead would make a re-queue that prepends and one that
  // appends produce the same file — an assertion that cannot fail, which is the whole subject
  // of this section.
  appendReading(3_200, "soc", 22, "%", "battery", "stream");
  await failing;

  const afterFailure = (await readdir(directory)).filter(entry => entry.endsWith(".celog"));
  check(
    "the run that could be written was written",
    afterFailure.some(entry => entry.startsWith("rides-boot-"))
  );

  await rm(blocked, { recursive: true });
  await flushEncryptedLog();
  await closeEncryptedLog();

  const segments = await allSegmentsIn(directory);
  check("every reading is present exactly once, and none is missing", areConsecutive(seqOf(segments)));
  const retried = segments.filter(segment => valuesOf([segment]).includes(21));
  check("the re-queued reading and the one buffered behind it share a segment", valuesOf(retried).join() === "21,22");
  check("in the order they were recorded, not the order they were re-queued", isSorted(seqOf(retried)));
  check(
    "and the run that did write keeps the trust it was stamped under",
    segments.some(s => s.header.trust === "never-synced" && valuesOf([s]).join() === "20")
  );
}

/** §6 — the trigger. An entry into parked, observed, and nothing else. */
async function checkParkTrigger(): Promise<void> {
  console.log("\n§6 the park seal fires on an observed entry into state 60, and only then");
  const directory = await startLog("park");
  defineSignals([
    { key: "vehicle_state_can", unit: "", group: "drive", source: "stream" },
    { key: "soc", unit: "%", group: "battery", source: "stream" },
  ]);
  // A monotonic clock this check can move, so the rate limit gets covered without sitting out
  // five real seconds. Never Date.now(): ../src/monotonic.ts, and §8 reads the ban off the code.
  let parkClockMs = monotonicNow();
  const stop = startSealOnPark(() => parkClockMs);
  try {
    // The first sample is whatever the bike was already doing — liveState starts empty after
    // a boot, so a capture that opens on a parked bike must not read as an entry.
    record("vehicle_state_can", 60);
    await settle();
    check("the first sample does not seal, even when it already reads parked", await staysAt(directory, 0));

    record("vehicle_state_can", 40);
    await settle();
    record("soc", 61);
    record("vehicle_state_can", 43);
    await settle();
    check("an unrelated change does not seal", await staysAt(directory, 0));

    record("vehicle_state_can", 60);
    await waitFor(async () => (await sizeOf(directory)) > 0, "the park to seal the buffer");
    // ⚠️ SETTLED, not just non-zero: waitFor returns on the first byte, and stat can catch the
    // append mid-write, so a size read straight after it is a moving target — which then reads
    // as "the second park sealed" when nothing of the sort happened.
    const afterFirstPark = await settledSize(directory);
    check("entering parked seals it", afterFirstPark > 0);
    const sealed = await allSegmentsIn(directory);
    check("and the readings that reached the card are the ones from before the park", valuesOf(sealed).includes(61));

    // The rate limit, behaviourally. §8 reads the monotonic clock off the source and would
    // stay green with the limit neutered to `< 0` or widened to an hour, so without these two
    // the constant has no coverage at all beyond its deletion.
    record("vehicle_state_can", 43);
    await settle();
    record("soc", 62);
    record("vehicle_state_can", 60);
    // ⚠️ A bounded WAIT, not two microtask turns. The seal is async — gzip, crypto, fdatasync —
    // so reading the size straight after the trigger returns the old one whether the rate limit
    // held or not, and the assertion passes for the wrong reason. A mutation neutering the limit
    // to `< 0` survived exactly that. The positive case below lands in single-digit ms.
    check("a second park inside the window does not seal again", await staysAt(directory, afterFirstPark));

    // ⚠️ A LITERAL, never MIN_MS_BETWEEN_PARK_SEALS + 1: an advance derived from the constant
    // under test moves with it, so widening the limit to an hour survived this case too.
    parkClockMs += 10_000;
    record("vehicle_state_can", 43);
    await settle();
    record("vehicle_state_can", 60);
    await waitFor(async () => (await sizeOf(directory)) > afterFirstPark, "the park past the window to seal");
    check("and one past the window does", (await sizeOf(directory)) > afterFirstPark);
    check(
      "the reading queued between the two parks reached the card",
      valuesOf(await allSegmentsIn(directory)).includes(62)
    );
  } finally {
    stop();
    await closeEncryptedLog();
  }
}

/**
 * §7 — the case the second `flushEncryptedLog()` exists for.
 *
 * `sealPendingSegment` returns the seal ALREADY IN FLIGHT rather than starting a new one, so
 * one call landing mid-seal would return that promise and leave everything queued since it
 * began in the buffer — at a park, the approach to the parking spot. The unawaited flush
 * below assigns `activeSeal` synchronously, so this is deterministic rather than a race.
 */
async function checkParkDuringSeal(): Promise<void> {
  console.log("\n§7 a park landing mid-seal still seals the new readings");
  const directory = await startLog("park-during-seal");
  defineSignals([
    { key: "vehicle_state_can", unit: "", group: "drive", source: "stream" },
    { key: "soc", unit: "%", group: "battery", source: "stream" },
  ]);
  const stop = startSealOnPark();
  try {
    record("vehicle_state_can", 40);
    await settle();

    appendReading(4_000, "soc", 70, "%", "battery", "stream");
    const inFlight = flushEncryptedLog();
    // Synchronously, while that seal is running: these are the readings a single flush loses.
    appendReading(4_100, "soc", 71, "%", "battery", "stream");
    record("vehicle_state_can", 60);

    await waitFor(
      async () => valuesOf(await allSegmentsIn(directory)).includes(71),
      "the park seal to write the readings queued during the seal in flight"
    );
    await inFlight;
    const written = valuesOf(await allSegmentsIn(directory));
    check("the reading queued before the seal reached the card", written.includes(70));
    check("and so did the one queued while it ran", written.includes(71));
  } finally {
    stop();
    await closeEncryptedLog();
  }
}

/**
 * §9 — the flag has to reach the thing people query, not just stdout.
 *
 * The subprocess is the point, the same way scripts/check-power-cut-durability.ts §5 runs
 * the tool Daniel actually runs: the reader above is a MIRROR of decrypt-log.ts's framing,
 * and a mirror cannot catch the mirror drifting. A line printed during a twenty-minute
 * decrypt is not something anyone can query; `reading.clock_trust` is.
 */
async function checkTrustReachesTheDatabase(): Promise<void> {
  console.log("\n§9 decrypt-log.ts carries the trust into rides.db and alters no timestamp");
  const directory = await startLog("decrypt");
  const privateKeyPath = join(workDir, "throwaway.private.pem");
  await writeFile(privateKeyPath, recipientPrivate!.export({ type: "pkcs8", format: "pem" }).toString());

  trust = "never-synced";
  appendReading(1_500, "soc", 30, "%", "battery", "stream");
  trust = "satellite-backed";
  appendReading(1_788_000_000_001, "soc", 31, "%", "battery", "stream");
  await flushEncryptedLog();
  await closeEncryptedLog();

  const outputPath = join(workDir, "decrypted.db");
  const decrypted = await execFileAsync(
    process.execPath,
    [
      "--experimental-strip-types",
      new URL("./decrypt-log.ts", import.meta.url).pathname,
      directory,
      "--out",
      outputPath,
    ],
    { env: { ...process.env, RIDE_LOG_PRIVATE_KEY: privateKeyPath } }
  );
  check(
    "it says out loud that some readings were sealed under a clock it cannot vouch for",
    decrypted.stderr.includes("could not be trusted") && decrypted.stderr.includes("never-synced")
  );
  check("and points at the file that holds them", decrypted.stderr.includes("rides-boot-"));

  const db = new Database(outputPath, { readonly: true });
  try {
    const rows = db
      .prepare("SELECT r.ts AS ts, r.value AS value, r.clock_trust AS trust FROM reading r ORDER BY r.seq")
      .all() as { ts: number; value: number; trust: string | null }[];
    check("both readings are in the database", rows.length === 2);
    check("the pre-step one is marked never-synced", rows[0]?.trust === "never-synced");
    check("the post-step one is marked satellite-backed", rows[1]?.trust === "satellite-backed");
    check(
      "and neither timestamp was repaired on the way in",
      rows[0]?.ts === 1_500 && rows[1]?.ts === 1_788_000_000_001
    );
  } finally {
    db.close();
  }
}

/**
 * §8 — read off the CODE, because no behavioural check can reach it.
 *
 * ⚠️ A SOURCE assertion, and labelled as one so nobody records it as a behavioural kill.
 * `Date.now()` and `monotonicNow()` behave identically unless the wall clock moves during
 * the measurement, and nothing here can make that happen — so the only way to catch a
 * duration measured on the clock this process STEPS is to look for it. The same shape
 * scripts/check-arming.ts uses, for the same reason. ../src/monotonic.ts.
 */
async function checkRateLimitIsMonotonic(): Promise<void> {
  console.log("\n§8 the park seal measures its rate limit on the monotonic clock (source assertion)");
  const source = await readFile(new URL("../src/storage/seal-on-park.ts", import.meta.url), "utf-8");
  const code = source
    .split("\n")
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
  check("no Date.now() anywhere in the module's code", !code.includes("Date.now"));
  check("and the clock it defaults to is the monotonic one", code.includes("monotonicNow"));
}

// ---------------------------------------------------------------------------------------
// Fixtures and the reader. The reader walks the framing itself rather than shelling out to
// scripts/decrypt-log.ts, so a change to either is visible from the other side.
// ---------------------------------------------------------------------------------------

interface SegmentHeader {
  v?: number;
  session?: string;
  trust?: string;
  signals?: Record<string, [string, string, string]>;
}

interface OpenedSegment {
  header: SegmentHeader;
  rows: [number, string, number, number][];
}

/** A fresh temp directory with the log pointed at it and the trust provider injected. */
async function startLog(name: string): Promise<string> {
  const directory = join(workDir, name);
  await mkdir(directory, { recursive: true });
  const publicKeyPath = join(directory, "key.public.pem");
  if (!recipientPrivate) {
    const pair = await generateKeyPairAsync("x25519", {});
    recipientPrivate = pair.privateKey;
    recipientPublicRaw = pair.publicKey.export({ type: "spki", format: "der" }).subarray(-EPHEMERAL_KEY_BYTES);
  }
  await writeFile(
    publicKeyPath,
    createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, recipientPublicRaw!]), format: "der", type: "spki" })
      .export({ type: "spki", format: "pem" })
      .toString()
  );
  trust = "satellite-backed";
  const enabled = await initEncryptedLog({
    publicKeyPath,
    directory,
    // An hour, so the periodic timer never fires and every seal is one this check asked for.
    segmentIntervalMs: 3_600_000,
    clockTrust: () => trust,
  });
  if (!enabled) {
    // Unreachable behind the writeFile above, which is why it has to be loud rather than why
    // it can be left out: without it every later assertion fails as "nothing was written".
    failures += 1;
    console.error(`  ✗ initEncryptedLog refused the throwaway key at ${publicKeyPath}`);
  }
  return directory;
}

/** One reading with a trust, for the pure §1 cases. */
function at(reading: ClockTrust): { trust: ClockTrust } {
  return { trust: reading };
}

function sameOrder(runs: { readings: { trust: ClockTrust }[] }[], original: { trust: ClockTrust }[]): boolean {
  const flattened = runs.flatMap(run => run.readings);
  return flattened.length === original.length && flattened.every((reading, index) => reading === original[index]);
}

async function allSegmentsIn(directory: string): Promise<OpenedSegment[]> {
  const names = (await readdir(directory)).filter(entry => entry.endsWith(".celog")).sort();
  const segments: OpenedSegment[] = [];
  for (const name of names) {
    segments.push(...(await openAll(join(directory, name))));
  }
  return segments;
}

async function sizeOf(directory: string): Promise<number> {
  const names = (await readdir(directory)).filter(entry => entry.endsWith(".celog"));
  let bytes = 0;
  for (const name of names) {
    bytes += (await readFile(join(directory, name))).length;
  }
  return bytes;
}

function valuesOf(segments: OpenedSegment[]): number[] {
  return segments.flatMap(segment => segment.rows.map(row => row[2]));
}

function seqOf(segments: OpenedSegment[]): number[] {
  return segments.flatMap(segment => segment.rows.map(row => row[3]));
}

function isSorted(values: number[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1] < value);
}

/**
 * Every value present once, with no gaps.
 *
 * ⚠️ Relative, never against literal seq numbers: `seq` counts readings for the life of the
 * PROCESS, so a section's first reading is not 0 — it is however many the sections before it
 * recorded. An assertion pinned to "0,1,2" passes only while its section runs first.
 */
function areConsecutive(values: number[]): boolean {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted.length > 0 && sorted.every((value, index) => index === 0 || value === sorted[index - 1] + 1);
}

/** Every segment in one file, opened with the throwaway private key. */
async function openAll(path: string): Promise<OpenedSegment[]> {
  const blob = await readFile(path);
  const segments: OpenedSegment[] = [];
  let offset = 0;
  while (offset + HEADER_BYTES <= blob.length) {
    if (!blob.subarray(offset, offset + MAGIC.length).equals(MAGIC)) {
      throw new Error(`${path}: no segment magic at byte ${offset}`);
    }
    let cursor = offset + MAGIC.length;
    const ephemeralRaw = blob.subarray(cursor, cursor + EPHEMERAL_KEY_BYTES);
    cursor += EPHEMERAL_KEY_BYTES;
    const nonce = blob.subarray(cursor, cursor + NONCE_BYTES);
    cursor += NONCE_BYTES;
    const length = blob.readUInt32LE(cursor);
    cursor += LENGTH_BYTES;

    const ephemeralPublicKey = createPublicKey({
      key: Buffer.concat([X25519_SPKI_PREFIX, ephemeralRaw]),
      format: "der",
      type: "spki",
    });
    const shared = diffieHellman({ privateKey: recipientPrivate!, publicKey: ephemeralPublicKey });
    const derived = Buffer.from(
      await hkdfAsync("sha256", shared, Buffer.concat([ephemeralRaw, recipientPublicRaw!]), HKDF_INFO, 32)
    );
    const decipher = createDecipheriv("aes-256-gcm", derived, nonce);
    decipher.setAAD(blob.subarray(offset, offset + HEADER_BYTES));
    decipher.setAuthTag(blob.subarray(cursor + length, cursor + length + TAG_BYTES));
    const body = (
      await gunzipAsync(Buffer.concat([decipher.update(blob.subarray(cursor, cursor + length)), decipher.final()]))
    ).toString("utf-8");

    const lines = body.split("\n").filter(line => line.length > 0);
    segments.push({
      header: JSON.parse(lines[0]) as SegmentHeader,
      rows: lines.slice(1).map(line => JSON.parse(line) as [number, string, number, number]),
    });
    offset = cursor + length + TAG_BYTES;
  }
  return segments;
}

/** Seals a segment with an arbitrary header, so §4 can build the v2 shape the Pi used to write. */
async function sealByHand(header: SegmentHeader, rows: [number, string, number, number][]): Promise<Buffer> {
  const body = [JSON.stringify(header), ...rows.map(row => JSON.stringify(row))].join("\n");
  const compressed = await gzipAsync(Buffer.from(body, "utf-8"));

  const ephemeral = await generateKeyPairAsync("x25519", {});
  const shared = diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: createPublicKey({
      key: Buffer.concat([X25519_SPKI_PREFIX, recipientPublicRaw!]),
      format: "der",
      type: "spki",
    }),
  });
  const ephemeralRaw = ephemeral.publicKey.export({ type: "spki", format: "der" }).subarray(-EPHEMERAL_KEY_BYTES);
  const derived = Buffer.from(
    await hkdfAsync("sha256", shared, Buffer.concat([ephemeralRaw, recipientPublicRaw!]), HKDF_INFO, 32)
  );
  const nonce = randomBytes(NONCE_BYTES);
  const lengthField = Buffer.alloc(LENGTH_BYTES);
  lengthField.writeUInt32LE(compressed.length, 0);
  const segmentHeader = Buffer.concat([MAGIC, ephemeralRaw, nonce, lengthField]);
  const cipher = createCipheriv("aes-256-gcm", derived, nonce);
  cipher.setAAD(segmentHeader);
  const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
  return Buffer.concat([segmentHeader, ciphertext, cipher.getAuthTag()]);
}

/** The directory's size once two consecutive reads agree — i.e. no append is in flight. */
async function settledSize(directory: string): Promise<number> {
  const start = monotonicNow();
  let previous = -1;
  while (since(start) < SETTLE_DEADLINE_MS) {
    const current = await sizeOf(directory);
    if (current === previous) {
      return current;
    }
    previous = current;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  failures += 1;
  console.error(`  ✗ ${directory} never stopped growing`);
  return previous;
}

/** True if the directory is still exactly `bytes` after long enough for a seal to have landed. */
async function staysAt(directory: string, bytes: number): Promise<boolean> {
  const start = monotonicNow();
  while (since(start) < 400) {
    if ((await sizeOf(directory)) !== bytes) {
      return false;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return (await sizeOf(directory)) === bytes;
}

/** Lets queued microtasks and the change listener run. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 4; turn += 1) {
    await Promise.resolve();
  }
}

/**
 * Polls `ready` to a MONOTONIC deadline.
 *
 * A fixed sleep would either be flaky or slow; a deadline fails loudly and names what it was
 * waiting for. monotonicNow(), not Date.now(), because this process is the one that steps the
 * wall clock — ../src/monotonic.ts.
 */
async function waitFor(ready: () => Promise<boolean>, what: string): Promise<void> {
  const start = monotonicNow();
  while (since(start) < SETTLE_DEADLINE_MS) {
    if (await ready()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  failures += 1;
  console.error(`  ✗ timed out after ${SETTLE_DEADLINE_MS} ms waiting for ${what}`);
}
