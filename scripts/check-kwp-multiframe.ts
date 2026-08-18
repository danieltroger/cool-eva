import { ExtendedIsoTpReassembler } from "../src/diagnostics/extended-iso-tp.ts";
import { monotonicNow, since } from "../src/monotonic.ts";
import { decodeFreezeFrameResponse } from "../src/diagnostics/freeze-frame.ts";
import { describeFreezeFrameLogResult, startFreezeFrameLogRead } from "../src/vcu/freeze-frame-log.ts";
import { createVcuKwpClient } from "../src/vcu/kwp-client.ts";
import {
  buildFlowControlFrame,
  decodeMultiFrameReply,
  decodeStoredDtcList,
  encodeMultiFrameRequestPayload,
  expectedResponseService,
  isUploadFinished,
  parseFlowControlFrame,
  readUploadGrant,
  segmentRequestPayload,
  toHex,
  type VcuMultiFrameRequest,
} from "../src/vcu/multiframe-codec.ts";
import { startMultiFrameTransfer, type MultiFrameResult } from "../src/vcu/multiframe-transfer.ts";
import { busHeldBy } from "../src/vcu/bus-lease.ts";
import { parseHexFrame } from "./captured-dtc-transfer.ts";
import { FREEZE_FRAME_P0A07_COMPONENT, FREEZE_FRAME_P0A07_FRAMES } from "./freeze-frame-fixtures.ts";
import {
  BANK2_IDENTIFIER_0001_FRAMES,
  BANK2_IDENTIFIER_0001_PAYLOAD,
  BANK2_IDENTIFIER_0001_RECORD,
  FOREIGN_POSITIVE_FRAME,
  FOREIGN_REFUSAL_FRAME,
  LIST_STORED_DTCS_FRAME,
  MALFORMED_TRANSFERS,
  OTHER_TESTER_FRAME,
  REQUEST_UPLOAD_FIRST_FRAME,
  SHORT_FINAL_FRAME_PAYLOAD,
  SHORT_FINAL_FRAME_TRANSFER,
  STORED_DTC_LIST_EXPECTED,
  STORED_DTC_LIST_FRAMES,
  UPLOAD_BLOCK_BODIES,
  UPLOAD_GRANT_BODY,
} from "./kwp-multiframe-fixtures.ts";
import { simulateVcuMicros } from "./simulated-vcu-micro.ts";

// Checks the multi-frame half of the VCU's custom-KWP channel: the request
// encodings and the read-only guard, ISO-TP segmentation and flow control in both
// directions, the transport's caps and timeouts, the malformed replies it must
// refuse, and the whole `0x35`/`0x36`/`0x37` bulk sequence with its cancellation.
// Run by `npm test` via scripts/run-checks.ts.
//
//   node --experimental-strip-types scripts/check-kwp-multiframe.ts
//
// ── ⚠️ WHAT THIS PROVES, AND WHAT IT CANNOT ────────────────────────────────
// The REQUEST side has real evidence and this check leans on all of it. §2 asserts
// that the segmenter reproduces `A8 10 0C 35 12 FF FF FF` byte for byte — a frame
// captured off this bike — and §1 that the `0x18` request matches the one
// recovered from the manufacturer's code.
//
// The REPLY side has almost none. §3 replays the only multi-frame reply on this
// channel with real bytes behind it, and even that is two independent live
// records joined by one inferred frame (see the fixtures' §A). Every other reply
// below is CONSTRUCTED from the documented framing, so §4 onwards prove that this
// transport is self-consistent and that it refuses what it should — properties of
// our code, which is what a check can honestly cover — and prove nothing about
// what the VCU actually sends.
//
// §5 is the part worth keeping whatever the wire turns out to look like: a
// transport that completes a transfer from a short Consecutive Frame produces a
// plausible wrong answer, and that failure is ours to prevent, not the bike's.

const failures: string[] = [];

function check(condition: boolean, message: string): void {
  if (!condition) {
    failures.push(message);
  }
}

/** The frames a request segments into, as space-separated hex, for byte-exact assertions. */
function framesFor(request: VcuMultiFrameRequest): string[] {
  return segmentRequestPayload("A8", encodeMultiFrameRequestPayload(request)).map(toHex);
}

// ── §1 Request encoding, and the read-only guard ────────────────────────────
console.log("── §1 requests ──");

const freezeFrameRequest: VcuMultiFrameRequest = { kind: "read-freeze-frame", component: FREEZE_FRAME_P0A07_COMPONENT };
check(
  framesFor(freezeFrameRequest)[0] === "A8 03 17 00 2C 00 00 00",
  `0x17 for component 44 should be "A8 03 17 00 2C 00 00 00", got "${framesFor(freezeFrameRequest)[0]}"`
);
check(framesFor(freezeFrameRequest).length === 1, "a 0x17 request is 3 payload bytes and must be one frame");

