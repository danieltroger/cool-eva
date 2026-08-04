import { IsoTpReassembler } from "../src/can/iso-tp.ts";
import { MODE_STORED_DTCS, decodeObdDtcResponse, formatObdTroubleCode } from "../src/diagnostics/obd-dtc.ts";
import {
  CAPTURED_FREEZE_FRAME_DTC,
  CAPTURED_MODE_03_FRAMES_2026_08_04,
  CAPTURED_STORED_CODE_COUNT,
  parseHexFrame,
} from "./captured-dtc-transfer.ts";
import { formatObdDtc } from "../src/diagnostics/dtc-table.ts";

// Replays a captured OBD-II trouble-code reply through the real ISO-TP reassembler
// and the real decoder, on a laptop, with no bike — the same trick
// scripts/replay-capture.ts plays for the broadcast decoders, and for the same
// reason: the bike is reachable for a few minutes at a time in a garage with no
// reception, and `socketcan` does not build on macOS anyway.
//
// It is also how those two modules are checked. There is no test runner in this
// repo (`npm test` is still the npm placeholder) and this is not the place to
// introduce one, so the decoder is kept trivially callable instead and its fixture
// kept honest: the default input is a REAL transfer, copied frame for frame out of
// a candump taken 2026-08-04, and the assertions at the bottom fail the process if
// either module stops reproducing it.
//
//   node --experimental-strip-types scripts/decode-dtc-response.ts
//   node --experimental-strip-types scripts/decode-dtc-response.ts "10 50 43 27 …" "21 …"
//
// Arguments are whole CAN frames as hex, one per argument, in arrival order. With
// no arguments it replays the capture.

const usingCapture = process.argv.length <= 2;
const frames = (usingCapture ? CAPTURED_MODE_03_FRAMES_2026_08_04 : process.argv.slice(2)).map(readFrame);

const reassembler = new IsoTpReassembler();
let payload: Uint8Array | null = null;

for (const [index, frame] of frames.entries()) {
  const result = reassembler.push(frame);
  console.log(`frame ${String(index + 1).padStart(2)}  ${hex(frame)}  → ${result.status}`);
  if (result.status === "flow-control-required") {
    console.log(`          the bike is waiting for 30 00 00; ${result.totalLength} bytes to come`);
  }
  if (result.status === "abandoned" || result.status === "ignored") {
    console.log(`          ${result.reason}`);
  }
  if (result.status === "complete") {
    payload = result.payload;
  }
}

if (!payload) {
  console.error("\nno complete payload — the frames above never finished a transfer");
  process.exit(1);
}

console.log(`\nreassembled ${payload.length} bytes: ${hex(payload)}\n`);

const response = decodeObdDtcResponse(payload, MODE_STORED_DTCS);
if (response.kind !== "codes") {
  console.error(`decoded as ${response.kind}: ${JSON.stringify(response)}`);
  process.exit(1);
}

console.log(`${response.list} codes: ${response.codes.length} (count byte said ${response.declaredCount})`);
for (const code of response.codes) {
  console.log(`  ${formatObdTroubleCode(code)}`);
}
const unnamed = response.codes.filter(code => code.entry === null);
console.log(`\n${response.codes.length - unnamed.length} named by Energica's table, ${unnamed.length} not listed`);

if (!usingCapture) {
  process.exit(0);
}

// Assertions, only against the checked-in capture — with hand-supplied frames there
// is nothing to assert against.
const failures: string[] = [];
if (payload.length !== 80) {
  failures.push(`payload should be 80 bytes, got ${payload.length}`);
}
if (response.declaredCount !== CAPTURED_STORED_CODE_COUNT) {
  failures.push(`count byte should be ${CAPTURED_STORED_CODE_COUNT}, got ${response.declaredCount}`);
}
if (response.codes.length !== CAPTURED_STORED_CODE_COUNT) {
  failures.push(`should decode ${CAPTURED_STORED_CODE_COUNT} codes, got ${response.codes.length}`);
}
if (response.truncated) {
  failures.push("should not be truncated");
}
// PID 02 named P0514 as the freeze-frame code, so it had better be in the stored
// list too: a freeze frame for a code the bike does not admit to storing would mean
// one of the two decoders is wrong.
const freezeFrameCode = formatObdDtc(CAPTURED_FREEZE_FRAME_DTC);
if (!response.codes.some(code => code.code === freezeFrameCode)) {
  failures.push(`${freezeFrameCode} should be in the list — it is what PID 02 reports and what the lamp is on for`);
}
if (unnamed.length !== 0) {
  failures.push(`every captured code should be in Energica's table, but ${unnamed.length} are not`);
}
// The transfer must fail closed, not open: a dropped Consecutive Frame has to
// produce no payload rather than a short one that decodes into plausible codes.
const gapped = new IsoTpReassembler();
const gapResults = frames.filter((_, index) => index !== 4).map(frame => gapped.push(frame));
if (gapResults.some(result => result.status === "complete")) {
  failures.push("a transfer missing a consecutive frame must not complete");
}
if (!gapResults.some(result => result.status === "abandoned")) {
  failures.push("a transfer missing a consecutive frame must be abandoned out loud");
}
// A First Frame claiming more than the cap must be refused outright rather than
// allocating for it — the whole point of the guard.
const oversized = new IsoTpReassembler().push(parseHexFrame("1F FF 43 27 05 62 10 00"));
if (oversized.status !== "abandoned") {
  failures.push(`a first frame declaring 4095 bytes should be abandoned, got ${oversized.status}`);
}
// A refusal has to decode as a refusal, not as an empty list.
const refusal = decodeObdDtcResponse(parseHexFrame("7F 03 33"), MODE_STORED_DTCS);
if (refusal.kind !== "negative" || refusal.negativeResponseCode !== 0x33) {
  failures.push(`7F 03 33 should decode as a refusal with NRC 0x33, got ${JSON.stringify(refusal)}`);
}
// …and a reply to somebody else's question must not be mistaken for ours. This is
// the mode-01 chatter the poller puts on the same IDs at 2 Hz.
const wrongService = decodeObdDtcResponse(parseHexFrame("41 01 A7 00"), MODE_STORED_DTCS);
if (wrongService.kind !== "unrecognised") {
  failures.push(`a mode-01 reply should not decode as a mode-03 list, got ${wrongService.kind}`);
}

if (failures.length > 0) {
  console.error("\nFAILED:");
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  process.exit(1);
}
console.log("\n✓ replay matches the 2026-08-04 capture; gapped, oversized, refused and foreign replies all rejected");

function readFrame(text: string): Uint8Array {
  try {
    return parseHexFrame(text);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0").toUpperCase()).join(" ");
}
