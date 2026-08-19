import { createDecipheriv, createPublicKey, diffieHellman, generateKeyPair, hkdf } from "crypto";
import type { KeyObject } from "crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { promisify } from "util";
import { gunzip } from "zlib";
import type { ServerResponse } from "http";
import { handleStatusEndpoint, measureLog, onDemandOnlyGroups, type StatusPayload } from "../src/http/status.ts";
import { SIGNALS } from "../src/can/registry.ts";
import { defineSignals, record, type SignalDef } from "../src/can/signals.ts";
import { appendReading, closeEncryptedLog, flushEncryptedLog, initEncryptedLog } from "../src/storage/encrypted-log.ts";

// Guards what /status says about the ride log and about the CAN sources: that the
// file count is read off the directory, that nothing relabels a file as a segment in
// front of the rider, that a sealed segment opens with one private key and no other,
// and that a source which has never spoken is reported as dark rather than left out.
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
// unauthenticated and nothing is signed. The caption itself is gone, so §3 guards a
// conditional: a caption that comes back may claim unreadability, and may not drift
// back to claiming safety.
//
// ## And the liveness summary
//
// §5 is here for a defect of the same family, found while deleting the readout that
// displayed it: `summariseGroups()` was built from the keys that had ARRIVED, so a
// source which had never spoken was missing from the payload rather than reading
// zero. Anything looking for a dead source by filtering `live === 0` therefore found
// nothing to report on a completely dead bus. Both bugs are a true number that
// answers a different question from the one being asked of it.
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

/**
 * The registry key §5c records, and the group that declares it.
 *
 * Any streamed key in any group would do; `soc` is the one signal on this bike
 * everybody already knows the meaning of, and `battery` is the largest group, so the
 * off-by-one a double-count produces is unmistakable in the failure message.
 */
const LIVE_DECLARED_KEY = "soc";
const LIVE_DECLARED_GROUP = "battery";

/**
 * A key the registry does not declare, which is a state the real bike reaches: a
 * decoder emitting a key nobody added to SIGNALS. record() files those under `misc`,
 * and the summary has to grow the group rather than drop the reading.
 */
const UNDECLARED_KEY = "check_undeclared_key";

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
  const sealed = await sealRealSegments(sealedDirectory, own);
  await checkTheCaptionSaysWhatIsCounted();
  // Order matters here and nowhere else in this file: §5a needs an empty snapshot()
  // and §5c is what fills it, so the dead-bus case has to be measured first.
  const deadBus = await checkADeadBusIsNotReportedAsHealthy();
  checkAMixedGroupKeepsItsLiveness();
  if (deadBus) {
    await checkALiveBusCountsEachKeyOnce(deadBus);
  }
  if (sealed) {
    // §4 opens what §2 wrote, so it has nothing to say when §2 wrote nothing — and
    // its readdir() would reject ENOENT out of a try/finally with no catch, killing
    // the run before the failure list below ever prints. Skipping it is what lets §2's
    // own diagnosis be the thing the reader sees.
    await checkOnlyThePrivateKeyOpensIt(sealedDirectory, own, stranger);
  }
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
    `the button names no count at all (the caption was removed), a silent bus reports every ` +
    `measured group as dark rather than omitting it while a talking one counts each key once, ` +
    `and a sealed segment opens with its own private key and with no other`
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
 * The bound is FILES_ONE_RUN_MAY_MAKE — see there for why two rather than one. It
 * was `< SEGMENTS_TO_SEAL` first, and that was too loose to do the job: renaming the
 * file to a full timestamp, which really does write a file per seal, still produced
 * only three files out of five here, because seals landing in the same millisecond
 * kept colliding onto one name. Three is under five, so the check stayed green
 * through the exact regression it exists to catch. Bound it by what one run can
 * legitimately produce instead, and that mutation goes red.
 *
 * Returns whether anything was actually sealed, because §4 reads what this wrote.
 */