// Byte-for-byte against obd-garage/OTHER_TOOL_AUDIT.md §4.3's decompiled frame.
// The operand is not decoration: that note records a bare status byte being
// rejected with incorrectMessageLengthOrInvalidFormat.
check(
  framesFor({ kind: "list-stored-dtcs" })[0] === LIST_STORED_DTCS_FRAME,
  `0x18 should be "${LIST_STORED_DTCS_FRAME}", got "${framesFor({ kind: "list-stored-dtcs" })[0]}"`
);

check(framesFor({ kind: "transfer-data" })[0] === "A8 01 36 00 00 00 00 00", "0x36 should be a bare single frame");
check(
  framesFor({ kind: "request-transfer-exit" })[0] === "A8 01 37 00 00 00 00 00",
  "0x37 should be a bare single frame"
);

check(expectedResponseService(freezeFrameRequest) === 0x57, "0x17 should expect a 0x57 reply");
check(expectedResponseService({ kind: "transfer-data" }) === 0x76, "0x36 should expect a 0x76 reply");

// A component the DTC table cannot name must throw BEFORE anything is framed, not
// be truncated into a different, valid-looking request. 1300 is `0x0514` — someone
// handing this a P0514 from mode 03's encoding, which is the documented trap.
let componentRejected = false;
try {
  encodeMultiFrameRequestPayload({ kind: "read-freeze-frame", component: 1300 });
} catch {
  componentRejected = true;
}
check(componentRejected, "a component outside 1…63 must be refused by the encoder, not framed");

// The standing guarantee, checked against the encoder rather than against a habit.
const everyRequest: VcuMultiFrameRequest[] = [
  freezeFrameRequest,
  { kind: "list-stored-dtcs" },
  { kind: "request-upload-freeze-frame-log" },
  { kind: "transfer-data" },
  { kind: "request-transfer-exit" },
];
const emittedServices = new Set(everyRequest.map(request => encodeMultiFrameRequestPayload(request)[0]));
check(
  [...emittedServices].every(service => [0x17, 0x18, 0x35, 0x36, 0x37].includes(service)),
  `only 17/18/35/36/37 may be emitted, saw ${[...emittedServices].map(s => s.toString(16)).join(", ")}`
);
check(emittedServices.size === 5, "all five services should be reachable, and no more than five");

console.log(`✓ five read services encode, and nothing else can be expressed`);

// ── §2 Segmentation, against the one captured multi-frame request ───────────
console.log("\n── §2 segmentation and flow control ──");

const uploadFrames = framesFor({ kind: "request-upload-freeze-frame-log" });
// THE strongest assertion in this file: a frame this repo builds, compared with a
// frame captured off this bike on 2026-08-08.
check(
  uploadFrames[0] === REQUEST_UPLOAD_FIRST_FRAME,
  `the 0x35 first frame should be the captured "${REQUEST_UPLOAD_FIRST_FRAME}", got "${uploadFrames[0]}"`
);
check(uploadFrames.length === 3, `12 payload bytes should segment into 3 frames, got ${uploadFrames.length}`);
check(uploadFrames[1] === "A8 21 FF FF FF FF FF FF", `consecutive frame 1 wrong: "${uploadFrames[1]}"`);
check(uploadFrames[2] === "A8 22 FF 00 00 00 00 00", `consecutive frame 2 wrong: "${uploadFrames[2]}"`);

// The segmenter and the reassembler must be exact inverses, or a request that
// looks right in isolation still arrives wrong.
const roundTripped = new ExtendedIsoTpReassembler(64);
let roundTripPayload: string | null = null;
for (const frame of segmentRequestPayload(
  "A8",
  encodeMultiFrameRequestPayload({ kind: "request-upload-freeze-frame-log" })
)) {
  // Re-addressed to the tester so the reply-side reassembler will look at it; the
  // PCI bytes, which are what is under test, are untouched.
  const asReply = Uint8Array.from(frame);
  asReply[0] = 0xf1;
  const result = roundTripped.push(asReply);
  if (result.status === "complete") {
    roundTripPayload = toHex(result.payload);
  }
}
check(
  roundTripPayload === "35 12 FF FF FF FF FF FF FF FF FF FF",
  `segment→reassemble should round-trip the 0x35 request, got "${roundTripPayload}"`
);

check(toHex(buildFlowControlFrame("A8")) === "A8 30 FF 00 00 00 00 00", "A8's flow control should be A8 30 FF 00");
check(toHex(buildFlowControlFrame("A9")) === "A9 30 FF 00 00 00 00 00", "A9's flow control should be A9 30 FF 00");

