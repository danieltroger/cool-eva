import { DTC_TABLE, lookupByComponentSymptom } from "../src/diagnostics/dtc-table.ts";
import { ExtendedIsoTpReassembler } from "../src/diagnostics/extended-iso-tp.ts";
import {
  FAULT_INFOKEYS,
  MAX_FREEZE_FRAME_FIELD_BYTES,
  freezeFrameFieldBytes,
  infokeysFor,
  infokeysForObdCode,
} from "../src/diagnostics/fault-infokeys.ts";
import {
  buildFreezeFrameRequestFrame,
  decodeFreezeFrameResponse,
  decodeFreezeFrameStatus,
  expectedFreezeFramePayloadBytes,
  formatFreezeFrameValue,
  toHex,
  type FreezeFrame,
  type FreezeFrameResponse,
} from "../src/diagnostics/freeze-frame.ts";
import { INFOKEY_TABLE, lookupInfokey, scaleInfokeyValue } from "../src/diagnostics/infokey-table.ts";
import { parseHexFrame } from "./captured-dtc-transfer.ts";
import {
  FREEZE_FRAME_P0514_COMPONENT,
  FREEZE_FRAME_P0514_EXPECTED,
  FREEZE_FRAME_P0514_FRAMES,
  FREEZE_FRAME_P0A07_COMPONENT,
  FREEZE_FRAME_P0A07_FRAMES,
  FREEZE_FRAME_REFUSAL_FRAME,
  FREEZE_FRAME_WRONG_COMPONENT_FRAMES,
  freezeFrameBytes,
} from "./freeze-frame-fixtures.ts";

// Checks the freeze-frame channel end to end, minus the bus: the request
// encoding, the extended-addressed ISO-TP reassembly, the payload layout, the
// infokey join and Energica's scalings — plus the malformed replies all of it
// must refuse. Run by `npm test` via scripts/run-checks.ts.
//
//   node --experimental-strip-types scripts/check-freeze-frame.ts
//
// ⚠️ WHAT THIS DOES AND DOES NOT PROVE. The transfers it replays are CONSTRUCTED
// from the documented layout, not captured off the bike — see the header of
// scripts/freeze-frame-fixtures.ts. So §3–§5 prove the decoder is self-consistent
// and handles sign, scaling and truncation correctly; they prove NOTHING about
// whether the VCU's `0x17` reply really has this shape. §1 and §2 are stronger:
// they check the manufacturer's own data against this repo's independently
// sourced DTC table, and a disagreement there would be real.
//
// The one number to watch when the bike is back is `trailingHex`. It is empty in
// every fixture below by construction; if it is non-empty on a real reply, the
// layout is wrong and the bytes are still in hand to work out how.

const failures: string[] = [];

function check(condition: boolean, message: string): void {
  if (!condition) {
    failures.push(message);
  }
}

// ── §1 The infokey dictionary ───────────────────────────────────────────────
console.log("── §1 infokey dictionary ──────────────────────────────────────────");

check(INFOKEY_TABLE.length === 120, `expected 120 infokey fields, got ${INFOKEY_TABLE.length}`);
const gaps = INFOKEY_TABLE.filter((field, index) => field.id !== index + 1);
check(gaps.length === 0, `infokey ids must be a contiguous run 1…120; first break at ${gaps[0]?.id}`);
check(lookupInfokey(0) === null, "infokey 0 must not resolve");
check(lookupInfokey(121) === null, "infokey 121 must not resolve");

// Every equation in the table must be one this repo has looked at. The lookup
// throws on an unknown one, so this is what turns "someone added a field with a
// scaling nobody read" into a red build rather than a surprise on the bike.
for (const field of INFOKEY_TABLE) {
  try {
    scaleInfokeyValue(field, 1);
  } catch (error) {
    failures.push(`infokey ${field.id} (${field.name}): ${error instanceof Error ? error.message : String(error)}`);
  }
}
const refusedScalings = INFOKEY_TABLE.filter(field => !scaleInfokeyValue(field, 1).applied);
check(
  refusedScalings.length === 1 && refusedScalings[0].name === "AvgDOD",
  `exactly one field's equation should be refused (AvgDOD's), got ${refusedScalings.map(f => f.name).join(", ")}`
);
console.log(`${INFOKEY_TABLE.length} fields, ids 1…${INFOKEY_TABLE[INFOKEY_TABLE.length - 1].id}`);
console.log(`refused scalings: ${refusedScalings.map(f => `${f.name} (${f.equation})`).join(", ")}`);