async function sealRealSegments(directory: string, recipient: ThrowawayKeypair): Promise<boolean> {
  const publicKeyPath = join(workDir, "throwaway.public.pem");
  await writeFile(publicKeyPath, spkiFor(recipient.publicRaw).export({ type: "spki", format: "pem" }));

  const enabled = await initEncryptedLog({
    publicKeyPath,
    directory,
    // An hour, so the periodic timer never fires and every seal below is one this
    // check asked for. flushEncryptedLog() is what actually writes them.
    segmentIntervalMs: 3_600_000,
  });
  if (!enabled) {
    // Without this, appendReading() silently no-ops and the failure surfaces as
    // "produced no files at all" — the right verdict attached to the wrong cause.
    // The writeFile() two lines up means this should be unreachable, which is the
    // reason it has to be loud rather than the reason it can be left out.
    failures.push(`initEncryptedLog() refused the throwaway public key at ${publicKeyPath}, so nothing was sealed`);
    return false;
  }

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
        `rides-<YYYY-MM-DD>.celog, so /status's file count is drifting towards being a segment count. Nothing ` +
        `displays it today, but §3 exists so a caption that comes back cannot label it wrongly`
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
  return true;
}

/**
 * §3 — IF the caption counts files, it calls them files.
 *
 * The caption itself was removed on 2026-08-19: it was accurate after the rename but
 * could not be useful, since one `.celog` is a whole calendar day of segments and the
 * number therefore cannot move before midnight however far the bike rides. So this
 * section now guards a conditional rather than a fact — nothing requires a caption to
 * exist, but one that shows a count must not mislabel it.
 *
 * The spelling of the count is tsc's job (public/**\/*.js is checked against
 * StatusPayload, so `log.segments` does not compile). What is left to guard is the
 * English: a caption that interpolates the file count and then calls it "segments"
 * type-checks perfectly and is exactly the bug that was reported.
 *
 * Comments are stripped first, and both kinds of them — the explanation living next
 * to that caption necessarily contains the word "segment", and it is long enough that
 * reformatting it as a `/* … *\/` block is a plausible thing for a future editor to
 * do. Stripping only `//` would turn that reformat into a red build for no reason.
 *
 * The phrase check is narrower on purpose. "Safe over any network" is not a wording
 * preference; it is a claim about the transfer that the crypto does not make, and it
 * is the sentence that shipped, so it is the sentence worth naming.
 */