const clearToSend = parseFlowControlFrame(parseHexFrame("F1 30 00 14"));
check(
  clearToSend?.status === "clear-to-send" && clearToSend.blockSize === 0 && clearToSend.separationTimeMs === 20,
  "F1 30 00 14 should read as clear-to-send, unlimited block size, 20 ms separation"
);
check(parseFlowControlFrame(parseHexFrame("F1 31 00 00"))?.status === "wait", "F1 31 should read as WAIT");
check(parseFlowControlFrame(parseHexFrame("F1 32 00 00"))?.status === "overflow", "F1 32 should read as OVERFLOW");
check(
  parseFlowControlFrame(parseHexFrame("F1 3F 00 00"))?.status === "unrecognised",
  "an undefined flow status must be reported, never treated as clear-to-send"
);
// The sub-millisecond and reserved ranges. Being slower than asked is polite;
// being faster risks the micro dropping frames, so a reserved value takes the
// maximum rather than zero.
check(parseFlowControlFrame(parseHexFrame("F1 30 00 F1"))?.status === "clear-to-send", "0xF1 separation should parse");
const reserved = parseFlowControlFrame(parseHexFrame("F1 30 00 80"));
check(
  reserved?.status === "clear-to-send" && reserved.separationTimeMs === 127,
  "a reserved separation time must take the 127 ms maximum, not 0"
);
check(parseFlowControlFrame(parseHexFrame("F1 03 7F 17 31")) === null, "a refusal is not a flow-control frame");
check(
  parseFlowControlFrame(parseHexFrame("A8 30 FF 00")) === null,
  "our own outbound flow control is not addressed to us"
);

// ⚠️ Regression: the flow-control WINDOW's timer must be cleared when the micro
// answers, not only when a branch happens to re-arm it.
//
// The micro says "clear to send, but leave 40 ms between frames" while the window
// this transfer was given is 20 ms. The window is over — it was answered — so
// nothing should fire. With the timer left armed it fires mid-send, logs that no
// flow control came when one just did (on the ONE question this transfer exists to
// settle), and resets the separation time to 0, so the rest of the request ignores
// the only thing the micro asked for. Timing is the observable difference.
{
  const transmittedAt: number[] = [];
  const startedAt = monotonicNow();
  const transfer = startMultiFrameTransfer({
    target: "A8",
    requestPayload: encodeMultiFrameRequestPayload({ kind: "request-upload-freeze-frame-log" }),
    send: () => transmittedAt.push(Math.round(since(startedAt))),
    maxPayloadBytes: 256,
    firstReplyTimeoutMs: 60,
    transferTimeoutMs: 60,
    requestFlowControlTimeoutMs: 20,
  });
  // `30 00 28` — clear to send, unlimited block size, 40 ms separation.
  setTimeout(() => transfer.handleFrame(Buffer.from(parseHexFrame("F1 30 00 28"))), 2);
  const result = await transfer.finished;
  check(transmittedAt.length === 3, `all three request frames should go out, got ${transmittedAt.length}`);
  check(
    result.kind === "timeout" && result.stage === "first-reply",
    `and then wait for a reply, got ${describe(result)}`
  );
  // The gap between the two consecutive frames is what the micro asked for. A
  // stale timer firing at 20 ms would have sent the second one early.
  const separation = transmittedAt[2] - transmittedAt[1];
  check(separation >= 35, `the micro's 40 ms separation time must be honoured, frames were ${separation} ms apart`);
}

console.log("✓ the 0x35 request segments to the frame captured on 2026-08-08, and round-trips");

// ── §3 The one multi-frame reply with real bytes behind it ──────────────────
console.log("\n── §3 replaying A8 bank-2 identifier 0x2001 ──");

const replayed = await replayReply(BANK2_IDENTIFIER_0001_FRAMES, { kind: "read-freeze-frame", component: 44 });
check(
  replayed.result.kind === "payload" && toHex(replayed.result.payload) === BANK2_IDENTIFIER_0001_PAYLOAD,
  `the captured transfer should reassemble to "${BANK2_IDENTIFIER_0001_PAYLOAD}", got ${describe(replayed.result)}`
);
// The reply is a `0x62` parameter read, not the `0x57` we asked for. The point of
// replaying it here is the FRAMING, and the service check catching it is the
// second half of the same assertion: real bytes, correctly reassembled, correctly
// identified as somebody else's answer.
if (replayed.result.kind === "payload") {
  const reply = decodeMultiFrameReply(replayed.result.payload, 0x57);
  check(reply.kind === "unrecognised", "a 0x62 reply must not be filed as our 0x57 answer");
  const asParameterRead = decodeMultiFrameReply(replayed.result.payload, 0x62);
  check(
    asParameterRead.kind === "positive" && toHex(asParameterRead.body.subarray(2)) === BANK2_IDENTIFIER_0001_RECORD,
    `the record inside should be CAN_MAP.md's "${BANK2_IDENTIFIER_0001_RECORD}"`
  );
}
// The flow control must have gone out, and to the target the CALLER named — the
// property src/vcu/param-codec.ts' header claims for the whole client.
check(
  replayed.transmitted.includes("A8 30 FF 00 00 00 00 00"),
  `a first frame must be answered with flow control, sent: ${replayed.transmitted.join(" | ")}`
);
check(
  replayed.transmitted[0] === "A8 03 17 00 2C 00 00 00",
  "the request must go out before anything else, so no reply can be missed"
);