// ── §2 The per-fault shortlists, against this repo's own DTC table ──────────
console.log("\n── §2 per-fault shortlists ────────────────────────────────────────");

check(FAULT_INFOKEYS.length === 155, `expected 155 shortlists, got ${FAULT_INFOKEYS.length}`);

const totalReferences = FAULT_INFOKEYS.reduce((sum, entry) => sum + entry.infokeys.length, 0);
check(totalReferences === 944, `expected 944 infokey references, got ${totalReferences}`);

const dangling = FAULT_INFOKEYS.flatMap(entry =>
  entry.infokeys.filter(id => lookupInfokey(id) === null).map(id => `${entry.component}/${entry.symptom} → ${id}`)
);
check(dangling.length === 0, `every infokey reference must resolve; dangling: ${dangling.join(", ")}`);

const duplicateKeys = FAULT_INFOKEYS.filter(
  (entry, index) =>
    FAULT_INFOKEYS.findIndex(other => other.component === entry.component && other.symptom === entry.symptom) !== index
);
check(duplicateKeys.length === 0, `(component, symptom) must be unique; duplicated: ${duplicateKeys.length}`);

// …and both halves must be in range, which the uniqueness check above does NOT
// imply. The lookup map hashes `component * 16 + symptom`, so a typo'd symptom of
// 16 would collide (54,16) with (55,0): two distinct rows, one bucket, last one
// wins. Nothing on the wire can produce it — the decoder takes the symptom from a
// nibble — but a data-entry error would pass a pairwise uniqueness test and then
// hand a real freeze frame the wrong struct definition, which decodes into
// plausible numbers rather than failing.
const outOfRange = FAULT_INFOKEYS.filter(
  entry => entry.component < 1 || entry.component > 63 || entry.symptom < 0 || entry.symptom > 15
);
check(
  outOfRange.length === 0,
  `component must be 1…63 and symptom 0…15, or the lookup key collides; bad rows: ${outOfRange
    .map(entry => `${entry.component}/${entry.symptom}`)
    .join(", ")}`
);

check(
  MAX_FREEZE_FRAME_FIELD_BYTES === 20,
  `the widest shortlist should be 20 bytes (51/0 P1050), got ${MAX_FREEZE_FRAME_FIELD_BYTES}`
);

// The cross-source check, and the only assertion here that could catch a real
// mistake in the transcription: the service tool's OBD code for a (component, symptom)
// pair against ./dtc-table.ts', which came from the type-approval PDF and has
// been reconciled against this bike's own mode-03 reply.
const codeDisagreements: string[] = [];
const missingFromDtcTable: string[] = [];
for (const entry of FAULT_INFOKEYS) {
  const tableEntry = lookupByComponentSymptom(entry.component, entry.symptom);
  if (!tableEntry) {
    missingFromDtcTable.push(`${entry.component}/${entry.symptom} ${entry.serviceToolObdCode}`);
    continue;
  }
  if (tableEntry.obdCode !== entry.serviceToolObdCode) {
    codeDisagreements.push(
      `${entry.component}/${entry.symptom}: service tool says ${entry.serviceToolObdCode}, dtc-table says ${tableEntry.obdCode}`
    );
  }
}
console.log(`${FAULT_INFOKEYS.length} shortlists, ${totalReferences} references, all resolving`);
console.log(`disagreements with dtc-table.ts: ${codeDisagreements.length}`);
for (const disagreement of codeDisagreements) {
  console.log(`  ${disagreement}`);
}
// EXACTLY the two water-pump codes the service tool swaps relative to the type-approval
// PDF, and no others. A third appearing means one of the two tables moved.
check(
  codeDisagreements.length === 2,
  `expected exactly 2 known disagreements (the (44,0)/(44,2) pump swap), got ${codeDisagreements.length}`
);
check(
  codeDisagreements.every(text => text.startsWith("44/0:") || text.startsWith("44/2:")),
  `the only disagreements may be 44/0 and 44/2; got:\n  ${codeDisagreements.join("\n  ")}`
);
// (35,2) B1021 is deliberately absent from dtc-table.ts — no source states its
// MIL or its description — so it is the one shortlist with no row there.
check(
  missingFromDtcTable.length === 1 && missingFromDtcTable[0] === "35/2 B1021",
  `only (35,2) B1021 should be missing from dtc-table.ts; got: ${missingFromDtcTable.join(", ") || "none"}`
);

