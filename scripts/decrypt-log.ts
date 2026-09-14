import { createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, hkdf } from "crypto";
import type { KeyObject } from "crypto";
import { access, readdir, readFile, stat } from "fs/promises";
import { basename, join, resolve } from "path";
import { promisify } from "util";
import { gunzip } from "zlib";
import { closeDb, flushNow, initDb, recordReading } from "../src/db.ts";
import { SIGNALS } from "../src/can/registry.ts";
import type { SignalSource } from "../src/db.ts";

// Laptop-side counterpart to src/storage/encrypted-log.ts. Reads .celog segments
// with the private key and rebuilds an ordinary SQLite file, so Grafana and the
// existing dashboards work against it unchanged.
//
//   node --experimental-strip-types scripts/decrypt-log.ts <dir-or-file…> [--out rides.db] [--force]
//
// Accepts either the ride-logs/ directory off the Pi or a single blob from
// GET /dl (which is every day file concatenated — segments are self-framing, so
// that parses the same way).

const gunzipAsync = promisify(gunzip);
const hkdfAsync = promisify(hkdf);

const MAGIC = Buffer.from("COOLEVA1");
const EPHEMERAL_KEY_BYTES = 32;
const NONCE_BYTES = 12;
const LENGTH_BYTES = 4;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + EPHEMERAL_KEY_BYTES + NONCE_BYTES + LENGTH_BYTES;
const HKDF_INFO = Buffer.from("cool-eva ride log v1");

// DER prefix for an X25519 SubjectPublicKeyInfo; the raw 32 bytes follow it.
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

interface DecodedRecord {
  ts: number;
  key: string;
  value: number;
  /** Undefined for v1 segments, sealed before the write-order counter existed. */
  session?: string;
  seq?: number;
  /**
   * What the Pi's clock was worth when `ts` was taken, from the v3 segment header.
   * Undefined for v1/v2 segments — unknown, which is not the same as good.
   */
  clockTrust?: string;
}

interface SignalMeta {
  unit: string;
  group: string;
  source: SignalSource;
}

interface FileResult {
  records: DecodedRecord[];
  meta: Map<string, SignalMeta>;
  segments: number;
  skipped: number;
}

/**
 * What the clock was worth, as the segment headers reported it. `undefined` collapses to
 * "unrecorded" so a v1/v2 file is counted rather than quietly read as trustworthy.
 */
const UNRECORDED = "unrecorded";

async function main(): Promise<void> {
  const { inputs, outputPath, force } = parseArgs(process.argv.slice(2));

  const keyPath = resolve(process.env.RIDE_LOG_PRIVATE_KEY ?? "ride-log-key.private.pem");
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(await readFile(keyPath, "utf-8"));
  } catch (error) {
    fail(
      `Cannot read the private key at ${keyPath}: ${(error as Error).message}\n` +
        "Without it these logs are unreadable — that is the point. Restore it from your backup."
    );
  }
  const recipientPublicRaw = createPublicKey(privateKey!)
    .export({ type: "spki", format: "der" })
    .subarray(-EPHEMERAL_KEY_BYTES);

  // `reading` has no uniqueness constraint, so decrypting into an existing file
  // would silently double the history — and --out temperatures.db would append
  // into a pre-encryption archive rather than replacing it.
  if (!force && (await exists(outputPath))) {
    fail(`${resolve(outputPath)} already exists. Delete it, choose another --out, or pass --force to append.`);
  }

  const files = await collectSegmentFiles(inputs);
  if (files.length === 0) {
    fail("no .celog files found");
  }

  initDb(resolve(outputPath));
  const registryByKey = new Map(SIGNALS.map(signal => [signal.key, signal]));

  let totalRecords = 0;
  let totalSegments = 0;
  let totalSkipped = 0;
  const suspectByFile = new Map<string, Map<string, number>>();
  for (const file of files) {
    const result = await decryptFile(file, privateKey!, recipientPublicRaw);
    for (const record of result.records) {
      // Prefer the metadata sealed alongside the readings — the registry may
      // have been renamed since, and this log is the only copy of the data.
      const sealed = result.meta.get(record.key);
      const fallback = registryByKey.get(record.key);
      recordReading(
        record.ts,
        record.key,
        record.value,
        sealed?.unit ?? fallback?.unit ?? "",
        sealed?.group ?? fallback?.group ?? "misc",
        sealed?.source ?? fallback?.source ?? "stream",
        record.session,
        record.seq,
        record.clockTrust
      );
    }
    flushNow();
    const suspect = countSuspectReadings(result.records);
    if (suspect.size > 0) {
      suspectByFile.set(basename(file), suspect);
    }
    totalRecords += result.records.length;
    totalSegments += result.segments;
    totalSkipped += result.skipped;
    console.log(
      `${basename(file)}: ${result.segments} segments, ${result.records.length} readings` +
        (result.skipped > 0 ? `, ${result.skipped} UNREADABLE` : "")
    );
  }

  closeDb();
  console.log(`\n${totalRecords} readings from ${totalSegments} segments → ${resolve(outputPath)}`);
  reportClockTrust(suspectByFile);
  if (totalSkipped > 0) {
    console.error(`\n${totalSkipped} segment(s) could not be decrypted — that data is lost, the rest is intact.`);
    process.exit(2);
  }
}