console.log(`✓ ${BANK2_IDENTIFIER_0001_PAYLOAD} — reassembled, and the flow control went to A8`);

// ── §4 A constructed 0x17 reply, end to end into the decoder ────────────────
console.log("\n── §4 a freeze frame through the transport ──");

const freezeFrame = await replayReply(FREEZE_FRAME_P0A07_FRAMES, freezeFrameRequest);
check(
  freezeFrame.result.kind === "payload",
  `the P0A07 fixture should reassemble, got ${describe(freezeFrame.result)}`
);
if (freezeFrame.result.kind === "payload") {
  const decoded = decodeFreezeFrameResponse(freezeFrame.result.payload, FREEZE_FRAME_P0A07_COMPONENT);
  check(decoded.kind === "frame", `and decode as a frame, got ${decoded.kind}`);
  if (decoded.kind === "frame") {
    // The tell that settles the 4-vs-5-byte header question on the first real
    // reply. Asserted here so that a transport change which silently dropped or
    // added a byte would show up as the layout looking wrong.
    check(
      decoded.frame.trailingHex === "",
      `trailingHex should be empty on a well-formed frame, got "${decoded.frame.trailingHex}"`
    );
  }
}

const dtcList = await replayReply(STORED_DTC_LIST_FRAMES, { kind: "list-stored-dtcs" });
check(dtcList.result.kind === "payload", `the 0x18 fixture should reassemble, got ${describe(dtcList.result)}`);
if (dtcList.result.kind === "payload") {
  const reply = decodeMultiFrameReply(dtcList.result.payload, 0x58);
  check(reply.kind === "positive", "the 0x18 fixture should decode as a positive reply");
  if (reply.kind === "positive") {
    const list = decodeStoredDtcList(reply.body);
    check(
      list.declaredCount === STORED_DTC_LIST_EXPECTED.declaredCount,
      `0x18 should declare ${STORED_DTC_LIST_EXPECTED.declaredCount} records, said ${list.declaredCount}`
    );
    check(
      list.records.map(record => record.code).join(",") === STORED_DTC_LIST_EXPECTED.codes.join(","),
      `0x18 codes wrong: ${list.records.map(record => record.code).join(",")}`
    );
    // Reported, not filtered. The service tool drops these; doing so here would make
    // "the micro padded its reply" indistinguishable from "component 0 has a fault".
    check(
      list.paddingRecords === STORED_DTC_LIST_EXPECTED.paddingRecords,
      `padding records should be counted, not dropped: got ${list.paddingRecords}`
    );
    check(list.trailingHex === "" && !list.truncated, "a well-formed 0x18 reply should leave nothing over");
  }
}

console.log("✓ 0x17 reaches the freeze-frame decoder and 0x18 lists its components");

// ── §5 The malformed replies, which is the part that must never regress ─────
console.log("\n── §5 refusals ──");

for (const malformed of MALFORMED_TRANSFERS) {
  const attempt = await replayReply(malformed.frames, freezeFrameRequest, { firstReplyTimeoutMs: 40 });
  check(
    attempt.result.kind !== "payload",
    `${malformed.name}: must NOT complete — ${malformed.because}. Got ${describe(attempt.result)}`
  );
  if (malformed.refusal === "abandoned") {
    check(
      attempt.result.kind === "abandoned",
      `${malformed.name}: should be abandoned with a reason, got ${describe(attempt.result)}`
    );
  } else {
    // Not recognised as ours at all, so the frames went back to the shared socket
    // and the window timed out. Consuming them would starve whoever they belong to.
    check(
      attempt.result.kind === "timeout" && attempt.consumed === 0,
      `${malformed.name}: should be handed back unconsumed, got ${describe(attempt.result)} after ${attempt.consumed} consumed`
    );
  }
  console.log(`  ✓ ${malformed.name} — ${describe(attempt.result)}`);
}

