import { createCipheriv, diffieHellman, generateKeyPair, hkdf, randomBytes, createPublicKey } from "crypto";
import type { KeyObject } from "crypto";
import { appendFile, mkdir, readFile } from "fs/promises";
import { join } from "path";
import { promisify } from "util";
import { gzip } from "zlib";

// Write-only ride log: the Pi holds ONLY a public key, so it can append history
// it can never read back. A stolen bike yields an SD card full of ciphertext —
// no route history, no home address, no key-fob ID. Decryption needs the private
// key, which lives on the laptop and nowhere else.
//
// Hybrid encryption, because public-key crypto can't encrypt bulk data directly:
// each segment gets a fresh ephemeral X25519 keypair, ECDH against the recipient
// public key, HKDF-SHA256 to an AES-256-GCM key. The ephemeral private key is
// discarded immediately, so each segment is independently sealed — compromising
// the Pi cannot retroactively decrypt anything already written.
//
// Segments are self-framing and appended whole, so a power cut mid-write costs
// at most the current buffer and leaves earlier segments readable.

const generateKeyPairAsync = promisify(generateKeyPair);
const hkdfAsync = promisify(hkdf);
const gzipAsync = promisify(gzip);

const MAGIC = Buffer.from("COOLEVA1");
const EPHEMERAL_KEY_BYTES = 32;
const NONCE_BYTES = 12;
const LENGTH_BYTES = 4;
const HKDF_INFO = Buffer.from("cool-eva ride log v1");

export interface EncryptedLogOptions {
  /** PEM file holding the recipient (laptop) X25519 public key. */
  publicKeyPath: string;
  /** Directory for the .celog segment files. */
  directory: string;
  /** How often to seal and append a segment. A crash costs at most this much. */
  segmentIntervalMs?: number;
}

interface Reading {
  ts: number;
  key: string;
  value: number;
}

let recipientPublicKey: KeyObject | null = null;
let recipientPublicRaw: Buffer | null = null;
let logDirectory = "";
let buffered: Reading[] = [];
let segmentTimer: ReturnType<typeof setInterval> | undefined;
let sealInFlight = false;

/**
 * Enables encrypted logging. Returns false (and logs why) if no public key is
 * configured, so the caller can carry on with plaintext storage.
 */
export async function initEncryptedLog(options: EncryptedLogOptions): Promise<boolean> {
  let pem: string;
  try {
    pem = await readFile(options.publicKeyPath, "utf-8");
  } catch (error) {
    console.log(
      `ride-log: no public key at ${options.publicKeyPath} — encrypted logging disabled ` +
        `(${(error as Error).message}). Generate one with: node scripts/generate-log-key.ts`
    );
    return false;
  }

  recipientPublicKey = createPublicKey(pem);
  if (recipientPublicKey.asymmetricKeyType !== "x25519") {
    throw new Error(`ride-log: expected an X25519 public key, got ${recipientPublicKey.asymmetricKeyType}`);
  }
  // The raw 32 bytes sit at the end of the SPKI DER for X25519; binding both
  // public keys into the HKDF salt is standard ECIES practice.
  recipientPublicRaw = recipientPublicKey.export({ type: "spki", format: "der" }).subarray(-EPHEMERAL_KEY_BYTES);

  logDirectory = options.directory;
  await mkdir(logDirectory, { recursive: true });

  const intervalMs = options.segmentIntervalMs ?? 30_000;
  segmentTimer = setInterval(() => {
    void sealPendingSegment();
  }, intervalMs);

  console.log(`ride-log: encrypting to ${logDirectory}, sealing a segment every ${intervalMs / 1000} s`);
  return true;
}

/** Queue one reading. Cheap — the crypto happens when a segment is sealed. */
export function appendReading(ts: number, key: string, value: number): void {
  if (!recipientPublicKey) {
    return;
  }
  buffered.push({ ts, key, value });
}

export async function closeEncryptedLog(): Promise<void> {
  if (segmentTimer) {
    clearInterval(segmentTimer);
    segmentTimer = undefined;
  }
  await sealPendingSegment();
}

/**
 * Seals everything buffered into one segment and appends it.
 *
 * Records are newline-delimited `[ts, key, value]` arrays: gzip collapses the
 * repeated keys to almost nothing, and the format stays trivially readable once
 * decrypted, which matters for data you cannot re-collect.
 */
async function sealPendingSegment(): Promise<void> {
  if (sealInFlight || buffered.length === 0 || !recipientPublicKey || !recipientPublicRaw) {
    return;
  }
  sealInFlight = true;
  const readings = buffered;
  buffered = [];

  try {
    const body = readings.map(reading => JSON.stringify([reading.ts, reading.key, reading.value])).join("\n");
    const compressed = await gzipAsync(Buffer.from(body, "utf-8"));

    const ephemeral = await generateKeyPairAsync("x25519", {});
    const sharedSecret = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipientPublicKey });
    const ephemeralRaw = ephemeral.publicKey.export({ type: "spki", format: "der" }).subarray(-EPHEMERAL_KEY_BYTES);

    const salt = Buffer.concat([ephemeralRaw, recipientPublicRaw]);
    const derived = Buffer.from(await hkdfAsync("sha256", sharedSecret, salt, HKDF_INFO, 32));
    const nonce = randomBytes(NONCE_BYTES);

    const lengthField = Buffer.alloc(LENGTH_BYTES);
    lengthField.writeUInt32LE(compressed.length, 0);
    const header = Buffer.concat([MAGIC, ephemeralRaw, nonce, lengthField]);

    const cipher = createCipheriv("aes-256-gcm", derived, nonce);
    cipher.setAAD(header);
    const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);

    const segment = Buffer.concat([header, ciphertext, cipher.getAuthTag()]);
    await appendFile(segmentPathFor(new Date()), segment);
  } catch (error) {
    // Put the readings back so the next tick retries rather than dropping data.
    buffered = readings.concat(buffered);
    console.error("ride-log: failed to seal segment, will retry:", error);
  } finally {
    sealInFlight = false;
  }
}

function segmentPathFor(when: Date): string {
  return join(logDirectory, `rides-${when.toISOString().slice(0, 10)}.celog`);
}
