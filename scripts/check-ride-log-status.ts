import { createDecipheriv, createPublicKey, diffieHellman, generateKeyPair, hkdf } from "crypto";
import type { KeyObject } from "crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { promisify } from "util";
import { gunzip } from "zlib";
import { measureLog } from "../src/http/status.ts";
import { appendReading, closeEncryptedLog, flushEncryptedLog, initEncryptedLog } from "../src/storage/encrypted-log.ts";

// Guards the number the download button puts under itself, and the claim it makes
// about the files it is offering.
//
//   node --experimental-strip-types scripts/check-ride-log-status.ts
//
// ## The bug this exists because of
//
// The caption read "10 sealed segments · encrypted, safe over any network", and it
// read that for weeks — reported as "it always says 10". Ten was in fact the honest
// count of something: `.celog` FILES in RIDE_LOG_DIR, stat'd one by one, nothing
// hardcoded and nothing capped. It was the noun that was wrong. A segment is sealed
// every 30 s and APPENDED to that day's `rides-<YYYY-MM-DD>.celog`, so one file is a
// day of segments — decrypt-log.ts says the same thing from the other end, and is
// what counts the real ones. Two consequences, both of which the owner saw:
//
//   * the number was smaller than the truth by three or four orders of magnitude;
//   * it could not move until midnight, however long the bike rode. A count that is
//     wired to a constant and a count that is wired to the calendar look identical
//     from a garage.
//
// So this check pins both halves — that the count is computed from the directory and
// scales past any plausible cap (§1), and that a file is genuinely not a segment, so
// nothing may relabel one as the other again (§2 and §3).
//
// ## And the security sentence
//
// "Safe over any network" was doing the same thing in words: broader than what the
// code provides. What the code provides is confidentiality, and it really does — the
// Pi holds only the recipient's public key, and §4 proves a segment opens with the
// matching private key and refuses any other. What it does not provide is
// authenticity: that public key is not a secret, and anyone holding it can seal a
// segment that decrypts and passes its GCM tag exactly like a real one. /dl is
// unauthenticated and nothing is signed. So the caption may claim unreadability, and
// §3 keeps it from drifting back to claiming safety.
//
// ## No bike, no Pi, no local-only files
//
// Everything below runs against a keypair generated here and thrown away, in a temp
// directory, through the real src/storage/encrypted-log.ts and the real
// src/http/status.ts. The repo's own private key is never read and never needed.

const gunzipAsync = promisify(gunzip);
const hkdfAsync = promisify(hkdf);
const generateKeyPairAsync = promisify(generateKeyPair);

// The framing src/storage/encrypted-log.ts writes, restated here rather than
// imported: those constants are not exported, and a check that borrowed the
// producer's own idea of the format could not notice the producer changing it.
// scripts/decrypt-log.ts keeps its own copy for the same reason.
const MAGIC = Buffer.from("COOLEVA1");
const EPHEMERAL_KEY_BYTES = 32;
const NONCE_BYTES = 12;
const LENGTH_BYTES = 4;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + EPHEMERAL_KEY_BYTES + NONCE_BYTES + LENGTH_BYTES;
const HKDF_INFO = Buffer.from("cool-eva ride log v1");
/** DER prefix for an X25519 SubjectPublicKeyInfo; the raw 32 bytes follow it. */
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

/**
 * How many `.celog` files §1 puts on disk.
 *
 * Deliberately more than ten. Ten is the number the owner kept seeing, and the first
 * guesses at why were a hardcoded literal, a `LIMIT 10` and a fixed-size preview
 * array — none of which was the answer, but any of which a later change could
 * introduce for real. A fixture of thirteen fails all three, and the byte total fails
 * them again independently: the first ten of these files hold 55 bytes, all thirteen
 * hold 91, so a truncated count cannot produce a matching size.
 */
const FIXTURE_FILE_COUNT = 13;

/** How many segments §2 seals. Any number above two proves the point; five is legible. */
const SEGMENTS_TO_SEAL = 5;