// The counterpart, and the reason "reject every short frame" is not the fix: the
// LAST consecutive frame of a transfer legitimately carries only what is left.
const shortFinal = await replayReply(SHORT_FINAL_FRAME_TRANSFER, freezeFrameRequest);
check(
  shortFinal.result.kind === "payload" && toHex(shortFinal.result.payload) === SHORT_FINAL_FRAME_PAYLOAD,
  `a legitimately short FINAL frame must still complete, got ${describe(shortFinal.result)}`
);

// Well-formed replies that are somebody else's answer.
const foreignPositive = await replayReply([FOREIGN_POSITIVE_FRAME], freezeFrameRequest);
check(foreignPositive.result.kind === "payload", "a foreign single frame still reassembles — it is well-formed");
if (foreignPositive.result.kind === "payload") {
  check(
    decodeMultiFrameReply(foreignPositive.result.payload, 0x57).kind === "unrecognised",
    "a 0x62 reply must not be filed as our freeze frame"
  );
}
const foreignRefusal = await replayReply([FOREIGN_REFUSAL_FRAME], freezeFrameRequest);
if (foreignRefusal.result.kind === "payload") {
  const reply = decodeMultiFrameReply(foreignRefusal.result.payload, 0x57);
  // The subtle one: `7F 22 31` is a perfectly good negative response, and reading
  // it as "the freeze frame was refused" would be a confident wrong answer about a
  // question nobody asked.
  check(reply.kind === "unrecognised", `a refusal naming 0x22 must not read as OUR refusal, got ${reply.kind}`);
}
const otherTester = await replayReply([OTHER_TESTER_FRAME], freezeFrameRequest, { firstReplyTimeoutMs: 40 });
check(otherTester.consumed === 0, "a frame addressed to another tester must not be consumed");

// A responder that floods frames CONTRIBUTING NOTHING must terminate on its own
// terms rather than on the clock's — so the timeouts below are set far longer than
// the flood takes, and a pass means a cap fired rather than the clock.
//
// There are TWO caps and they catch different floods, which is why both exist:
// the reassembler's bounds frames it is offered, and the transport's bounds the
// ones it never sees. A flow-control frame is the second kind — the reassembler
// deliberately ignores those, so nothing there would ever count them.
const consecutiveFlood = await replayReply(new Array<string>(200).fill("F1 21 3C B6 00 00 00 00"), freezeFrameRequest, {
  firstReplyTimeoutMs: 5000,
});
check(
  consecutiveFlood.result.kind === "abandoned" && consecutiveFlood.result.reason.includes("frames in one transfer"),
  `a consecutive-frame flood should hit the reassembler's cap, got ${describe(consecutiveFlood.result)}`
);
const flowControlFlood = await replayReply(new Array<string>(200).fill("F1 30 00 00"), freezeFrameRequest, {
  firstReplyTimeoutMs: 5000,
});
check(
  flowControlFlood.result.kind === "abandoned" && flowControlFlood.result.reason.includes("frames in one exchange"),
  `a flow-control flood should hit the transport's own cap, got ${describe(flowControlFlood.result)}`
);

console.log("✓ every malformed reply is refused, and a short FINAL frame still completes");

// ── §6 Timeouts, by stage ───────────────────────────────────────────────────
console.log("\n── §6 timeouts ──");

const silent = await replayReply([], freezeFrameRequest, { firstReplyTimeoutMs: 30 });
check(
  silent.result.kind === "timeout" && silent.result.stage === "first-reply",
  `silence should time out at first-reply, got ${describe(silent.result)}`
);
const stalled = await replayReply([BANK2_IDENTIFIER_0001_FRAMES[0]], freezeFrameRequest, { transferTimeoutMs: 30 });
check(
  stalled.result.kind === "timeout" && stalled.result.stage === "reply-transfer",
  `a first frame then silence should time out at reply-transfer, got ${describe(stalled.result)}`
);

console.log("✓ silence and a stalled transfer are different claims, and are reported as such");

// ── §7 The transport against a simulated micro ──────────────────────────────
console.log("\n── §7 the 0x35/0x36/0x37 sequence ──");