function parseArgs(args: string[]): { inputs: string[]; outputPath: string; force: boolean } {
  const inputs: string[] = [];
  let outputPath = "rides.db";
  let force = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--force") {
      force = true;
    } else if (arg === "--out") {
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--")) {
        fail("--out needs a filename");
      }
      outputPath = next;
      index += 1;
    } else if (arg.startsWith("--")) {
      fail(`unknown option ${arg}`);
    } else {
      inputs.push(arg);
    }
  }

  if (inputs.length === 0) {
    fail("usage: decrypt-log.ts <dir-or-file…> [--out rides.db] [--force]");
  }
  return { inputs, outputPath, force };
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function collectSegmentFiles(inputs: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const input of inputs) {
    let info;
    try {
      info = await stat(input);
    } catch (error) {
      fail(`cannot read ${input}: ${(error as Error).message}`);
    }
    if (info!.isDirectory()) {
      const entries = await readdir(input);
      files.push(...entries.filter(entry => entry.endsWith(".celog")).map(entry => join(input, entry)));
    } else {
      files.push(input);
    }
  }
  return files.sort();
}

async function decryptFile(path: string, privateKey: KeyObject, recipientPublicRaw: Buffer): Promise<FileResult> {
  const blob = await readFile(path);
  const records: DecodedRecord[] = [];
  const meta = new Map<string, SignalMeta>();
  let offset = 0;
  let segments = 0;
  let skipped = 0;

  // Every segment is independently sealed, so damage is always recoverable-past:
  // on ANY failure we scan forward to the next MAGIC rather than giving up. That
  // matters most for a /dl download, where all the day files are concatenated —
  // a half-written segment in the middle would otherwise discard every later day.
  while (offset >= 0 && offset + HEADER_BYTES <= blob.length) {
    if (!blob.subarray(offset, offset + MAGIC.length).equals(MAGIC)) {
      skipped += 1;
      offset = resync(blob, offset, path, "bad magic");
      continue;
    }
    let cursor = offset + MAGIC.length;
    const ephemeralRaw = blob.subarray(cursor, cursor + EPHEMERAL_KEY_BYTES);
    cursor += EPHEMERAL_KEY_BYTES;
    const nonce = blob.subarray(cursor, cursor + NONCE_BYTES);
    cursor += NONCE_BYTES;
    const ciphertextLength = blob.readUInt32LE(cursor);
    cursor += LENGTH_BYTES;

    const segmentEnd = cursor + ciphertextLength + TAG_BYTES;
    if (segmentEnd > blob.length) {
      // The tail was cut off — expected if the Pi lost power mid-append.
      console.warn(`${basename(path)}: truncated segment at byte ${offset} — skipping it`);
      skipped += 1;
      offset = resync(blob, offset, path, "truncated");
      continue;
    }

    const header = blob.subarray(offset, offset + HEADER_BYTES);
    const ciphertext = blob.subarray(cursor, cursor + ciphertextLength);
    const authTag = blob.subarray(cursor + ciphertextLength, segmentEnd);

    try {
      const body = await openSegment(privateKey, recipientPublicRaw, ephemeralRaw, nonce, header, ciphertext, authTag);
      readBody(body, records, meta);
      segments += 1;
      offset = segmentEnd;
    } catch (error) {
      // A failed tag means tampering, corruption, or a length field that lied
      // and swallowed part of the next segment. Resync rather than trust it.
      console.warn(`${basename(path)}: segment at byte ${offset} failed to decrypt: ${(error as Error).message}`);
      skipped += 1;
      offset = resync(blob, offset, path, "auth failure");
    }
  }

  return { records, meta, segments, skipped };
}

/** Next plausible segment start after a damaged one, or -1 if there is none. */
function resync(blob: Buffer, offset: number, path: string, reason: string): number {
  const next = blob.indexOf(MAGIC, offset + 1);
  if (next === -1) {
    console.warn(`${basename(path)}: ${reason} at byte ${offset}, no further segments`);
  } else {
    console.warn(`${basename(path)}: ${reason} at byte ${offset}, resyncing at ${next}`);
  }
  return next;
}