/**
 * Files those five seals are allowed to land in.
 *
 * One, or two if the run straddles UTC midnight — the sealer names files after the
 * date. Three would need the run to cross midnight twice, so this is a real ceiling
 * and not a fudge factor, while asserting exactly one would go red once a day and a
 * check that does that gets deleted.
 */
const FILES_ONE_RUN_MAY_MAKE = 2;

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectDir = join(__dirname, "..");

const failures: string[] = [];
const workDir = await mkdtemp(join(tmpdir(), "cool-eva-ride-log-check-"));

try {
  await checkTheCountIsTheDirectory(join(workDir, "counted"));
  // Both keypairs are made here and die with the process. The repo's real
  // `ride-log-key.*.pem` is never touched — it is gitignored and absent on CI, and a
  // check that needed it would be a check that only ran on one laptop.
  const own = await freshKeypair();
  const stranger = await freshKeypair();
  const sealedDirectory = join(workDir, "sealed");
  await sealRealSegments(sealedDirectory, own);
  await checkTheCaptionSaysWhatIsCounted();
  await checkOnlyThePrivateKeyOpensIt(sealedDirectory, own, stranger);
} finally {
  // Leaves the segment timer behind otherwise, and the process would sit at the
  // prompt until it fired — which run-checks.ts reports as "no verdict", correctly.
  await closeEncryptedLog();
  await rm(workDir, { recursive: true, force: true });
}

console.log("");
if (failures.length > 0) {
  console.error("FAILED:");
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  process.exit(1);
}
console.log(
  `✓ /status counts all ${FIXTURE_FILE_COUNT} files and sizes them (no cap at 10), ` +
    `${SEGMENTS_TO_SEAL} real seals still land in one day file so a file is not a segment, ` +
    `the download caption counts files and says so, and a sealed segment opens with its own ` +
    `private key and with no other`
);

/**
 * §1 — the number is read off the directory, every time, with nothing dropped.
 *
 * Thirteen files of 1…13 bytes plus four decoys that must not be counted. Checks the
 * count, the byte total, the empty directory and the missing one — that last arm is
 * the normal "no public key configured yet" state, and returning a plausible-looking
 * number from it would be worse than returning zero.
 */
async function checkTheCountIsTheDirectory(directory: string): Promise<void> {
  const missing = await measureLog(join(directory, "was-never-created"));
  if (missing.files !== 0 || missing.bytes !== 0) {
    failures.push(
      `a directory that does not exist reported ${missing.files} files / ${missing.bytes} bytes, not 0 / 0`
    );
  }

  await mkdir(directory, { recursive: true });
  const empty = await measureLog(directory);
  if (empty.files !== 0 || empty.bytes !== 0) {
    failures.push(`an empty directory reported ${empty.files} files / ${empty.bytes} bytes, not 0 / 0`);
  }

  let expectedBytes = 0;
  for (let index = 0; index < FIXTURE_FILE_COUNT; index += 1) {
    // Dates are what the real sealer names files after, so the fixture uses them too:
    // readdir order is not sorted, and a count that quietly depended on it would pass
    // here and fail on the Pi.
    const day = String(index + 1).padStart(2, "0");
    await writeFile(join(directory, `rides-2026-03-${day}.celog`), Buffer.alloc(index + 1, 0x7a));
    expectedBytes += index + 1;
  }
  // Things that end up in a ride-log directory and are not segments. The `.celog.tmp`
  // and `.celog.gz` decoys matter most: `.endsWith(".celog")` is the whole test, so a
  // change to `.includes()` would swallow both.
  await writeFile(join(directory, "README.md"), "not a segment\n");
  await writeFile(join(directory, "rides-2026-03-99.celog.tmp"), "half-written\n");
  await writeFile(join(directory, "rides-2026-03-98.celog.gz"), "archived elsewhere\n");
  await writeFile(join(directory, ".celogrc"), "a dotfile, not a segment\n");

  const measured = await measureLog(directory);
  if (measured.files !== FIXTURE_FILE_COUNT) {
    failures.push(
      `/status reported ${measured.files} log files for a directory holding ${FIXTURE_FILE_COUNT} .celog files ` +
        `(plus 4 non-segment decoys) — the count must come from the directory, not from a constant or a slice`
    );
  }
  if (measured.bytes !== expectedBytes) {
    failures.push(
      `/status reported ${measured.bytes} bytes for ${expectedBytes} bytes on disk — ` +
        `the first ten files alone would be 55, which is what a truncated count looks like here`
    );
  }
}