// With the micro answering our multi-frame request's first frame, and without —
// because which one the bike does is genuinely unknown, and the no-flow-control
// path is the one that would otherwise never run.
for (const sendsRequestFlowControl of [true, false]) {
  const bus = simulateVcuMicros([
    {
      target: "A8",
      records: new Map(),
      sendsRequestFlowControl,
      upload: {
        grantBody: parseHexFrame(UPLOAD_GRANT_BODY),
        blocks: UPLOAD_BLOCK_BODIES.map(parseHexFrame),
      },
    },
  ]);
  const client = createVcuKwpClient(bus.channel, {
    paceMs: 1,
    responseTimeoutMs: 60,
    multiFrame: { firstReplyTimeoutMs: 120, transferTimeoutMs: 120, requestFlowControlTimeoutMs: 40 },
  });
  bus.channel.addListener("onMessage", message => client.handleFrame(message.id, message.data));

  const read = await startFreezeFrameLogRead({ client, paceMs: 1 }).finished;
  const label = sendsRequestFlowControl ? "with flow control" : "without flow control";
  check(
    read.completion === "finished",
    `${label}: the log read should finish, got "${read.completion}" ${read.reason}`
  );
  check(
    read.blocks.length === UPLOAD_BLOCK_BODIES.length,
    `${label}: should collect ${UPLOAD_BLOCK_BODIES.length} blocks, got ${read.blocks.length}`
  );
  check(
    read.blocks.map(toHex).join(" / ") === UPLOAD_BLOCK_BODIES.join(" / "),
    `${label}: blocks must come back byte-for-byte and in order`
  );
  check(
    read.grant?.rawHex === UPLOAD_GRANT_BODY && read.grant.asCaptured,
    `${label}: the grant should be "${UPLOAD_GRANT_BODY}"`
  );
  check(read.exit === "acknowledged", `${label}: the 0x37 close should be acknowledged`);

  // The micro refuses a `0x35` whose reassembled length is not 12, so this also
  // proves the consecutive frames arrived and were reassembled correctly on the
  // far side — including on the path where nobody asked for them.
  check(
    bus.sentRequests.some(request => request === "A8 35 12 FF FF FF FF FF FF FF FF FF FF"),
    `${label}: the micro should have received the whole 12-byte 0x35 request`
  );
  check(
    bus.sentFrames.includes("A8 30 FF 00 00 00 00 00"),
    `${label}: multi-frame 0x36 replies must draw a flow-control frame from us`
  );

  // The standing guarantee, checked against every byte that reached the bus.
  const services = new Set(bus.sentRequests.map(request => request.split(" ")[1]));
  check(
    [...services].every(service => ["10", "3E", "22", "17", "18", "35", "36", "37"].includes(service)),
    `${label}: only read services may be transmitted, saw ${[...services].join(", ")}`
  );
  client.stop();
  console.log(`  ✓ ${label}: ${describeFreezeFrameLogResult(read)}`);
}

// A micro that ends the upload by refusing rather than by an empty body.
{
  const bus = simulateVcuMicros([
    {
      target: "A8",
      records: new Map(),
      upload: {
        grantBody: parseHexFrame(UPLOAD_GRANT_BODY),
        blocks: UPLOAD_BLOCK_BODIES.map(parseHexFrame),
        afterLastBlock: "refuse",
      },
    },
  ]);
  const client = createVcuKwpClient(bus.channel, { paceMs: 1, responseTimeoutMs: 60 });
  bus.channel.addListener("onMessage", message => client.handleFrame(message.id, message.data));
  const read = await startFreezeFrameLogRead({ client, paceMs: 1 }).finished;
  // A refusal after the last block is a FAILURE, not a completion. The distinction
  // matters: "the micro said that is all" and "the micro would not say" are
  // different claims, and only one of them means the log is whole.
  check(read.completion === "failed", `a refusal after the last block should fail, got "${read.completion}"`);
  check(read.blocks.length === UPLOAD_BLOCK_BODIES.length, "and the blocks already read must be kept");
  check(read.exit === "acknowledged", "and the transfer should still be closed politely");
  client.stop();
  console.log(`  ✓ refusal after the last block: ${describeFreezeFrameLogResult(read)}`);
}

// ⚠️ Regression: a `0x35` that FAILS is not the same as a `0x35` that opened
// nothing.
//
// The micro here opens the upload and then says nothing — the reply is lost, or
// the window expires under a busy bus. The read has to fail, but it must still
// send `0x37`, because A8 is now holding an upload that would make the NEXT read's
// `0x35` get refused. Only a refusal, a dead session or a dead socket prove there
// is nothing to close.
{
  const bus = simulateVcuMicros([
    {
      target: "A8",
      records: new Map(),
      silentServices: [0x35],
      upload: { grantBody: parseHexFrame(UPLOAD_GRANT_BODY), blocks: UPLOAD_BLOCK_BODIES.map(parseHexFrame) },
    },
  ]);
  const client = createVcuKwpClient(bus.channel, {
    paceMs: 1,
    responseTimeoutMs: 40,
    multiFrame: { firstReplyTimeoutMs: 60, requestFlowControlTimeoutMs: 20 },
  });
  bus.channel.addListener("onMessage", message => client.handleFrame(message.id, message.data));
  const read = await startFreezeFrameLogRead({ client, paceMs: 1 }).finished;
  check(read.completion === "failed", `a silent 0x35 should fail the read, got "${read.completion}"`);
  check(read.blocks.length === 0, "and collect nothing");
  check(read.exit === "acknowledged", "but it MUST still close the upload it may have opened");
  check(
    bus.sentRequests.filter(request => request === "A8 37").length === 1,
    "0x37 should go out exactly once after a silent 0x35"
  );
  client.stop();
  console.log(`  ✓ silent 0x35: ${describeFreezeFrameLogResult(read)}`);
}