async function checkTheCaptionSaysWhatIsCounted(): Promise<void> {
  const path = join(projectDir, "public/views/sheet.js");
  const source = await readFile(path, "utf-8");
  const body = downloadButtonBody(source);
  if (body === null) {
    failures.push(`could not find function DownloadButton() in ${path} — this check can no longer see the caption`);
    return;
  }
  const code = withoutComments(body);

  // Canary. Every other assertion in this section fires on the PRESENCE of
  // something wrong, so an over-eager withoutComments() that returned "" would
  // make them all pass and the section would go quiet instead of red — and
  // withoutComments()'s own docstring promises the opposite. That promise used to
  // rest on the `log.files` assertion firing on absence; removing the caption
  // removed the canary with it, silently. So assert the stripper left real code
  // behind, against something structural rather than anything to do with the
  // caption: DownloadButton exists to start the download, and if that line is
  // gone the input was not this function.
  if (!code.includes("/dl")) {
    failures.push(
      `withoutComments() left no recognisable code in DownloadButton() from ${path} — the download target "/dl" ` +
        `is missing, so the stripper has eaten the function and every check below it would pass on an empty string`
    );
    return;
  }

  // Narrowed 2026-08-19, which is the escape hatch the message below already offered:
  // the caption was removed outright for screen space, so there is no count to label
  // and the old "must read log.files" assertion was firing on a deliberate deletion
  // rather than on a bug.
  //
  // That assertion is GONE rather than gated, because gating it made it unfirable:
  // it was `showsACount && !includes("log.files")`, and showsACount was true only
  // when `log.files` was present, so the two halves contradict. The `log.segments`
  // arm could not save it either — `StatusPayload.log` is `{ files; bytes; enabled }`
  // and public/**/*.js is checkJs'd against it, so tsc rejects that spelling before
  // this script ever runs. Nothing was lost by deleting it; it was already dead.
  //
  // What survives is the half that tsc CANNOT check: the English. A caption that
  // interpolates the file count and calls the result "segments" type-checks
  // perfectly and is exactly the bug that was reported, so it stays guarded — and
  // only when a count is actually shown, since "sealed every 30 s" is true prose
  // that happens to contain the word.
  //
  // Third attempt at this gate, and the first two were both wrong in opposite
  // directions — worth recording, because the shape recurs.
  //
  //   1. `showsACount && !includes("log.files")` — contradictory halves, could
  //      never fire.
  //   2. `/\$\{/ && /\blog\b/` — the "any number reaches the rider" version. It
  //      can never NOT fire: the button's own `${bytes(current.log.bytes)}` gives
  //      the interpolation and the words "Download ride log" give the `log`. A
  //      caption with no count at all still tripped it.
  //
  // So it is back to the file count's actual spelling. That is narrow, and the
  // narrowness is the honest part: it catches the bug that was REPORTED — the
  // count interpolated and labelled "segments" — and it does not pretend to catch
  // a caption that reads the count through a destructure:
  //
  //     const { files } = current.log;   // ← walks past this
  //
  // A guard that fires on everything is worth less than one that fires on the
  // real case and says what it misses. If the destructure form ever appears,
  // widen it then, against a case that exists.
  const showsACount = code.includes("log.files");
  if (showsACount && /segment/i.test(code)) {
    failures.push(
      `DownloadButton() in ${path} says "segment" in text the rider sees, next to a count of files. One .celog ` +
        `file is a whole day of sealed segments (see src/http/status.ts), so a number labelled that way is wrong ` +
        `by orders of magnitude — that is the bug this check was written for. If you are NOT labelling the count ` +
        `— "sealed every 30 s" would be true and useful — then this assertion is in your way rather than wrong, ` +
        `and the fix is to narrow it to the label, not to delete it`
    );
  }
  if (/safe over any network/i.test(code)) {
    failures.push(
      `DownloadButton() in ${path} claims the log is "safe over any network". That is a claim about the TRANSFER, ` +
        `and the transfer is the part with no crypto in it: /dl is unauthenticated plain HTTP, so anyone on the ` +
        `wifi can pull the whole log and keep the ciphertext against the day the key leaks, and a MITM can drop ` +
        `or truncate segments holding no key at all (README, "No cross-segment integrity"). What is true is a ` +
        `claim about the BYTES — without the laptop's private key they are noise. Claim that instead. ` +
        `src/http/download.ts says something similar in a comment and is not held to this; a caption is a promise ` +
        `made to the rider, a comment is a note to whoever is already reading the code`
    );
  }
}

/**
 * Source with `//` and `/* … *\/` comments blanked out, so a text assertion about what
 * a function displays cannot be tripped by prose explaining that function.
 *
 * Line comments go first, so a `/*` inside one cannot open a block that swallows real
 * code below it. Block comments are then blanked in place, keeping their newlines, so
 * nothing on either side of one gets joined into a token that was never there. Crude —
 * it has no idea about `//` inside a string literal — but it only ever runs over one
 * small view function.
 *
 * Note that stripping too much is not automatically the safe direction. Every
 * assertion in §3 fires on the PRESENCE of something wrong, so a stripper that ate
 * the function would make all of them pass and the section would go quiet instead of
 * red. What stops that is the `/dl` canary the caller runs first, and nothing else —
 * the `log.files` assertion that used to hold this property was deleted with the
 * caption. Widen this and check that canary still catches an empty return.
 */
function withoutComments(source: string): string {
  return source
    .split("\n")
    .filter(line => !line.trim().startsWith("//"))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, " "));
}

