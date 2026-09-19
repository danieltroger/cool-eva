import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";
import { captureCodecFor, isTruncationError, openCaptureLines } from "./capture-lines.ts";

// Guards scripts/capture-lines.ts, the one thing that opens a compressed capture.
//
//     node --experimental-strip-types scripts/check-capture-reader.ts
//
// ⚠️ The two fixtures are NOT hand-built with zlib. They were produced on the Pi by the
// real `split -C 65536 --filter='gzip -1 -c >> …'` over a real capture, because a
// hand-built file cannot tell "the script writes concatenated members" from "the script
// writes one member" — and concatenated members are the whole point. There is no GNU
// `split` on macOS, so a committed artefact is the only way to test the real tool's output
// on the machine this check runs on. How they were made: docs/can-capture.md.

const FIXTURES = new URL("./fixtures/", import.meta.url);
const CLEAN = fileURLToPath(new URL("capture-pipeline-clean.log.gz", FIXTURES));
const TRUNCATED = fileURLToPath(new URL("capture-pipeline-truncated.log.gz", FIXTURES));

// What the real pipeline put in, and what Node gets back out. Measured, not chosen.
//
// ⚠️ The clean fixture's LAST line is partial too, and deliberately: the input was
// `head -c 400000` of a real capture, so it ends mid-line the way a cut one does. That is
// why 5558 lines carry 5557 newlines. Do not "fix" the fixture to end on a boundary — a
// reader that mishandles a partial final line would then pass.
const CLEAN_LINES = 5558;
// One fewer than the newline count, because readline drops the incomplete final line when
// the stream ends in an error rather than at EOF.
const TRUNCATED_LINES = 5392;

const failures: string[] = [];
const workspace = await mkdtemp(join(tmpdir(), "cool-eva-capture-reader-"));