// …and the other direction: a code in the DTC table with no shortlist would show
// up on the Faults tab with nothing to say about it.
const withoutShortlist = DTC_TABLE.filter(entry => infokeysFor(entry.component, entry.symptom) === null);
console.log(`dtc-table.ts rows with no shortlist: ${withoutShortlist.length}`);
check(
  withoutShortlist.length === 0,
  `every DTC-table row should have a shortlist; missing: ${withoutShortlist.map(e => e.obdCode).join(", ")}`
);

// The OBD column is not unique, so the by-code lookup has to return every match.
const u0182 = infokeysForObdCode("U0182");
check(u0182.length === 2, `U0182 is filed under two components, so it must return 2 shortlists, got ${u0182.length}`);
check(infokeysForObdCode("P9999").length === 0, "an unknown OBD code must return an empty list, not throw");

// Energica's own empty shortlist. A real answer, not a gap.
const p1052 = infokeysFor(60, 0);
check(p1052 !== null && p1052.infokeys.length === 0, "(60,0) P1052 should have an empty shortlist");

// ── §3 The request encoding, and the read-only guarantee ───────────────────
console.log("\n── §3 request encoding ────────────────────────────────────────────");

const pumpRequest = buildFreezeFrameRequestFrame({
  kind: "read-freeze-frame",
  component: FREEZE_FRAME_P0A07_COMPONENT,
});
console.log(`component 44 → ${toHex(pumpRequest)}`);
check(
  toHex(pumpRequest) === "A8 03 17 00 2C 00 00 00",
  `component 44 should encode as "A8 03 17 00 2C 00 00 00", got "${toHex(pumpRequest)}"`
);
check(pumpRequest.length === 8, `requests go out at a full 8-byte DLC, got ${pumpRequest.length}`);

// A component outside 1…63 must throw rather than be truncated into range — the
// difference between "you asked for something impossible" and "you were
// confidently answered about a different fault".
for (const component of [0, 64, 1300, -1, 4.5, Number.NaN]) {
  let threw = false;
  try {
    buildFreezeFrameRequestFrame({ kind: "read-freeze-frame", component });
  } catch {
    threw = true;
  }
  check(threw, `component ${component} must be refused, not encoded`);
}
// 1300 is 0x0514 — i.e. someone handing this service a mode-03 DTC instead of a
// component number. It is caught above; this names why that case matters.
console.log("out-of-range components refused, including 1300 (= mode-03's P0514 read as a component)");

// ── §4 A whole transfer, reassembled and decoded ───────────────────────────
console.log("\n── §4 replaying the constructed transfers ─────────────────────────");