/**
 * §5a — a bus that has said nothing reports every source dark, not no sources.
 *
 * This check exists because the opposite shipped. `summariseGroups()` used to be
 * built by walking `snapshot()`, which holds only keys decoded at least once since
 * boot — so a source that had never spoken was ABSENT from the payload rather than
 * present at zero. Anything asking "is a group dark" by testing `live === 0` then
 * found nothing to report and said everything was fine, which is the one answer a
 * liveness check must never give wrongly.
 *
 * It was visible in the wild and nobody noticed: a screenshot of the old sixteen-tile
 * grid showed sixteen groups against a registry that declares seventeen. The missing
 * one was `waypoint`, absent because no waypoint had been saved.
 *
 * This process never touches CAN, so `snapshot()` is empty here — which is exactly
 * the dead-bus case, for free. It also means this has to run BEFORE §5c, which is
 * what puts something in the snapshot. The assertion is deliberately against the real
 * endpoint rather than an exported internal: the bug was in what /status SERVES.
 *
 * Returns the payload, because §5c reads the same numbers back off a live bus.
 */
async function checkADeadBusIsNotReportedAsHealthy(): Promise<StatusPayload | null> {
  const payload = await fetchStatus();
  if (payload === null) {
    return null;
  }
  // On-demand-only groups are deliberately absent — see summariseGroups(). Their
  // silence is a resting state, so asserting they are present would pin the very
  // behaviour that made the dashboard name `waypoint` as dark forever.
  // Named, NOT re-derived. Computing `onDemandOnly` with the same expression the
  // implementation uses makes the two agree by construction, so the check would
  // bless whatever the implementation decided — including deleting liveness for
  // the sensors this project exists for. Marking both coolant probes `onDemand`
  // passed a version of this check that shared the formula.
  //
  // So the groups that must ALWAYS be summarised are written down here, and
  // adding an exclusion means editing this list on purpose. `waypoint` is absent
  // deliberately: it is the one group written only on request.
  const MUST_BE_SUMMARISED = [
    "battery",
    "bms",
    "buttons",
    "cells",
    "charge",
    "controls",
    "coolant",
    "diag",
    "drive",
    "energy",
    "gps",
    "imu",
    "obd",
    "powertrain",
    "security",
    "vcu",
  ];
  const declared = [...MUST_BE_SUMMARISED].sort();
  const unknown = declared.filter(group => !SIGNALS.some(signal => signal.group === group));
  if (unknown.length > 0) {
    failures.push(
      `MUST_BE_SUMMARISED names ${unknown.join(", ")}, which no signal declares — the list has drifted from the ` +
        `registry and is now asserting something that cannot be true`
    );
  }
  const reported = Object.keys(payload.groups).sort();
  const missing = declared.filter(group => !reported.includes(group));

  if (missing.length > 0) {
    failures.push(
      `/status omitted ${missing.length} declared group(s) from a bus that has sent nothing: ${missing.join(", ")}. ` +
        `A group nothing has ever been heard from is the strongest possible "dark", and it must be reported as ` +
        `[0, n] rather than left out — a dashboard that filters on live === 0 reads an omission as health`
    );
  }
  // The other direction, and without it the list catches drift one way only.
  // `unknown` above notices a group leaving the registry; nothing noticed one
  // ARRIVING, so a group added to SIGNALS after today sat outside the list and was
  // therefore unguarded — and the next `onDemand` on it would delete its liveness
  // in silence, which is the hole the list exists to close. Deliberately NOT
  // phrased as an exclusion: it says only "everything /status summarises is named
  // here on purpose", so it cannot agree with the implementation by construction
  // the way a shared formula did.
  //
  // What it still misses, since a guard is worth more with its blind spot written
  // down: a group born with EVERY signal already `onDemand` never reaches the
  // payload, so it is never compared against this list at all. That is exactly
  // `waypoint`'s shape, and telling a deliberate one from a copy-pasted flag would
  // need a second hand-kept list of the groups allowed to be absent. Adding the
  // group first and the flag second — which is how it happens in practice — is
  // caught here on the first step.
  const extra = reported.filter(group => !declared.includes(group));
  if (extra.length > 0) {
    failures.push(
      `/status summarises ${extra.join(", ")}, which MUST_BE_SUMMARISED does not name — a new group must be added ` +
        `to that list deliberately, or the next onDemand on it drops it from liveness in silence`
    );
  }
  const live = declared.filter(group => (payload.groups[group]?.[0] ?? 0) > 0);
  if (live.length > 0) {
    failures.push(`/status reported ${live.join(", ")} as live in a process that never opened can0`);
  }
  console.log(`  a silent bus reports ${reported.length} of ${declared.length} declared groups, all dark`);
  return payload;
}

