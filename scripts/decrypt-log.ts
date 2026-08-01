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
        sealed?.source ?? fallback?.source ?? "stream"
      );
    }
    flushNow();
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
  for (const line of body.split("\n")) {
    if (line.length === 0) {
      continue;
    }
    const parsed: unknown = JSON.parse(line);
    if (Array.isArray(parsed)) {
      const [ts, key, value] = parsed as [number, string, number];
      records.push({ ts, key, value });
      continue;
    }
    // Segment header: the signal definitions for the readings that follow.
    const signals = (parsed as { signals?: Record<string, [string, string, SignalSource]> }).signals ?? {};
    for (const [key, [unit, group, source]] of Object.entries(signals)) {
      meta.set(key, { unit, group, source });
    }
  }
}

await main();