const pumpFrame = replay(FREEZE_FRAME_P0A07_FRAMES, FREEZE_FRAME_P0A07_COMPONENT, "P0A07");
if (pumpFrame) {
  check(pumpFrame.obdCode === "P0A07", `component 44 symptom 0 should name P0A07, got ${pumpFrame.obdCode}`);
  check(pumpFrame.symptom === 0, `symptom should be 0, got ${pumpFrame.symptom}`);
  check(pumpFrame.recordCount === 1, `one component was asked about, so the count byte should be 1`);
  check(pumpFrame.shortlistKnown, "component 44 symptom 0 has a shortlist");
  check(!pumpFrame.truncated, "the pump frame should not be truncated");
  check(pumpFrame.trailingHex === "", `nothing should be left over, got "${pumpFrame.trailingHex}"`);
  check(pumpFrame.values.length === 7, `expected 7 fields, got ${pumpFrame.values.length}`);
  const pumpCurrent = pumpFrame.values.find(value => value.name === "ai_WaterPumpCurrent_In");
  check(pumpCurrent?.raw === 0, `the pump current should read 0 mA, got ${pumpCurrent?.raw}`);
  check(pumpCurrent?.unit === "mA", `the pump current's unit should be mA, got ${pumpCurrent?.unit}`);
  const igbtA = pumpFrame.values.find(value => value.name === "D_IGBTA_T");
  check(closeEnough(igbtA?.value, 41.2), `D_IGBTA_T should scale to 41.2 °C, got ${igbtA?.value}`);
  check(!pumpFrame.flags.lampOn, "status 0x05 has bit 3 clear, and dtc-table.ts says P0A07 does not light the MIL");
  check(pumpFrame.flags.stored, "status 0x05 has bit 0 set, so the code is stored");
  check(pumpFrame.flags.hasFreezeFrame, "status 0x05 has activity 2, i.e. memory / freeze frame");
  // The length arithmetic that will settle the one open question about the wire
  // format. By construction the fixture is the 5-byte reading, so only 5 fits.
  check(
    pumpFrame.headerBytesThatFit.length === 1 && pumpFrame.headerBytesThatFit[0] === 5,
    `a 17-byte payload with 12 field bytes fits only the 5-byte header, got [${pumpFrame.headerBytesThatFit}]`
  );
}

const lampFrame = replay(FREEZE_FRAME_P0514_FRAMES, FREEZE_FRAME_P0514_COMPONENT, "P0514");
if (lampFrame) {
  check(lampFrame.obdCode === "P0514", `component 4 symptom 2 should name P0514, got ${lampFrame.obdCode}`);
  check(lampFrame.trailingHex === "", `nothing should be left over, got "${lampFrame.trailingHex}"`);
  check(!lampFrame.truncated, "the P0514 frame should not be truncated");
  check(
    lampFrame.values.length === FREEZE_FRAME_P0514_EXPECTED.length,
    `expected ${FREEZE_FRAME_P0514_EXPECTED.length} fields, got ${lampFrame.values.length}`
  );
  // Field by field, against numbers written down by hand rather than recomputed
  // from the same table the decoder reads.
  for (const [index, expected] of FREEZE_FRAME_P0514_EXPECTED.entries()) {
    const actual = lampFrame.values[index];
    if (!actual) {
      failures.push(`field ${index} (${expected.name}) is missing`);
      continue;
    }
    check(actual.name === expected.name, `field ${index} should be ${expected.name}, got ${actual.name}`);
    check(actual.raw === expected.raw, `${expected.name} raw should be ${expected.raw}, got ${actual.raw}`);
    check(
      closeEnough(actual.value, expected.value),
      `${expected.name} should scale to ${expected.value}, got ${actual.value}`
    );
    check(actual.unit === expected.unit, `${expected.name} unit should be "${expected.unit}", got "${actual.unit}"`);
  }
}

// The layout's own prediction: a reply is the header plus the shortlist's bytes,
// and nothing else. If this ever disagrees with a real capture, the header
// comment in src/diagnostics/freeze-frame.ts is what needs correcting.
// Symptom 0, matching the fixture and dtc-table.ts' (44,0) = P0A07. All three of
// component 44's symptoms carry the same shortlist, so picking the wrong one
// would still pass — which is exactly why it is worth being explicit here, on the
// one pair this project has already had to reconcile twice.
const pumpShortlist = infokeysFor(FREEZE_FRAME_P0A07_COMPONENT, 0);
if (pumpShortlist) {
  check(
    expectedFreezeFramePayloadBytes(pumpShortlist) === 17,
    `a P0A07 reply should be 17 payload bytes, the model says ${expectedFreezeFramePayloadBytes(pumpShortlist)}`
  );
  check(freezeFrameFieldBytes(pumpShortlist) === 12, "P0A07's seven fields are 12 bytes");
}