/**
 * §2 — a `.celog` file is a day of segments, so a file count is not a segment count.
 *
 * The premise the caption got wrong, proven through the real sealer rather than
 * asserted: seal five segments, then look at how many files that made. It is one.
 *
 * The bound is `< SEGMENTS_TO_SEAL` rather than `=== 1` because a run that straddles
 * UTC midnight legitimately writes two files, and a check that goes red once a day is
 * a check people delete. Two is still the ceiling — reaching three would need the run
 * to cross midnight twice — and either number proves what this is here to prove.
 */
async function sealRealSegments(directory: string, recipient: ThrowawayKeypair): Promise<void> {
  const publicKeyPath = join(workDir, "throwaway.public.pem");
  await writeFile(publicKeyPath, spkiFor(recipient.publicRaw).export({ type: "spki", format: "pem" }));

  await initEncryptedLog({
    publicKeyPath,
    directory,
    // An hour, so the periodic timer never fires and every seal below is one this
    // check asked for. flushEncryptedLog() is what actually writes them.
    segmentIntervalMs: 3_600_000,
  });

  for (let index = 0; index < SEGMENTS_TO_SEAL; index += 1) {
    appendReading(Date.now(), "coolant_in", 20 + index, "°C", "cooling", "sensor");
    await flushEncryptedLog();
  }

  const measured = await measureLog(directory);
  const segmentsOnDisk = await countSealedSegments(directory);

  if (segmentsOnDisk !== SEGMENTS_TO_SEAL) {
    failures.push(`sealed ${SEGMENTS_TO_SEAL} segments but the framing on disk holds ${segmentsOnDisk}`);
  }
  if (measured.files > FILES_ONE_RUN_MAY_MAKE) {
    failures.push(
      `${SEGMENTS_TO_SEAL} sealed segments produced ${measured.files} files, and one run can only make ` +
        `${FILES_ONE_RUN_MAY_MAKE}. The sealer has stopped appending a day of segments to one ` +
        `rides-<YYYY-MM-DD>.celog, so /status's file count is drifting towards being a segment count — and the ` +
        `download caption, which is worded around day files, goes wrong again in the other direction`
    );
  }
  if (measured.files < 1) {
    failures.push(`${SEGMENTS_TO_SEAL} sealed segments produced no files at all`);
  }
  const sizeOnDisk = await totalSize(directory);
  if (measured.bytes !== sizeOnDisk) {
    failures.push(`/status reported ${measured.bytes} bytes for real segments totalling ${sizeOnDisk} on disk`);
  }

  console.log(
    `  ${SEGMENTS_TO_SEAL} seals → ${measured.files} file(s), ${segmentsOnDisk} segments, ${measured.bytes} bytes`
  );
}

/**
 * §3 — the caption counts files and calls them files.
 *
 * `log.files` being referenced is already enforced by tsc (public/**\/*.js is checked
 * against StatusPayload), so what is left to guard is the English: a caption that
 * interpolates the file count and then calls it "segments" type-checks perfectly and
 * is exactly the bug that was reported. Comment lines are stripped first — this
 * function's own explanation of the bug necessarily contains the word.
 *
 * The phrase check is narrower on purpose. "Safe over any network" is not a wording
 * preference; it is a claim of authenticity the code does not make, and it is the
 * sentence that shipped, so it is the sentence worth naming.
 */