/**
 * One /status response, parsed, or null if the endpoint did not produce one.
 *
 * The response is faked rather than served over a socket because the bug §5 exists
 * for was in the payload, not in the transport — but it goes through the real
 * handler, so a change to what /status assembles is a change this check sees.
 */
async function fetchStatus(): Promise<StatusPayload | null> {
  let body = "";
  const res = {
    statusCode: 200,
    writeHead() {},
    setHeader() {},
    // `string | Buffer`, because handleStatusEndpoint passes a Buffer. Typing it
    // as string worked only because JSON.parse coerces, and hid the case below.
    end(chunk?: string | Buffer) {
      if (chunk) {
        body = chunk.toString();
      }
    },
  } as unknown as ServerResponse;
  await handleStatusEndpoint(res, join(workDir, "no-log-here"), false);

  // Guarded rather than parsed straight, so an endpoint that stops calling end()
  // — or starts streaming — fails as one of this file's named failures instead of
  // dying on "Unexpected end of JSON input" from inside JSON.parse.
  if (!body) {
    failures.push("/status returned no body at all, so its group summary could not be checked");
    return null;
  }
  return JSON.parse(body) as StatusPayload;
}

/**
 * §5b — a group mixing measured and on-demand signals keeps its liveness.
 *
 * `summariseGroups()` drops a group only when EVERY signal in it is on-demand, and
 * that is a decision rather than an accident: a group with one requested signal and
 * twenty measured ones still has something to say about the twenty. `.some` in place
 * of `.every` would throw all of it away.
 *
 * Nothing in the registry tells the two apart — `waypoint` is the only on-demand
 * group and all three of its signals are flagged — so this feeds
 * `onDemandOnlyGroups()` a mixed group the bike does not have. Both arms are needed:
 * without the second, a function that simply returned an empty set would pass.
 */
function checkAMixedGroupKeepsItsLiveness(): void {
  const mixed: SignalDef[] = [
    { key: "check_measured", unit: "", group: "check_mixed", source: "stream" },
    { key: "check_requested", unit: "", group: "check_mixed", source: "stream", onDemand: true },
    { key: "check_only_requested", unit: "", group: "check_on_demand", source: "stream", onDemand: true },
  ];
  const excluded = onDemandOnlyGroups(mixed);
  if (excluded.has("check_mixed")) {
    failures.push(
      `summariseGroups() drops a group in which only SOME signals are on-demand, so one \`onDemand\` on one signal ` +
        `now deletes liveness for every measured signal beside it. The rule is whole-group: every signal in it, or ` +
        `the group stays in the summary`
    );
  }
  if (!excluded.has("check_on_demand")) {
    failures.push(
      `summariseGroups() keeps a group whose every signal is on-demand, so \`waypoint\` is back in the payload ` +
        `reading [0, 3] on a healthy bike and anything filtering live === 0 fires on it forever`
    );
  }
}

/**
 * §5c — with a bus that IS talking, each key is counted once and only once.
 *
 * Everything in §5a runs against an empty `snapshot()`, which is the dead-bus case
 * for free but leaves the whole second loop of `summariseGroups()` unexercised —
 * including the per-key membership test, which is the part this PR added. Deleting
 * that test left the suite green while every declared key double-counted itself into
 * the denominator the moment the bus woke up.
 *
 * So: define the registry, record one key it declares and one it does not, and ask
 * /status again. `record()` also buffers into the ride log §2 opened, which is
 * harmless — §4 reads segments already sealed there, and these two readings are
 * still in the buffer when it does.
 */