// ── §5 Everything it must refuse ───────────────────────────────────────────
console.log("\n── §5 malformed and foreign replies ───────────────────────────────");

// A refusal is a refusal, never an empty freeze frame.
const refusal = decodeSingle(FREEZE_FRAME_REFUSAL_FRAME, FREEZE_FRAME_P0A07_COMPONENT);
check(
  refusal.kind === "refused" && refusal.negativeResponseCode === 0x31,
  `7F 17 31 should decode as a refusal with NRC 0x31, got ${JSON.stringify(refusal)}`
);

// A well-formed frame about a different component must not be filed under the
// one we asked about. This is the failure that would otherwise be invisible.
const mismatch = replayRaw(FREEZE_FRAME_WRONG_COMPONENT_FRAMES, FREEZE_FRAME_P0A07_COMPONENT);
check(
  mismatch?.kind === "component-mismatch" && mismatch.received === 4 && mismatch.requested === 44,
  `a reply about component 4 to a request for 44 must be a mismatch, got ${mismatch?.kind}`
);

// A reply to somebody else's question. `62` is the parameter-read service the VCU
// sweep puts on these same ids.
const foreign = decodeSingle("F1 05 62 10 E7 01 90", FREEZE_FRAME_P0A07_COMPONENT);
check(foreign.kind === "unrecognised", `a 0x62 parameter reply must not decode as a freeze frame, got ${foreign.kind}`);

// …and somebody else's REFUSAL, which is the same hazard wearing a 7F. The
// parameter sweep asks 0x22 on the same pair, so `7F 22 31` in our reply window
// happens; reporting it as a refusal of OUR read would be a wrong answer wearing
// the right shape.
const foreignRefusal = decodeSingle("F1 03 7F 22 31", FREEZE_FRAME_P0A07_COMPONENT);
check(
  foreignRefusal.kind === "unrecognised",
  `7F 22 31 refuses a parameter read, not ours — expected unrecognised, got ${foreignRefusal.kind}`
);

// Every non-frame outcome must carry the bytes out. On the first live read the
// likeliest outcome is `unrecognised`, and its payload is the evidence for what
// the layout really is — a reason string alone would waste that run.
for (const [label, outcome] of /** @type {const} */ [
  ["refusal", refusal],
  ["foreign service", foreign],
  ["foreign refusal", foreignRefusal],
  ["component mismatch", mismatch],
]) {
  check(
    typeof outcome === "object" && outcome !== null && "rawHex" in outcome && outcome.rawHex.length > 0,
    `${label} must carry rawHex so the bytes survive the failure`
  );
}

// Addressed to another tester: not ours to consume at all.
const notOurs = new ExtendedIsoTpReassembler().push(parseHexFrame("F2 10 11 57 01 00 2C 2D"));
check(notOurs.status === "ignored", `a frame addressed to 0xF2 should be ignored, got ${notOurs.status}`);

// A dropped Consecutive Frame must fail closed. A freeze frame assembled out of
// shifted bytes still comes out as numbers with units on them, which is exactly
// the plausible-looking wrong answer this repo refuses to produce.
const gapped = new ExtendedIsoTpReassembler();
const gapResults = freezeFrameBytes([FREEZE_FRAME_P0A07_FRAMES[0], FREEZE_FRAME_P0A07_FRAMES[2]]).map(frame =>
  gapped.push(frame)
);
check(
  !gapResults.some(result => result.status === "complete"),
  "a transfer missing a consecutive frame must not complete"
);
check(
  gapResults.some(result => result.status === "abandoned"),
  "a transfer missing a consecutive frame must be abandoned out loud"
);