async function checkTheCaptionSaysWhatIsCounted(): Promise<void> {
  const path = join(projectDir, "public/views/sheet.js");
  const source = await readFile(path, "utf-8");
  const body = downloadButtonBody(source);
  if (body === null) {
    failures.push(`could not find function DownloadButton() in ${path} — this check can no longer see the caption`);
    return;
  }

  const code = body
    .split("\n")
    .filter(line => !line.trim().startsWith("//"))
    .join("\n");

  if (!code.includes("log.files")) {
    failures.push(`DownloadButton() in ${path} no longer reads log.files — what is the caption counting?`);
  }
  if (/segment/i.test(code)) {
    failures.push(
      `DownloadButton() in ${path} says "segment" about a count of files. One .celog file is a whole day of ` +
        `sealed segments (see src/http/status.ts) — count them properly or call them files`
    );
  }
  if (/safe over any network/i.test(code)) {
    failures.push(
      `DownloadButton() in ${path} claims the log is "safe over any network". The encryption gives ` +
        `confidentiality, not authenticity: the recipient public key is not a secret, so anyone holding it can ` +
        `seal a segment that decrypts cleanly, and /dl authenticates nobody. Claim unreadability instead`
    );
  }
}

/**
 * §4 — the claim the caption does make is true.
 *
 * Opens the first segment §2 sealed with the private key that matches it (must
 * succeed, and must contain the reading that went in), then with an unrelated private
 * key (must fail). The second half is the one that matters: it is the difference
 * between "encrypted" as a word in a caption and the property that makes a stolen
 * bike useless.
 */
async function checkOnlyThePrivateKeyOpensIt(
  directory: string,
  recipient: ThrowawayKeypair,
  stranger: ThrowawayKeypair
): Promise<void> {
  const files = (await readdir(directory)).filter(entry => entry.endsWith(".celog")).sort();
  if (files.length === 0) {
    failures.push("§2 sealed nothing, so there is no segment to try opening");
    return;
  }
  const blob = await readFile(join(directory, files[0]));
  const segment = readFirstSegment(blob);
  if (segment === null) {
    failures.push(`${files[0]} does not start with a well-formed segment header`);
    return;
  }

  let plaintext: string;
  try {
    plaintext = await openSegment(recipient.privateKey, recipient.publicRaw, segment);
  } catch (error) {
    failures.push(
      `a segment sealed to this keypair will not open with its own private key: ${(error as Error).message}`
    );
    return;
  }
  if (!plaintext.includes("coolant_in")) {
    failures.push(
      `the opened segment does not contain the reading that was sealed into it: ${plaintext.slice(0, 120)}`
    );
  }

  try {
    await openSegment(stranger.privateKey, stranger.publicRaw, segment);
    failures.push(
      "a segment opened with an unrelated private key — the caption's claim that the log is unreadable without " +
        "the laptop's key would be false"
    );
  } catch (error) {
    // The expected outcome, and the one worth naming in the log: a caption that
    // promises unreadability is only as good as this line failing.
    console.log(`  an unrelated private key is refused, as claimed (${(error as Error).message})`);
  }
}

interface SealedSegment {
  header: Buffer;
  ephemeralRaw: Buffer;
  nonce: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
}

/** Parses the first segment out of a `.celog` blob, or null if the framing is wrong. */
function readFirstSegment(blob: Buffer): SealedSegment | null {
  if (blob.length < HEADER_BYTES || !blob.subarray(0, MAGIC.length).equals(MAGIC)) {
    return null;
  }
  let cursor = MAGIC.length;
  const ephemeralRaw = blob.subarray(cursor, cursor + EPHEMERAL_KEY_BYTES);
  cursor += EPHEMERAL_KEY_BYTES;
  const nonce = blob.subarray(cursor, cursor + NONCE_BYTES);
  cursor += NONCE_BYTES;
  const ciphertextLength = blob.readUInt32LE(cursor);
  cursor += LENGTH_BYTES;
  if (cursor + ciphertextLength + TAG_BYTES > blob.length) {
    return null;
  }
  return {
    header: blob.subarray(0, HEADER_BYTES),
    ephemeralRaw,
    nonce,
    ciphertext: blob.subarray(cursor, cursor + ciphertextLength),
    authTag: blob.subarray(cursor + ciphertextLength, cursor + ciphertextLength + TAG_BYTES),
  };
}

