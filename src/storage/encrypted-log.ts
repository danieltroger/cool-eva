import { createCipheriv, createPublicKey, diffieHellman, generateKeyPair, hkdf, randomBytes } from "crypto";
import type { KeyObject } from "crypto";
import { appendFile, mkdir, readFile } from "fs/promises";
import { join } from "path";
import { promisify } from "util";
import { gzip } from "zlib";
import type { SignalSource } from "../db.ts";

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
// at most the current buffer and leaves every earlier segment readable. Each one
// also carries the unit/group/source of the signals it contains, so a segment
// stays interpretable on its own even if the registry is later renamed — this is
// the only copy of the data, so it must not depend on a matching checkout.

const generateKeyPairAsync = promisify(generateKeyPair);
const hkdfAsync = promisify(hkdf);
const gzipAsync = promisify(gzip);

const MAGIC = Buffer.from("COOLEVA1");
const EPHEMERAL_KEY_BYTES = 32;
const NONCE_BYTES = 12;
const LENGTH_BYTES = 4;
const HKDF_INFO = Buffer.from("cool-eva ride log v1");

// A seal can only fail for a reason that persists (a full SD card, mostly), and
// re-queueing forever would trade a disk problem for the OOM killer. Roughly an
// hour of the chattiest signals; past that we drop oldest-first and say so.
//
// "Roughly an hour" assumes every deadband is doing its job. The 100 Hz signals off
// 0x102 and 0x104 could each fill this in minutes if theirs turned out too fine, and
// dropping oldest-first drops across all signals — so a runaway there evicts the pack
// temperatures rather than itself. Only reachable while seals are already failing,
// which is the case this limit exists for; worth re-deriving if a deadband is loosened.
const MAX_BUFFERED_READINGS = 200_000;

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
  seq: number;
}

/**
 * Row ordering that no clock can corrupt.
 *
 * `ts` has been doing two jobs — saying WHEN a row happened and saying what order
 * the rows came in — and it is only good at the first. This process steps its own
 * wall clock from GPS (../gps/clock.ts), so a step reorders every row around it: in
 * the 2060 incident the bad rows were stamped 34 years AHEAD, which means sorting by
 * `ts` scatters 49 772 rows to the end of the log and interleaves nothing correctly.
 *
 * Repairing that by forcing timestamps to increase would be worse, not better. It
 * recovers ordering by destroying time: every good row after a forward step would be
 * dragged up to 2060 and pinned there, turning a five-minute wound into a permanent
 * one. So the two jobs get two fields instead. `seq` counts rows and is never derived
 * from a clock, so it orders correctly however badly the clock behaves — including
 * retroactively, for rows already written with a wrong `ts`. Together with the raw
 * `gps_epoch_s` logged alongside, a reader can reconstruct both order and true time.
 *
 * Per process, starting at 0, which is why the segment header carries `session`:
 * across a restart the counter restarts too, and the session id is what keeps two
 * runs' sequences from being mistaken for one run's.
 */
let nextSequence = 0;

/**
 * Identifies one run of the process, so `seq` is unambiguous across restarts.
 *
 * Deliberately not a timestamp — a boot with a nonsense clock is the normal case on
 * this hardware, and two boots could otherwise claim the same identity. 8 random
 * bytes collide with probability far below the number of boots this bike will see.
 */
const sessionId = randomBytes(8).toString("hex");

interface SignalMeta {
  unit: string;
  group: string;
  source: SignalSource;
}

let recipientPublicKey: KeyObject | null = null;
let recipientPublicRaw: Buffer | null = null;
let logDirectory = "";
let buffered: Reading[] = [];
const signalMeta = new Map<string, SignalMeta>();
let segmentTimer: ReturnType<typeof setInterval> | undefined;
let activeSeal: Promise<void> | null = null;
let droppedReadings = 0;

/**
 * Enables encrypted logging. Returns false (and logs why) if no public key is
 * configured, so the caller can decide how loudly to complain.
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

  // Everything below builds locals first. Assigning recipientPublicKey before
  // these can throw would leave appendReading() buffering into an array that has
  // no timer to drain it — unbounded growth behind a "logging disabled" message.
  const publicKey = createPublicKey(pem);
  if (publicKey.asymmetricKeyType !== "x25519") {
    throw new Error(`ride-log: expected an X25519 public key, got ${publicKey.asymmetricKeyType}`);
  }
  // The raw 32 bytes sit at the end of the SPKI DER for X25519; binding both
  // public keys into the HKDF salt is standard ECIES practice.
  const publicRaw = publicKey.export({ type: "spki", format: "der" }).subarray(-EPHEMERAL_KEY_BYTES);
  await mkdir(options.directory, { recursive: true });

  recipientPublicKey = publicKey;
  recipientPublicRaw = publicRaw;
  logDirectory = options.directory;

  const intervalMs = options.segmentIntervalMs ?? 30_000;
  segmentTimer = setInterval(() => {
    void sealPendingSegment();
  }, intervalMs);

  console.log(`ride-log: encrypting to ${logDirectory}, sealing a segment every ${intervalMs / 1000} s`);
  return true;
}

/** Queue one reading. Cheap — the crypto happens when a segment is sealed. */
export function appendReading(
  ts: number,
  key: string,
  value: number,
  unit: string,
  group: string,
  source: SignalSource
): void {
  if (!recipientPublicKey) {
    return;
  }
  signalMeta.set(key, { unit, group, source });
  buffered.push({ ts, key, value, seq: nextSequence });
  nextSequence += 1;

  if (buffered.length > MAX_BUFFERED_READINGS) {
    const overflow = buffered.length - MAX_BUFFERED_READINGS;
    buffered.splice(0, overflow);
    droppedReadings += overflow;
    if (droppedReadings % 10_000 < overflow) {
      console.error(`ride-log: buffer full (segments not being written?) — dropped ${droppedReadings} readings`);
    }
  }
}