// A short Consecutive Frame must be abandoned, not under-filled. Taking what
// arrived would put the NEXT frame's bytes 4 bytes early, the sequence numbers
// would still run 0, 1, 2…, and the transfer would complete at its declared
// length with every later field shifted — into int16s with °C on them and an
// empty trailingHex. The sequence check would not see it; nothing would.
const shortCf = new ExtendedIsoTpReassembler();
shortCf.push(parseHexFrame(FREEZE_FRAME_P0A07_FRAMES[0]));
const shortCfResult = shortCf.push(parseHexFrame("F1 20 03 00"));
check(
  shortCfResult.status === "abandoned",
  `a consecutive frame carrying 2 bytes where 6 were needed must be abandoned, got ${shortCfResult.status}`
);
// …but the LAST one may legitimately be short, down to whatever is still
// outstanding. The P0514 transfer's final frame carries 5 of a possible 6, so
// this must NOT be caught by the guard above.
const lastShort = new ExtendedIsoTpReassembler();
const lastShortResults = freezeFrameBytes(FREEZE_FRAME_P0514_FRAMES).map(frame => lastShort.push(frame));
check(
  lastShortResults.some(result => result.status === "complete"),
  "a final consecutive frame shorter than 6 payload bytes is legitimate and must still complete"
);

// A First Frame claiming more than the cap must be refused rather than allocated for.
const oversized = new ExtendedIsoTpReassembler().push(parseHexFrame("F1 1F FF 57 01 00 2C 2D"));
check(
  oversized.status === "abandoned",
  `a first frame declaring 4095 bytes should be abandoned, got ${oversized.status}`
);

// Six bytes is all a single frame holds once the address and PCI are paid for.
// A larger claim is a frame from the OTHER addressing mode, and reading it would
// run off the end of an 8-byte frame.
const tooLongSingle = new ExtendedIsoTpReassembler().push(parseHexFrame("F1 07 57 01 00 2C 2D 03"));
check(
  tooLongSingle.status === "ignored",
  `a single frame claiming 7 bytes should be ignored, got ${tooLongSingle.status}`
);

// A truncated body must stop at the first field that does not fit, not skip it —
// skipping would decode every LATER field from the wrong offset. Two bytes are
// chopped off the pump frame, which lands mid-`D_IGBTC_T`.
const shortPayload = parseHexFrame("57 01 00 2C 05 03 00 00 00 02 01 9C 01 95 01");
const shortResult = decodeFreezeFrameResponse(shortPayload, FREEZE_FRAME_P0A07_COMPONENT);
check(shortResult.kind === "frame", "a short payload should still decode what fits");
if (shortResult.kind === "frame") {
  check(shortResult.frame.truncated, "a payload that runs out mid-field must be flagged truncated");
  check(
    shortResult.frame.values.length === 5,
    `five whole fields fit in the shortened payload, got ${shortResult.frame.values.length}`
  );
  // The odd byte D_IGBTC_T needed a second half of. Reported, not dropped: it is
  // one of the bytes the bike sent, and on a real reply it is evidence.
  check(
    shortResult.frame.trailingHex === "01",
    `the half field left over should survive as trailing, got "${shortResult.frame.trailingHex}"`
  );
  check(
    shortResult.frame.headerBytesThatFit.length === 0,
    `a 15-byte payload matches neither header reading, got [${shortResult.frame.headerBytesThatFit}]`
  );
}

// A payload longer than the shortlist keeps the surplus rather than dropping it.
// This is the case that would tell us the layout is wrong on a real bike, so it
// must survive all the way out of the decoder.
const longPayload = parseHexFrame("57 01 00 2C 05 03 00 00 00 02 01 9C 01 95 01 8E 6C AA BB");
const longResult = decodeFreezeFrameResponse(longPayload, FREEZE_FRAME_P0A07_COMPONENT);
check(
  longResult.kind === "frame" && longResult.frame.trailingHex === "AA BB",
  `surplus bytes must be reported, got ${longResult.kind === "frame" ? `"${longResult.frame.trailingHex}"` : longResult.kind}`
);