// The other side of that rule: a micro that REFUSES the 0x35 has opened nothing,
// so there is nothing to close and no frame is owed.
{
  const bus = simulateVcuMicros([{ target: "A8", records: new Map() }]);
  const client = createVcuKwpClient(bus.channel, { paceMs: 1, responseTimeoutMs: 60 });
  bus.channel.addListener("onMessage", message => client.handleFrame(message.id, message.data));
  const read = await startFreezeFrameLogRead({ client, paceMs: 1 }).finished;
  check(read.completion === "failed", `a refused 0x35 should fail the read, got "${read.completion}"`);
  check(
    !bus.sentRequests.includes("A8 37"),
    "a refusal means nothing was opened, so no 0x37 is owed — sending one would be noise"
  );
  check(read.exit === "not-owed", `and that must be reported as not-owed, not as a failed close, got "${read.exit}"`);
  client.stop();
  console.log(`  ✓ refused 0x35: ${describeFreezeFrameLogResult(read)}`);
}

// The block ceiling, so a micro that never stops still does.
{
  const bus = simulateVcuMicros([
    {
      target: "A8",
      records: new Map(),
      upload: { grantBody: parseHexFrame(UPLOAD_GRANT_BODY), blocks: UPLOAD_BLOCK_BODIES.map(parseHexFrame) },
    },
  ]);
  const client = createVcuKwpClient(bus.channel, { paceMs: 1, responseTimeoutMs: 60 });
  bus.channel.addListener("onMessage", message => client.handleFrame(message.id, message.data));
  const read = await startFreezeFrameLogRead({ client, paceMs: 1, maxBlocks: 2 }).finished;
  check(read.completion === "block-cap", `a 2-block ceiling should truncate, got "${read.completion}"`);
  check(read.blocks.length === 2, `and stop at 2 blocks, got ${read.blocks.length}`);
  client.stop();
  console.log(`  ✓ block cap: ${describeFreezeFrameLogResult(read)}`);
}

// Cancellation, which is what makes a seven-minute read acceptable at all.
{
  const bus = simulateVcuMicros([
    {
      target: "A8",
      records: new Map(),
      upload: {
        grantBody: parseHexFrame(UPLOAD_GRANT_BODY),
        // Far more blocks than the cancel will let it read.
        blocks: new Array(500).fill(parseHexFrame(UPLOAD_BLOCK_BODIES[0])),
      },
    },
  ]);
  const client = createVcuKwpClient(bus.channel, { paceMs: 1, responseTimeoutMs: 60 });
  bus.channel.addListener("onMessage", message => client.handleFrame(message.id, message.data));

  const running = startFreezeFrameLogRead({ client, paceMs: 1 });
  setTimeout(() => running.cancel("the owner pressed stop"), 40);
  const read = await running.finished;
  check(read.completion === "cancelled", `a cancelled read should say so, got "${read.completion}"`);
  check(read.reason === "the owner pressed stop", `and carry the reason, got "${read.reason}"`);
  check(read.blocks.length > 0 && read.blocks.length < 500, `and keep what it read, got ${read.blocks.length} blocks`);
  // The courtesy that stops the next attempt inheriting a half-open upload.
  check(read.exit === "acknowledged", "a cancelled read must still close the transfer with 0x37");
  check(
    bus.sentRequests.filter(request => request === "A8 37").length === 1,
    "0x37 should go out exactly once, on the way out"
  );
  client.stop();
  console.log(`  ✓ cancellation: ${describeFreezeFrameLogResult(read)}`);
}