async function openSegment(
  privateKey: KeyObject,
  recipientPublicRaw: Buffer,
  ephemeralRaw: Buffer,
  nonce: Buffer,
  header: Buffer,
  ciphertext: Buffer,
  authTag: Buffer
): Promise<string> {
  const ephemeralPublicKey = createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, ephemeralRaw]),
    format: "der",
    type: "spki",
  });
  const sharedSecret = diffieHellman({ privateKey, publicKey: ephemeralPublicKey });
  const salt = Buffer.concat([ephemeralRaw, recipientPublicRaw]);
  const derived = Buffer.from(await hkdfAsync("sha256", sharedSecret, salt, HKDF_INFO, 32));

  const decipher = createDecipheriv("aes-256-gcm", derived, nonce);
  decipher.setAAD(header);
  decipher.setAuthTag(authTag);
  const compressed = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return (await gunzipAsync(compressed)).toString("utf-8");
}

function readBody(body: string, records: DecodedRecord[], meta: Map<string, SignalMeta>): void {
  // Which run of the Pi wrote the lines that follow. Set by each segment header, so
  // it has to be tracked across lines rather than read once per file: one .celog is
  // a day's worth of segments and a reboot mid-day starts a new session in the same
  // file. Undefined until a header says otherwise, which is what a v1 segment does.
  let session: string | undefined;
  // Same treatment for the clock the readings were stamped under (v3+). Tracked per
  // segment rather than per file because the Pi's clock steps mid-boot: that is the whole
  // subject, and a file holds segments from either side of the step.
  let clockTrust: string | undefined;
  for (const line of body.split("\n")) {
    if (line.length === 0) {
      continue;
    }
    const parsed: unknown = JSON.parse(line);
    if (Array.isArray(parsed)) {
      // Four elements since v2; a v1 line has three and leaves seq undefined, which
      // is stored as NULL rather than guessed at.
      const [ts, key, value, seq] = parsed as [number, string, number, number?];
      records.push({ ts, key, value, session, seq, clockTrust });
      continue;
    }
    // Segment header: the signal definitions for the readings that follow, and from
    // v2 the session that wrote them.
    const header = parsed as {
      session?: string;
      trust?: string;
      signals?: Record<string, [string, string, SignalSource]>;
    };
    session = header.session;
    clockTrust = header.trust;
    for (const [key, [unit, group, source]] of Object.entries(header.signals ?? {})) {
      meta.set(key, { unit, group, source });
    }
  }
}

/**
 * How many readings in this file were sealed under a clock that could not be believed.
 *
 * Keyed on the header's own word, so a state added later is counted rather than dropped.
 */
function countSuspectReadings(records: DecodedRecord[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const record of records) {
    const trust = record.clockTrust ?? UNRECORDED;
    if (trust === "satellite-backed") {
      continue;
    }
    counts.set(trust, (counts.get(trust) ?? 0) + 1);
  }
  return counts;
}

/**
 * Says which readings carry a timestamp nothing supports, and how to recover the real one.
 *
 * ⚠️ Reports rather than repairs. `ts` stays exactly as the Pi wrote it: forcing timestamps
 * to agree would recover ordering by destroying time, which src/storage/encrypted-log.ts
 * argues at length and is why `seq` exists. The offset IS recoverable — `gps_epoch_s` is
 * logged raw against each row's own wrong stamp — and the recipe is in
 * docs/ride-log-clock.md, validated on 40 of 40 stepped sessions to within 1.54 s.
 */
function reportClockTrust(suspectByFile: Map<string, Map<string, number>>): void {
  if (suspectByFile.size === 0) {
    return;
  }
  let unrecorded = 0;
  let untrusted = 0;
  for (const counts of suspectByFile.values()) {
    for (const [trust, count] of counts) {
      if (trust === UNRECORDED) {
        unrecorded += count;
      } else {
        untrusted += count;
      }
    }
  }
  if (untrusted > 0) {
    console.warn(`\n⚠️  ${untrusted} reading(s) were sealed while the Pi's clock could not be trusted.`);
  }
  if (unrecorded > 0) {
    // ⚠️ Not folded into the line above. Every segment sealed before 2026-09-14 predates the
    // field, so on the existing archive that count is in the millions — and a warning that
    // fires on the whole corpus is one nobody reads by the third run. Unknown is not the same
    // as good, but it is not the same as bad either.
    console.warn(`\n${unrecorded} further reading(s) predate the clock-trust field — nothing is known either way.`);
  }
  console.warn("   Their `ts` is whatever the clock said and is NOT corrected here; `seq` still orders them.");
  console.warn("   Recovering the real time: docs/ride-log-clock.md. In rides.db: reading.clock_trust.");
  for (const [file, counts] of suspectByFile) {
    const detail = [...counts].map(([trust, count]) => `${count} ${trust}`).join(", ");
    console.warn(`   ${file}: ${detail}`);
  }
}

await main();