/** Seal whatever is buffered right now. Safe to call at any time. */
export async function flushEncryptedLog(): Promise<void> {
  await sealPendingSegment();
}

export async function closeEncryptedLog(): Promise<void> {
  if (segmentTimer) {
    clearInterval(segmentTimer);
    segmentTimer = undefined;
  }
  // Two passes: the first awaits a periodic seal that may already be running
  // (returning early there would let process.exit() kill it mid-append), the
  // second seals whatever was buffered while that one ran.
  await sealPendingSegment();
  await sealPendingSegment();
}

function sealPendingSegment(): Promise<void> {
  if (activeSeal) {
    return activeSeal;
  }
  if (buffered.length === 0 || !recipientPublicKey || !recipientPublicRaw) {
    return Promise.resolve();
  }
  const readings = buffered;
  buffered = [];
  activeSeal = sealSegment(readings, recipientPublicKey, recipientPublicRaw).finally(() => {
    activeSeal = null;
  });
  return activeSeal;
}

/**
 * Seals one segment and appends it.
 *
 * Body is a JSON header line naming the signals in this segment, then one
 * `[ts, key, value, seq]` array per line. gzip collapses the repeated keys to almost
 * nothing, and the format stays trivially readable once decrypted — which
 * matters for data that cannot be re-collected.
 *
 * ## v2, and why nothing needs to be migrated
 *
 * v1 lines were `[ts, key, value]` and the header was `{ v: 1, signals }`. The
 * fourth element and the header's `session` were added 2026-08-16. Both are
 * backward AND forward compatible by construction, so old and new segments can sit
 * in the same directory and be read by either reader:
 *
 *   * a v1 reader destructures `const [ts, key, value] = parsed`, which ignores a
 *     fourth element outright — scripts/decrypt-log.ts has always done exactly
 *     that — and it never looked at `v` either;
 *   * a v2 reader gets `undefined` for `seq` on a v1 line and stores NULL, which is
 *     the honest answer: those rows were written before anything counted them.
 *
 * The version number is bumped anyway. Nothing reads it today, but a segment that
 * says what shape it is costs one integer and this is the only copy of the data.
 */
async function sealSegment(readings: Reading[], publicKey: KeyObject, publicRaw: Buffer): Promise<void> {
  try {
    const signals: Record<string, [string, string, SignalSource]> = {};
    for (const key of new Set(readings.map(reading => reading.key))) {
      const meta = signalMeta.get(key);
      if (meta) {
        signals[key] = [meta.unit, meta.group, meta.source];
      }
    }
    const lines = [JSON.stringify({ v: 2, session: sessionId, signals })];
    for (const reading of readings) {
      lines.push(JSON.stringify([reading.ts, reading.key, reading.value, reading.seq]));
    }
    const compressed = await gzipAsync(Buffer.from(lines.join("\n"), "utf-8"));

    const ephemeral = await generateKeyPairAsync("x25519", {});
    const sharedSecret = diffieHellman({ privateKey: ephemeral.privateKey, publicKey });
    const ephemeralRaw = ephemeral.publicKey.export({ type: "spki", format: "der" }).subarray(-EPHEMERAL_KEY_BYTES);

    const salt = Buffer.concat([ephemeralRaw, publicRaw]);
    const derived = Buffer.from(await hkdfAsync("sha256", sharedSecret, salt, HKDF_INFO, 32));
    const nonce = randomBytes(NONCE_BYTES);

    const lengthField = Buffer.alloc(LENGTH_BYTES);
    lengthField.writeUInt32LE(compressed.length, 0);
    const header = Buffer.concat([MAGIC, ephemeralRaw, nonce, lengthField]);

    const cipher = createCipheriv("aes-256-gcm", derived, nonce);
    cipher.setAAD(header);
    const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);

    await appendFile(segmentPathFor(new Date()), Buffer.concat([header, ciphertext, cipher.getAuthTag()]));
  } catch (error) {
    // Put the readings back so the next tick retries rather than dropping data.
    buffered = readings.concat(buffered);
    console.error("ride-log: failed to seal segment, will retry:", error);
  }
}

function segmentPathFor(when: Date): string {
  return join(logDirectory, `rides-${when.toISOString().slice(0, 10)}.celog`);
}