try {
  await checkCleanFixture();
  await checkTruncatedFixture();
  await checkNulTailedCapture();
  await checkCorruptionStillThrows();
  await checkPlainCapture();
  checkCodecRouting();
  checkTruncationClassification();
  await checkRealFaultsStillThrow();
} finally {
  await rm(workspace, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error("\nFAILED:");
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  process.exit(1);
}
console.log(
  `\n✓ ${CLEAN_LINES} lines out of concatenated 64 kB gzip members; a cut capture yields its ${TRUNCATED_LINES}-line ` +
    "prefix with one warning and no throw, NUL-tailed or not; a missing file still throws"
);

/** A whole capture reads back with no warning at all. */
async function checkCleanFixture(): Promise<void> {
  const { lines, warnings } = await readCapture(CLEAN);
  if (lines.length !== CLEAN_LINES) {
    failures.push(`the clean fixture gave ${lines.length} lines, expected ${CLEAN_LINES}`);
  }
  if (warnings.length !== 0) {
    failures.push(`a complete capture warned ${warnings.length} times, and should warn about nothing: ${warnings[0]}`);
  }
  if (!lines[0].startsWith("# boot ")) {
    failures.push(`the first line is not the boot header capture.sh writes: ${JSON.stringify(lines[0])}`);
  }
  // ⚠️ The multi-member assertion, and it is exact rather than a header count: every
  // member holds at most CHUNK_BYTES (65536) of INPUT, so anything decoding to more than
  // that spans several. A reader that stopped at the first member — which is exactly the
  // defect Node's zstd decompressor has, reporting success after one frame — could not
  // reach this number. Scanning for 1f8b would not do: that pair occurs in deflate output.
  const decoded = lines.reduce((total, line) => total + line.length + 1, 0);
  if (decoded <= 65536) {
    failures.push(
      `the clean fixture decodes to ${decoded} B, within one 65536 B member — it cannot prove multi-member reading`
    );
  }
}

/** A cut capture yields every complete line before the cut, warns once, and does not throw. */
async function checkTruncatedFixture(): Promise<void> {
  const { lines, warnings } = await readCapture(TRUNCATED);
  if (lines.length !== TRUNCATED_LINES) {
    failures.push(
      `the truncated fixture gave ${lines.length} lines, expected ${TRUNCATED_LINES}. If a Node upgrade moved ` +
        "zlib's flush boundary, re-measure and say so in the commit — do not widen this into a range"
    );
  }
  if (warnings.length !== 1) {
    failures.push(`a truncated capture warned ${warnings.length} times, expected exactly 1`);
  } else if (!warnings[0].includes("ends mid-stream")) {
    failures.push(`the truncation warning does not say the capture ends mid-stream: ${warnings[0]}`);
  }
  // ⚠️ The real invariant, and stronger than the count: what comes back is a PREFIX. A
  // decoder that resynchronised and skipped a member would keep the line count plausible
  // while silently dropping frames out of the middle.
  const complete = await readCapture(CLEAN);
  const divergence = lines.findIndex((line, index) => line !== complete.lines[index]);
  if (divergence !== -1) {
    failures.push(`the truncated read is not a prefix of the whole capture — it diverges at line ${divergence}`);
  }
}

/**
 * The delayed-allocation signature: i_size published, blocks never written back, so the
 * file ends in NULs. `evidence/keyoff/tail-shape.py` measures it as the power-cut shape.
 * It decodes as Z_BUF_ERROR, the same code a clean cut gives — measured, after an earlier
 * version of this comment asserted Z_DATA_ERROR and was simply wrong.
 */
async function checkNulTailedCapture(): Promise<void> {
  const holed = join(workspace, "capture-20260919-210000-7ce067a7-00000042.log.gz");
  await writeFile(holed, Buffer.concat([await readFile(TRUNCATED), Buffer.alloc(1500)]));
  const { lines, warnings } = await readCapture(holed);
  if (lines.length < 5000) {
    failures.push(`a NUL-tailed capture gave only ${lines.length} lines — the prefix before the hole was lost`);
  }
  if (warnings.length !== 1) {
    failures.push(`a NUL-tailed capture warned ${warnings.length} times, expected exactly 1`);
  }
}

/**
 * ⚠️ A capture whose bytes are WRONG rather than merely absent must throw, not be read as
 * a short one. One flipped byte 20 000 into the intact fixture returns 147 456 B — 37 % of
 * it — and an over-generous truncation test made that a warning and an exit 0, which is
 * precisely the silent-truncation failure this project rejected zstd for.
 */
async function checkCorruptionStillThrows(): Promise<void> {
  const corrupt = join(workspace, "capture-20260919-210000-7ce067a7-00000043.log.gz");
  const body = Buffer.from(await readFile(CLEAN));
  body[20000] ^= 0xff;
  await writeFile(corrupt, body);
  let threw = "";
  try {
    for await (const line of openCaptureLines(corrupt)) {
      void line;
    }
  } catch (error) {
    threw = (error as { code?: string }).code ?? "";
  }
  if (threw !== "Z_DATA_ERROR") {
    failures.push(
      `a capture with a flipped byte in the middle gave ${threw || "no error"}; corrupt data must throw, ` +
        "or a reader silently returns part of a capture that is all there"
    );
  }
}

/** An uncompressed capture — the whole existing archive — still reads. */
async function checkPlainCapture(): Promise<void> {
  const plain = join(workspace, "capture-20260802-184526-1c8fc1e2.log");
  await writeFile(
    plain,
    "# boot 1c8fc1e2 uptime 00000024\n (2026-08-02 18:45:26.1)  can0  101   [8]  65 64 04 00 00 00 00 00\n"
  );
  const { lines, warnings } = await readCapture(plain);
  if (lines.length !== 2 || warnings.length !== 0) {
    failures.push(`a plain .log capture gave ${lines.length} lines and ${warnings.length} warnings, expected 2 and 0`);
  }
}

function checkCodecRouting(): void {
  const cases: [string, "gzip" | "plain"][] = [
    ["capture-20260919-210000-7ce067a7-00000042.log.gz", "gzip"],
    ["/home/pi/ride-captures/capture-20260802-184526-1c8fc1e2.log", "plain"],
    ["ride-1.log", "plain"],
  ];
  for (const [name, expected] of cases) {
    if (captureCodecFor(name) !== expected) {
      failures.push(`captureCodecFor(${name}) is ${captureCodecFor(name)}, expected ${expected}`);
    }
  }
}

function checkTruncationClassification(): void {
  if (!isTruncationError(Object.assign(new Error("x"), { code: "Z_BUF_ERROR" }))) {
    failures.push("Z_BUF_ERROR is not classified as truncation, so a normal power cut would throw");
  }
  // ⚠️ The other direction matters more: a reader that treats every error as truncation
  // turns a missing or unreadable file into an empty capture and a shrug. Z_DATA_ERROR is
  // in this list, not the one above: it means corrupt data, not a stream that ran out.
  for (const code of ["Z_DATA_ERROR", "ENOENT", "EACCES", undefined]) {
    if (isTruncationError(Object.assign(new Error("x"), code === undefined ? {} : { code }))) {
      failures.push(`${code ?? "an error with no code"} is classified as truncation, which would swallow a real fault`);
    }
  }
  if (isTruncationError(null) || isTruncationError("nope")) {
    failures.push("a non-Error value is classified as truncation");
  }
}

async function checkRealFaultsStillThrow(): Promise<void> {
  let threw = "";
  try {
    for await (const line of openCaptureLines(join(workspace, "does-not-exist.log.gz"))) {
      void line;
    }
  } catch (error) {
    threw = (error as { code?: string }).code ?? "";
  }
  if (threw !== "ENOENT") {
    failures.push(
      `reading a missing capture gave ${threw || "no error"}; it must throw ENOENT rather than read as empty`
    );
  }
}

/** Collects the lines and whatever the reader warned about, so both can be asserted. */
async function readCapture(path: string): Promise<{ lines: string[]; warnings: string[] }> {
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
  try {
    const lines: string[] = [];
    for await (const line of openCaptureLines(path)) {
      lines.push(line);
    }
    return { lines, warnings };
  } finally {
    console.warn = realWarn;
  }
}