// A status byte's flags, read against the bit layout the header documents.
const flags = decodeFreezeFrameStatus(0x2d);
check(
  flags.lampOn && flags.stored && flags.activity === 2 && flags.hasFreezeFrame,
  "0x2D should decode as lamp+stored+freeze-frame"
);
const quiet = decodeFreezeFrameStatus(0x40);
check(!quiet.lampOn && !quiet.stored && quiet.activity === 0, "0x40 should decode as symptom 4 with nothing set");

// A component the tool has a code for but no shortlist cannot happen today (§2
// asserts that), so the "no shortlist" arm is reached with a made-up pair. It
// must NOT look like an empty frame: the body survives as trailing bytes.
const unknownPair = decodeFreezeFrameResponse(parseHexFrame("57 01 00 04 F0 11 22 33"), 4);
check(unknownPair.kind === "frame", "an unknown (component, symptom) should still decode its header");
if (unknownPair.kind === "frame") {
  check(!unknownPair.frame.shortlistKnown, "symptom 15 of component 4 has no shortlist");
  check(
    unknownPair.frame.trailingHex === "11 22 33",
    `with no shortlist the whole body is trailing, got "${unknownPair.frame.trailingHex}"`
  );
  check(unknownPair.frame.values.length === 0, "no shortlist means no fields could be named");
}

if (failures.length > 0) {
  console.error("\nFAILED:");
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  process.exit(1);
}
console.log(
  "\n✓ 120 infokeys, 155 shortlists and 944 references check out against dtc-table.ts;" +
    " both constructed transfers reassemble and decode; refusals, wrong components, gapped," +
    " short, oversized, truncated, surplus and foreign replies all rejected, with their bytes kept"
);
console.log("⚠️  the transfers are CONSTRUCTED — no 0x17 payload has ever been captured. See the PR.");

/** Reassembles and decodes one transfer, printing every step. Returns null on failure. */
function replay(frames: readonly string[], component: number, label: string): FreezeFrame | null {
  const response = replayRaw(frames, component);
  if (!response) {
    failures.push(`${label}: the frames never finished a transfer`);
    return null;
  }
  if (response.kind !== "frame") {
    failures.push(`${label}: decoded as ${response.kind} — ${JSON.stringify(response)}`);
    return null;
  }
  const { frame } = response;
  console.log(
    `\n${label} — component ${frame.component} symptom ${frame.symptom}, status 0x${frame.status.toString(16)}`
  );
  console.log(`  ${frame.description ?? "not in Energica's table"}`);
  console.log(`  raw: ${frame.rawHex}`);
  for (const value of frame.values) {
    console.log(`    ${formatFreezeFrameValue(value)}`);
  }
  if (frame.trailingHex) {
    console.log(`  ⚠️ trailing bytes: ${frame.trailingHex}`);
  }
  return frame;
}

/** Reassembles a transfer and decodes it, without asserting anything. */
function replayRaw(frames: readonly string[], component: number) {
  const reassembler = new ExtendedIsoTpReassembler();
  for (const frame of freezeFrameBytes(frames)) {
    const result = reassembler.push(frame);
    if (result.status === "complete") {
      return decodeFreezeFrameResponse(result.payload, component);
    }
  }
  return null;
}

/** Decodes a single-frame reply given as one hex frame. */
function decodeSingle(frame: string, component: number): FreezeFrameResponse {
  const result = new ExtendedIsoTpReassembler().push(parseHexFrame(frame));
  if (result.status !== "complete") {
    // Kept in the same shape the decoder returns, rawHex included, so a caller
    // asserting "every failure carries its bytes" cannot be satisfied by a hole
    // this helper punched rather than by the code under test.
    return {
      kind: "unrecognised",
      reason: `frame did not reassemble: ${result.status}`,
      rawHex: toHex(parseHexFrame(frame)),
    };
  }
  return decodeFreezeFrameResponse(result.payload, component);
}

/** Floating-point comparison for scaled values; 1e-9 is far below any real resolution. */
function closeEnough(actual: number | null | undefined, expected: number): boolean {
  return typeof actual === "number" && Math.abs(actual - expected) < 1e-9;
}