// The bus lease, which is what stops a seven-minute read sharing the bus with a
// parameter sweep — two requests in flight are resolved by whichever frame lands
// first, not by which one asked.
{
  const bus = simulateVcuMicros([
    {
      target: "A8",
      records: new Map(),
      upload: {
        grantBody: parseHexFrame(UPLOAD_GRANT_BODY),
        blocks: new Array(400).fill(parseHexFrame(UPLOAD_BLOCK_BODIES[0])),
      },
    },
  ]);
  const client = createVcuKwpClient(bus.channel, { paceMs: 1, responseTimeoutMs: 60 });
  bus.channel.addListener("onMessage", message => client.handleFrame(message.id, message.data));

  const first = startFreezeFrameLogRead({ client, paceMs: 1 });
  // Started while the first still holds the lease, so it must be refused by name
  // rather than queued behind a read that runs for minutes.
  const second = await startFreezeFrameLogRead({ client, paceMs: 1 }).finished;
  check(second.completion === "failed", `a second log read should be refused, got "${second.completion}"`);
  check(
    second.reason?.includes("freeze-frame log read") === true,
    `and should name who has the bus, got "${second.reason}"`
  );
  first.cancel("done checking the lease");
  await first.finished;
  check(busHeldBy() === null, "the lease must be released however the read ends");
  client.stop();
  console.log("  ✓ the bus lease refuses a second read by name, and is released on the way out");
}

// The grant that is not the captured one: loud, and NOT fatal, because the bytes
// are the evidence for whatever is actually going on.
{
  const bus = simulateVcuMicros([
    {
      target: "A8",
      records: new Map(),
      upload: { grantBody: parseHexFrame("99"), blocks: [parseHexFrame(UPLOAD_BLOCK_BODIES[0])] },
    },
  ]);
  const client = createVcuKwpClient(bus.channel, { paceMs: 1, responseTimeoutMs: 60 });
  bus.channel.addListener("onMessage", message => client.handleFrame(message.id, message.data));
  const read = await startFreezeFrameLogRead({ client, paceMs: 1 }).finished;
  check(read.grant?.asCaptured === false, "an unexpected grant must be flagged");
  check(read.grant?.rawHex === "99", "and its bytes kept, because they are the evidence");
  check(read.completion === "finished", "but it must not abort the read — the blocks are what we came for");
  client.stop();
  console.log("  ✓ an unexpected 0x35 grant is reported, not fatal");
}

check(readUploadGrant(parseHexFrame(UPLOAD_GRANT_BODY)).asCaptured, "12 E9 is the captured grant");
check(!readUploadGrant(parseHexFrame("13 E9")).asCaptured, "a different routine echo is not the captured grant");
check(isUploadFinished(new Uint8Array(0)), "an empty 0x36 body marks the end of the upload");
check(!isUploadFinished(parseHexFrame("00")), "a body with a byte in it does not");

// ── Verdict ─────────────────────────────────────────────────────────────────
console.log("");
if (failures.length > 0) {
  console.error(`FAILED — ${failures.length} check(s):`);
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  process.exit(1);
}
console.log(
  "✓ multi-frame KWP: segmentation, flow control, the captured 0x2001 reply, the malformed refusals and the bulk sequence"
);

/** How a transfer ended, as one short phrase for an assertion message. */
function describe(result: MultiFrameResult): string {
  switch (result.kind) {
    case "payload":
      return `payload "${toHex(result.payload)}"`;
    case "timeout":
      return `timeout at ${result.stage}`;
    case "abandoned":
      return `abandoned (${result.reason})`;
    case "cancelled":
      return `cancelled (${result.reason})`;
    case "not-sent":
      return `not-sent (${result.reason})`;
  }
}

/**
 * Runs one transfer against a list of reply frames, with no bus and no micro.
 *
 * Drives the REAL transport rather than the reassembler alone, so what is under
 * test includes the flow-control answer, the frame budget and the timers — the
 * parts that only exist in time and would otherwise first run in a garage. The
 * frames are fed on a timer rather than synchronously so the transport's own
 * scheduling is exercised rather than short-circuited.
 */
async function replayReply(
  frames: readonly string[],
  request: VcuMultiFrameRequest,
  overrides: { firstReplyTimeoutMs?: number; transferTimeoutMs?: number } = {}
): Promise<{ result: MultiFrameResult; transmitted: string[]; consumed: number }> {
  const transmitted: string[] = [];
  let consumed = 0;
  const transfer = startMultiFrameTransfer({
    target: "A8",
    requestPayload: encodeMultiFrameRequestPayload(request),
    send: frame => transmitted.push(toHex(frame)),
    maxPayloadBytes: 256,
    firstReplyTimeoutMs: overrides.firstReplyTimeoutMs ?? 400,
    transferTimeoutMs: overrides.transferTimeoutMs ?? 400,
    requestFlowControlTimeoutMs: 20,
  });
  for (const [index, frame] of frames.entries()) {
    setTimeout(() => {
      if (transfer.handleFrame(Buffer.from(parseHexFrame(frame)))) {
        consumed += 1;
      }
    }, index + 1);
  }
  const result = await transfer.finished;
  return { result, transmitted, consumed };
}