/** Walks the framing of every `.celog` in `directory` and counts the segments in them. */
async function countSealedSegments(directory: string): Promise<number> {
  let total = 0;
  for (const entry of (await readdir(directory)).filter(name => name.endsWith(".celog"))) {
    const blob = await readFile(join(directory, entry));
    let offset = 0;
    while (offset + HEADER_BYTES <= blob.length) {
      if (!blob.subarray(offset, offset + MAGIC.length).equals(MAGIC)) {
        failures.push(`${entry}: no segment magic at byte ${offset} — the framing this check reads has changed`);
        break;
      }
      const ciphertextLength = blob.readUInt32LE(offset + MAGIC.length + EPHEMERAL_KEY_BYTES + NONCE_BYTES);
      offset += HEADER_BYTES + ciphertextLength + TAG_BYTES;
      total += 1;
    }
  }
  return total;
}

/** Mirrors openSegment() in scripts/decrypt-log.ts — the reader the Pi's output is for. */
async function openSegment(privateKey: KeyObject, recipientPublicRaw: Buffer, segment: SealedSegment): Promise<string> {
  const sharedSecret = diffieHellman({ privateKey, publicKey: spkiFor(segment.ephemeralRaw) });
  const salt = Buffer.concat([segment.ephemeralRaw, recipientPublicRaw]);
  const derived = Buffer.from(await hkdfAsync("sha256", sharedSecret, salt, HKDF_INFO, 32));

  const decipher = createDecipheriv("aes-256-gcm", derived, segment.nonce);
  decipher.setAAD(segment.header);
  decipher.setAuthTag(segment.authTag);
  const compressed = Buffer.concat([decipher.update(segment.ciphertext), decipher.final()]);
  return (await gunzipAsync(compressed)).toString("utf-8");
}

interface ThrowawayKeypair {
  privateKey: KeyObject;
  publicRaw: Buffer;
}

/** One throwaway X25519 keypair, in the two forms the sealing path needs. */
async function freshKeypair(): Promise<ThrowawayKeypair> {
  const pair = await generateKeyPairAsync("x25519", {});
  return {
    privateKey: pair.privateKey,
    // The raw 32 bytes sit at the end of the SPKI DER, which is how
    // src/storage/encrypted-log.ts gets at them too — they go into the HKDF salt.
    publicRaw: pair.publicKey.export({ type: "spki", format: "der" }).subarray(-EPHEMERAL_KEY_BYTES),
  };
}

/** Wraps 32 raw X25519 bytes back into the KeyObject that diffieHellman() wants. */
function spkiFor(publicRaw: Buffer): KeyObject {
  return createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, publicRaw]), format: "der", type: "spki" });
}

async function totalSize(directory: string): Promise<number> {
  const entries = (await readdir(directory)).filter(name => name.endsWith(".celog"));
  const sizes = await Promise.all(entries.map(async entry => (await stat(join(directory, entry))).size));
  return sizes.reduce((sum, size) => sum + size, 0);
}

/**
 * The source of `function DownloadButton()`, from its signature to the closing brace
 * in column 0. Crude, and enough: the dashboard has no build step, every top-level
 * function in public/ closes that way, and a parser here would be a dependency this
 * repo deliberately does not have.
 */
function downloadButtonBody(source: string): string | null {
  const start = source.indexOf("function DownloadButton()");
  if (start < 0) {
    return null;
  }
  const end = source.indexOf("\n}", start);
  if (end < 0) {
    return null;
  }
  return source.slice(start, end);
}
