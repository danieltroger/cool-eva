import { createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, hkdf } from "crypto";
import type { KeyObject } from "crypto";
import { readdir, readFile, stat } from "fs/promises";
import { basename, join, resolve } from "path";
import { promisify } from "util";
import { gunzip } from "zlib";
import { closeDb, flushNow, initDb, recordReading } from "../src/db.ts";
import { SIGNALS } from "../src/can/registry.ts";

// Laptop-side counterpart to src/storage/encrypted-log.ts. Reads .celog segments
// with the private key and rebuilds an ordinary SQLite file, so Grafana and the
// existing dashboards work against it unchanged.
//
//   node --experimental-strip-types scripts/decrypt-log.ts <dir-or-file…> [--out rides.db]

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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  const outputPath = outIndex === -1 ? "rides.db" : args[outIndex + 1];
  const inputs = args.filter((arg, index) => index !== outIndex && index !== outIndex + 1 && !arg.startsWith("--"));

  if (inputs.length === 0) {
    console.error("usage: decrypt-log.ts <dir-or-file…> [--out rides.db]");
    process.exit(1);
  }

  const keyPath = resolve(process.env.RIDE_LOG_PRIVATE_KEY ?? "ride-log-key.private.pem");
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(await readFile(keyPath, "utf-8"));
  } catch (error) {
    console.error(`Cannot read the private key at ${keyPath}: ${(error as Error).message}`);
    console.error("Without it these logs are unreadable — that is the point. Restore it from your backup.");
    process.exit(1);
  }
  const recipientPublicRaw = createPublicKey(privateKey)
    .export({ type: "spki", format: "der" })
    .subarray(-EPHEMERAL_KEY_BYTES);

  const files = await collectSegmentFiles(inputs);
  if (files.length === 0) {
    console.error("no .celog files found");
    process.exit(1);
  }

  initDb(resolve(outputPath));
  const unitsByKey = new Map(SIGNALS.map(signal => [signal.key, signal]));

  let totalRecords = 0;
  let totalSegments = 0;
  for (const file of files) {
    const { records, segments } = await decryptFile(file, privateKey, recipientPublicRaw);
    for (const record of records) {
      const definition = unitsByKey.get(record.key);
      recordReading(
        record.ts,
        record.key,
        record.value,
        definition?.unit ?? "",
        definition?.group ?? "misc",
        definition?.source ?? "stream"
      );
    }
    flushNow();
    totalRecords += records.length;
    totalSegments += segments;
    console.log(`${basename(file)}: ${segments} segments, ${records.length} readings`);
  }

  closeDb();
  console.log(`\n${totalRecords} readings from ${totalSegments} segments → ${resolve(outputPath)}`);
}

async function collectSegmentFiles(inputs: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const input of inputs) {
    const info = await stat(input);
    if (info.isDirectory()) {
      const entries = await readdir(input);
      files.push(...entries.filter(entry => entry.endsWith(".celog")).map(entry => join(input, entry)));
    } else {
      files.push(input);
    }
  }
  return files.sort();
}

async function decryptFile(
  path: string,
  privateKey: KeyObject,
  recipientPublicRaw: Buffer
): Promise<{ records: DecodedRecord[]; segments: number }> {
  const blob = await readFile(path);
  const records: DecodedRecord[] = [];
  let offset = 0;
  let segments = 0;

  while (offset + HEADER_BYTES <= blob.length) {
    if (!blob.subarray(offset, offset + MAGIC.length).equals(MAGIC)) {
      console.warn(`${basename(path)}: bad magic at byte ${offset} — stopping here`);
      break;
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
      // Expected if the Pi lost power mid-append: the tail segment is partial.
      console.warn(`${basename(path)}: truncated final segment at byte ${offset} — skipping it`);
      break;
    }

    const header = blob.subarray(offset, offset + HEADER_BYTES);
    const ciphertext = blob.subarray(cursor, cursor + ciphertextLength);
    const authTag = blob.subarray(cursor + ciphertextLength, segmentEnd);

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
    try {
      const compressed = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      const body = (await gunzipAsync(compressed)).toString("utf-8");
      for (const line of body.split("\n")) {
        if (line.length === 0) {
          continue;
        }
        const [ts, key, value] = JSON.parse(line) as [number, string, number];
        records.push({ ts, key, value });
      }
      segments += 1;
    } catch (error) {
      // A failed tag means tampering or corruption — report and keep going, so
      // one damaged segment doesn't cost you the rest of the file.
      console.warn(`${basename(path)}: segment at byte ${offset} failed to decrypt: ${(error as Error).message}`);
    }
    offset = segmentEnd;
  }

  return { records, segments };
}

await main();