async function checkALiveBusCountsEachKeyOnce(deadBus: StatusPayload): Promise<void> {
  defineSignals(SIGNALS);
  record(LIVE_DECLARED_KEY, 42);
  record(UNDECLARED_KEY, 1);

  const payload = await fetchStatus();
  if (payload === null) {
    return;
  }

  const before = deadBus.groups[LIVE_DECLARED_GROUP];
  const after = payload.groups[LIVE_DECLARED_GROUP];
  if (!before || !after) {
    failures.push(`/status did not report the ${LIVE_DECLARED_GROUP} group, so the live-bus counts cannot be checked`);
    return;
  }
  if (after[1] !== before[1]) {
    failures.push(
      `${LIVE_DECLARED_GROUP} declares ${before[1]} signals on a silent bus and ${after[1]} once one of them ` +
        `arrives. A key the registry already counted must not be counted again when it is heard — that is a ` +
        `denominator growing through a ride, which is what seeding from the registry was meant to end`
    );
  }
  if (after[0] !== 1) {
    failures.push(`${LIVE_DECLARED_GROUP} reported ${after[0]} live signals after exactly one of them was recorded`);
  }

  // An undeclared key has no registry entry, so record() files it under `misc` — a
  // group the seeding loop never creates. It must appear, and it must appear as
  // [1, 1]: the snapshot loop is the only thing that can count it.
  const misc = payload.groups["misc"];
  if (!misc || misc[0] !== 1 || misc[1] !== 1) {
    failures.push(
      `a key no signal declares was recorded and /status reports misc as ${misc ? `[${misc}]` : "absent"}, not ` +
        `[1, 1] — an undecoded key still on the bus has to reach the summary, and only the snapshot can put it there`
    );
  }

  const overFull = Object.entries(payload.groups).filter(([, [groupLive, total]]) => groupLive > total);
  if (overFull.length > 0) {
    failures.push(
      `/status reports more live signals than declared ones for ${overFull.map(([group]) => group).join(", ")} — ` +
        `a fraction reading live > total is the double-count this section exists to catch`
    );
  }
  console.log(`  a live bus reports ${LIVE_DECLARED_GROUP} as [${after}] and an undeclared key as misc [${misc}]`);
}

/**
 * §4 — the claim the caption does make is true.
 *
 * Opens the first segment §2 sealed with the private key that matches it (must
 * succeed, and must contain the reading that went in), then twice more with a
 * stranger's key (must fail). The refusals are the half that matters: they are the
 * difference between "encrypted" as a word in a caption and the property that makes a
 * stolen bike useless.
 *
 * Two refusals rather than one, because the obvious negative case moves two things at
 * once. A stranger's keypair changes the ECDH private key AND the recipient half of
 * the HKDF salt, so a refusal does not say which of them did the work — and the salt
 * is not a secret, so if it were carrying the weight the property would be worthless.
 * The second case holds the real salt and swaps only the private key, which isolates
 * the Diffie-Hellman as the thing the caption's promise actually rests on.
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

  await mustRefuse(
    "an unrelated keypair",
    () => openSegment(stranger.privateKey, stranger.publicRaw, segment),
    "a segment opened with an unrelated keypair — the caption's claim that the log is unreadable without the " +
      "laptop's private key would be false"
  );
  await mustRefuse(
    "a stranger's private key against the real salt",
    () => openSegment(stranger.privateKey, recipient.publicRaw, segment),
    "a segment opened with the right salt but the wrong private key — the salt is public, so if that is what " +
      "locks the log then nothing does"
  );
}

/**
 * Runs an open that must throw, and says so either way.
 *
 * Any throw counts as proof, which is only sound because the must-SUCCEED case above
 * runs first: an `openSegment()` refactored into throwing unconditionally would fail
 * there rather than sail through both refusals looking like three passes. The two arms
 * are what make each other mean anything — do not reorder them, and do not keep one
 * without the other.
 */
async function mustRefuse(what: string, attempt: () => Promise<string>, ifItSucceeds: string): Promise<void> {
  try {
    await attempt();
    failures.push(ifItSucceeds);
  } catch (error) {
    // The expected outcome, and the one worth naming in a run that passed: a caption
    // that promises unreadability is only as good as these lines failing.
    console.log(`  ${what} is refused, as claimed (${(error as Error).message})`);
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
