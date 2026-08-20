import { buildFreezeFrameRequestFrame, type FreezeFrameRequest } from "../diagnostics/freeze-frame.ts";
import { describeNegativeResponseCode } from "../diagnostics/obd-dtc.ts";
import type { VcuTarget } from "./param-codec.ts";

// Pure codec for the VCU micros' MULTI-FRAME custom-KWP exchanges: the services whose
// request or reply does not fit one CAN frame. Bytes in, bytes out — no socket, no clock,
// no state. ./multiframe-transfer.ts is the only part that touches a bus, and
// ./kwp-client.ts is the only part that holds a session.
//
// ⚠️ READ-ONLY BY CONSTRUCTION, and separately from ./param-codec.ts.
// `VcuMultiFrameRequest` below is a closed union of five alternatives, every one of them a
// read, and `encodeMultiFrameRequestPayload` has a throwing default. There is no raw-bytes
// entry point, and `READ_ONLY_SERVICES` re-checks the emitted byte on the way out.
//
// **Never implement here: `0x31` StartRoutine, `0x2E` WriteDataByIdentifier, `0x3B`
// WriteDataByLocalIdentifier, `0x14` ClearDiagnosticInformation, `0x11` ECUReset, `0x27`
// SecurityAccess, `0x2F` InputOutputControl, `0x34` RequestDownload.** Two of those sit
// uncomfortably close to what is here:
//   • `0x34` RequestDownload is `0x35`'s mirror image — one byte away in the switch, and it
//     points the transfer the other way, tester → ECU. It would make this same segmenter
//     into a flasher. It must never appear.
//   • `0x31 FE` is the service tool's freeze-frame ERASE: it destroys exactly what
//     `0x35`/`0x36`/`0x37` exist to read, and unlike every read here it needs SecurityAccess.
//
// The framing (extended-addressed ISO-TP — a Single Frame holds 6 payload bytes, a First
// Frame 5, a Consecutive Frame 6), and why three small closed unions each arguing their own
// case beat one wide one: docs/vcu-parameters.md §10.

/**
 * Everything this module is permitted to ask a micro. Closed on purpose.
 *
 * All five are reads. Three of them (`0x35`/`0x36`/`0x37`) form one sequence and
 * are useless apart, which is why they are members of one union rather than three
 * modules — a caller that can start an upload must be able to finish it, and
 * `0x37` is how a transfer is ENDED rather than abandoned.
 */
export type VcuMultiFrameRequest =
  /**
   * `17 <componentHi> <componentLo>` ReadDiagnosticTroubleCodeInformation — one component's
   * freeze frame. Encoded by ../diagnostics/freeze-frame.ts, which owns the
   * component-number range check and the decode; this union carries it so that one
   * transport can run every multi-frame read.
   *
   * ✅ The SERVICE and its ROUTING are proven — 29 of 29 `0x17` requests to A8 drew a
   * positive `57` in the 2026-08-08 capture. ⚠️ The literal FRAME is a reconstruction, not
   * a quotation: the census counted service bytes and discarded payloads, so this exact
   * frame has never been written down off a wire. docs/vcu-parameters.md §10.
   */
  | FreezeFrameRequest
  /**
   * `18 02 FF FF` ReadDiagnosticTroubleCodesByStatus — which components have a
   * stored code at all, so `0x17` can be asked about components that exist
   * instead of all 63 in turn.
   *
   * 🟡 The best-attested request in this union after `0x35`. The literal frame
   * `7C0: A8 04 18 02 FF FF` is written down in obd-garage/OTHER_TOOL_AUDIT.md
   * §4.3 — DECOMPILED from the second owner's tool, not sniffed — together with
   * the detail that **a bare status byte is rejected with
   * incorrectMessageLengthOrInvalidFormat**, so the three operand bytes are
   * required rather than conventional. The 2026-08-08 capture independently saw
   * `0x18` once on A8 with a positive `58`, but kept no payload.
   */
  | { kind: "list-stored-dtcs" }
  /**
   * `35 12 FF FF FF FF FF FF FF FF FF FF` RequestUpload — open the bulk freeze-frame log
   * read-out. `0x12` is `RoutinesID.ReadFreezeFrame`. Upload means ECU → tester, so this is
   * a read; `0x34` RequestDownload, which is not, must never be added beside it.
   *
   * ✅ The FIRST FIVE payload bytes are captured verbatim.
   * ⚠️⚠️ **THE OTHER SEVEN OPERAND BYTES WERE NEVER CAPTURED.** Ten `0xFF` is a GUESS, and
   * the single least-supported byte sequence in this repo. It is settleable OFFLINE and in
   * minutes from a passive capture already on the Pi — docs/vcu-parameters.md §10 names the
   * file and the grep. Do that before trusting this constant.
   */
  | { kind: "request-upload-freeze-frame-log" }
  /**
   * `36` TransferData — one block of the open upload. Sent 1198 times in the
   * captured transfer, each answered `76 …`.
   *
   * ⚠️ No block-sequence counter, and no payload was recorded either — see
   * `TRANSFER_DATA_CARRIES_NO_BLOCK_COUNTER` for why a bare `36` is the guess and
   * why being wrong about it is loud rather than silent.
   */
  | { kind: "transfer-data" }
  /**
   * `37` RequestTransferExit — closes the upload.
   *
   * ⚠️ The request bytes were never recorded; only the service number and the reply,
   * `77 FF`, which is itself a puzzle since `0x37` takes no parameters in either standard.
   * A bare `37` is sent because that is what both specify; if it draws NRC `0x13`
   * incorrectMessageLengthOrInvalidFormat, `37 FF` is the one thing to try next
   * (docs/vcu-parameters.md §10).
   *
   * Sent even when the read is abandoned early: an ECU left holding an open upload may
   * refuse the next one. It is still a read — it transfers nothing and stores nothing.
   */
  | { kind: "request-transfer-exit" };

const SERVICE_READ_DTC_INFORMATION = 0x17;
const SERVICE_READ_DTC_BY_STATUS = 0x18;
const SERVICE_REQUEST_UPLOAD = 0x35;
const SERVICE_TRANSFER_DATA = 0x36;
const SERVICE_REQUEST_TRANSFER_EXIT = 0x37;

const NEGATIVE_RESPONSE_SERVICE = 0x7f;
const POSITIVE_RESPONSE_OFFSET = 0x40;

/**
 * Belt and braces behind the closed union: every service byte this module may
 * emit, checked on the way out. The union makes a write unexpressible; this makes
 * it unreachable even if someone widens the union without reading the header.
 * Same pattern, and the same purpose, as ./param-codec.ts' set of three.
 */
const READ_ONLY_SERVICES: ReadonlySet<number> = new Set([
  SERVICE_READ_DTC_INFORMATION,
  SERVICE_READ_DTC_BY_STATUS,
  SERVICE_REQUEST_UPLOAD,
  SERVICE_TRANSFER_DATA,
  SERVICE_REQUEST_TRANSFER_EXIT,
]);

/**
 * `RoutinesID.ReadFreezeFrame`, the identifier byte of the bulk read-out.
 *
 * ⚠️ The 2024 service-tool analysis in obd-garage/, §7.2, calls this a `0x31` routine
 * id. It is not: it is the identifier of a `0x35` RequestUpload, which is why the
 * captured frame is `35 12 …` and not `31 12 …`. Sending `31 12` would be a
 * StartRoutine — a write-class service this repo does not implement anywhere.
 */
const ROUTINE_READ_FREEZE_FRAME = 0x12;

/** `17 <componentHi> <componentLo>` — the three bytes ../diagnostics/freeze-frame.ts frames. */
const FREEZE_FRAME_REQUEST_PAYLOAD_BYTES = 3;

/**
 * The operand after `35 12`: ten bytes, of which only the first three are known.
 *
 * Ten is arithmetic and is solid — it is what makes the captured First Frame's
 * declared length `1 + 1 + 10 = 0x0C`. The VALUE is not: see the ⚠️⚠️ on
 * `request-upload-freeze-frame-log` above. Split into a captured half and a
 * guessed half here so the guess is countable rather than buried in a fill().
 */
const READ_FREEZE_FRAME_OPERAND_CAPTURED = [0xff, 0xff, 0xff];
const READ_FREEZE_FRAME_OPERAND_GUESSED = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];

/**
 * `18 02 FF FF` — status mask `02` ("all identified DTCs"), DTC group `FF FF`
 * ("all groups").
 *
 * 🟡 Decompiled rather than sniffed, from the second owner's tool
 * (obd-garage/OTHER_TOOL_AUDIT.md §4.3), which also records that **a bare status
 * byte without the group is rejected with incorrectMessageLengthOrInvalidFormat**
 * — so all three bytes are required and this is not a place to economise.
 */
const LIST_STORED_DTCS_OPERAND = [0x02, 0xff, 0xff];

/**
 * ⚠️ `0x36` carries no block-sequence counter here — a named constant because it is the
 * assumption most likely to be wrong, and the one that would be silently wrong. ISO 14229's
 * TransferData is `36 <blockSequenceCounter> …`, counting 01, 02, … and wrapping; the
 * evidence for a bare `36` on this bike is indirect, and neither strand of it is a captured
 * payload (docs/vcu-parameters.md §10).
 *
 * If it turns out to need one, the symptom is unambiguous rather than subtle — the first
 * `0x36` is refused, most likely NRC `0x13` incorrectMessageLength or `0x24`
 * requestSequenceError — so this is a wrong assumption that announces itself instead of
 * producing 1198 blocks of shifted bytes.
 */
const TRANSFER_DATA_CARRIES_NO_BLOCK_COUNTER = true;

/** ISO-TP PCI nibbles, under extended addressing they live in byte 1 rather than byte 0. */
const SINGLE_FRAME = 0x00;
const FIRST_FRAME = 0x10;
const CONSECUTIVE_FRAME = 0x20;
const FLOW_CONTROL_FRAME = 0x30;

/** Largest payload that fits one frame: 8 bytes − 1 address − 1 PCI. */
export const MAX_SINGLE_FRAME_PAYLOAD = 6;
/** Payload bytes a First Frame carries: 8 − 1 address − 2 PCI. */
export const FIRST_FRAME_PAYLOAD_BYTES = 5;
/** Payload bytes a Consecutive Frame carries: 8 − 1 address − 1 PCI. */
export const CONSECUTIVE_FRAME_PAYLOAD_BYTES = 6;

/** The tester's own address, which every reply meant for us is addressed to. */
export const TESTER_ADDRESS = 0xf1;

/** Byte 0 of a request: the ECU being addressed. Mirrors ./param-codec.ts' table. */
const TARGET_ADDRESS: Record<VcuTarget, number> = { A8: 0xa8, A9: 0xa9 };

/**
 * The whole request as payload bytes — no address, no PCI. Segmenting it is
 * `segmentRequestPayload`'s job, and which of the two it needs is decided by the
 * length rather than by the service.
 *
 * Throws rather than returning an error value: every input comes from this repo's
 * own code, so a bad one is a bug to fix now. The read-only assertion at the end
 * is the one that must never be removed.
 */
export function encodeMultiFrameRequestPayload(request: VcuMultiFrameRequest): Uint8Array {
  const payload = encodePayload(request);
  if (!READ_ONLY_SERVICES.has(payload[0])) {
    // Unreachable through the union above, which is exactly why it is here.
    throw new Error(`vcu: refusing to transmit service 0x${payload[0].toString(16)} — not a read-only service`);
  }
  return payload;
}

function encodePayload(request: VcuMultiFrameRequest): Uint8Array {
  switch (request.kind) {
    case "read-freeze-frame":
      // Delegated whole, including the 1…63 component check. That module owns the
      // service and its decode; duplicating three bytes here would mean two places
      // to fix when the component range turns out to be wrong.
      //
      // `slice`, not `subarray`: on a Uint8Array that is a copy, and this payload
      // outlives the frame it came from. Safe either way here — the source is a
      // fresh array, not a socket buffer — but the convention in this repo is that
      // a payload handed onwards owns its bytes, and following it costs nothing.
      return buildFreezeFrameRequestFrame(request).slice(2, 2 + FREEZE_FRAME_REQUEST_PAYLOAD_BYTES);
    case "list-stored-dtcs":
      return Uint8Array.from([SERVICE_READ_DTC_BY_STATUS, ...LIST_STORED_DTCS_OPERAND]);
    case "request-upload-freeze-frame-log":
      return Uint8Array.from([
        SERVICE_REQUEST_UPLOAD,
        ROUTINE_READ_FREEZE_FRAME,
        ...READ_FREEZE_FRAME_OPERAND_CAPTURED,
        ...READ_FREEZE_FRAME_OPERAND_GUESSED,
      ]);
    case "transfer-data":
      if (!TRANSFER_DATA_CARRIES_NO_BLOCK_COUNTER) {
        throw new Error("vcu: transfer-data needs a block counter, and this encoder does not have one to give");
      }
      return Uint8Array.from([SERVICE_TRANSFER_DATA]);
    case "request-transfer-exit":
      return Uint8Array.from([SERVICE_REQUEST_TRANSFER_EXIT]);
    default:
      // Unreachable while the union stays closed, and TypeScript proves that at
      // compile time. It exists for the version of this file where someone widens
      // the union and forgets a branch: falling through would return `undefined`
      // and crash three frames away instead of saying what actually went wrong.
      throw new Error(`vcu: unknown multi-frame request ${JSON.stringify(request)}`);
  }
}

/** The positive-response service byte this request expects back: service + 0x40. */
export function expectedResponseService(request: VcuMultiFrameRequest): number {
  return encodeMultiFrameRequestPayload(request)[0] + POSITIVE_RESPONSE_OFFSET;
}

/**
 * Splits a request payload into the frames that carry it, in send order.
 *
 * Six bytes or fewer is one Single Frame. Anything longer is a First Frame
 * carrying 5, then Consecutive Frames carrying 6 — and the caller must wait for
 * the ECU's flow control between the two, which is why this returns the frames
 * rather than sending them.
 *
 * Every frame is zero-padded to a full 8-byte DLC, because that is what the only
 * known-good sender does (OTHER_TOOL_AUDIT.md §4.3, "full 8-byte DLC") and the
 * length byte governs anyway. Deviating from the factory tool's DLC is not a
 * difference worth introducing on a bus we cannot debug.
 */
export function segmentRequestPayload(target: VcuTarget, payload: Uint8Array): Uint8Array[] {
  if (payload.length === 0) {
    throw new Error("vcu: refusing to segment an empty request payload");
  }
  if (payload.length > 0x0fff) {
    // The 12-bit classic length form. The escape form exists for longer payloads
    // and nothing here can produce one — the longest request in the union is 12
    // bytes — so it is refused rather than half-implemented.
    throw new Error(`vcu: request of ${payload.length} bytes does not fit the 12-bit ISO-TP length`);
  }
  const address = TARGET_ADDRESS[target];
  if (payload.length <= MAX_SINGLE_FRAME_PAYLOAD) {
    const frame = new Uint8Array(8);
    frame[0] = address;
    frame[1] = SINGLE_FRAME | payload.length;
    frame.set(payload, 2);
    return [frame];
  }

  const first = new Uint8Array(8);
  first[0] = address;
  first[1] = FIRST_FRAME | (payload.length >> 8);
  first[2] = payload.length & 0xff;
  first.set(payload.subarray(0, FIRST_FRAME_PAYLOAD_BYTES), 3);

  const frames = [first];
  let sent = FIRST_FRAME_PAYLOAD_BYTES;
  let sequenceNumber = 1;
  while (sent < payload.length) {
    const consecutive = new Uint8Array(8);
    consecutive[0] = address;
    // Wraps 1…15, 0, 1… — the low nibble is all there is room for, and a transfer
    // long enough to wrap cannot be produced by this union anyway.
    consecutive[1] = CONSECUTIVE_FRAME | (sequenceNumber & 0x0f);
    const take = Math.min(CONSECUTIVE_FRAME_PAYLOAD_BYTES, payload.length - sent);
    consecutive.set(payload.subarray(sent, sent + take), 2);
    frames.push(consecutive);
    sent += take;
    sequenceNumber += 1;
  }
  return frames;
}

/**
 * The flow-control frame that tells a micro to send the rest of its reply:
 * `[target] 30 FF 00`.
 *
 * ⚠️ The transmit address is the target the CALLER named. It is never derived from the
 * received frame — which is the property ./param-codec.ts' header claims for the whole
 * client ("no transmit address is ever derived from something the bus said") and the one
 * thing that could quietly be lost by teaching this client to answer a First Frame.
 *
 * ⚠️ `FF 00` is what obd-garage's notes say to send, not what anything was observed
 * sending: no flow-control frame has ever been captured on this channel, in either
 * direction. It is indistinguishable in effect from the `30 00 00` src/can/obd-dtc.ts sends
 * on the OBD channel, because ./multiframe-transfer.ts caps a reply well under 255 frames.
 * docs/vcu-parameters.md §10.
 */
export function buildFlowControlFrame(target: VcuTarget): Uint8Array {
  const frame = new Uint8Array(8);
  frame[0] = TARGET_ADDRESS[target];
  frame[1] = FLOW_CONTROL_FRAME | FLOW_STATUS_CLEAR_TO_SEND;
  frame[2] = 0xff;
  frame[3] = 0x00;
  return frame;
}

const FLOW_STATUS_CLEAR_TO_SEND = 0x0;
const FLOW_STATUS_WAIT = 0x1;
const FLOW_STATUS_OVERFLOW = 0x2;

/**
 * A flow-control frame FROM a micro, which only ever arrives in answer to the one
 * multi-frame request this repo sends (`0x35`). Null when the frame is not one.
 */
export type VcuFlowControl =
  /** Send the Consecutive Frames. `blockSize` 0 means all of them. */
  | { status: "clear-to-send"; blockSize: number; separationTimeMs: number }
  /** Hold; another flow control will follow. */
  | { status: "wait" }
  /** The micro cannot hold the payload. Nothing more may be sent. */
  | { status: "overflow" }
  /** A flow status this protocol does not define, reported rather than treated as clear-to-send. */
  | { status: "unrecognised"; flowStatus: number };

/**
 * Reads a flow-control frame addressed to us. Returns null for anything that is
 * not one, so a caller can hand the frame on.
 */
export function parseFlowControlFrame(frame: Uint8Array): VcuFlowControl | null {
  if (frame.length < 4 || frame[0] !== TESTER_ADDRESS || (frame[1] & 0xf0) !== FLOW_CONTROL_FRAME) {
    return null;
  }
  switch (frame[1] & 0x0f) {
    case FLOW_STATUS_CLEAR_TO_SEND:
      return { status: "clear-to-send", blockSize: frame[2], separationTimeMs: decodeSeparationTime(frame[3]) };
    case FLOW_STATUS_WAIT:
      return { status: "wait" };
    case FLOW_STATUS_OVERFLOW:
      return { status: "overflow" };
    default:
      return { status: "unrecognised", flowStatus: frame[1] & 0x0f };
  }
}

/**
 * SeparationTime, as milliseconds to wait between Consecutive Frames.
 *
 * ISO 15765-2 encodes 0x00…0x7F as whole milliseconds and 0xF1…0xF9 as 100…900
 * microseconds. Everything else is reserved, and the standard says to treat a
 * reserved value as the maximum — 127 ms — rather than as zero. Rounding the
 * sub-millisecond range UP to 1 ms is deliberate: this process cannot time a
 * shorter gap than one timer tick anyway, and being slower than asked is polite
 * where being faster risks the micro dropping frames.
 */
function decodeSeparationTime(encoded: number): number {
  if (encoded <= 0x7f) {
    return encoded;
  }
  if (encoded >= 0xf1 && encoded <= 0xf9) {
    return 1;
  }
  return 0x7f;
}

/** How a positive reply to one of these services came out. */
export type VcuMultiFrameReply =
  /** The service answered, and `body` is everything after the service byte. */
  | { kind: "positive"; service: number; body: Uint8Array }
  /** The micro said no, by name. */
  | { kind: "refused"; service: number; negativeResponseCode: number; description: string }
  /** Something answered in a shape this exchange does not define. */
  | { kind: "unrecognised"; reason: string };

/**
 * Splits a reassembled reply payload against the service that was asked for.
 *
 * The service check is the whole point: these micros answer on ONE CAN id with no
 * request/response tag, so a reply naming a different service is somebody else's
 * answer and filing it as ours is the silent-wrong-answer failure this repo keeps
 * refusing to ship. A refusal counts only when it names OUR service, for the same
 * reason src/can/obd-dtc.ts ignores the `7F 00 33` its own flow control provokes.
 */
export function decodeMultiFrameReply(payload: Uint8Array, expectedService: number): VcuMultiFrameReply {
  if (payload.length === 0) {
    return { kind: "unrecognised", reason: "empty payload" };
  }
  if (payload[0] === NEGATIVE_RESPONSE_SERVICE) {
    if (payload.length < 3) {
      return { kind: "unrecognised", reason: "negative response without a service and a code" };
    }
    if (payload[1] !== expectedService - POSITIVE_RESPONSE_OFFSET) {
      return {
        kind: "unrecognised",
        reason:
          `refusal names service 0x${payload[1].toString(16)}, not the ` +
          `0x${(expectedService - POSITIVE_RESPONSE_OFFSET).toString(16)} we asked about`,
      };
    }
    return {
      kind: "refused",
      service: payload[1],
      negativeResponseCode: payload[2],
      description: describeNegativeResponseCode(payload[2]),
    };
  }
  if (payload[0] !== expectedService) {
    return {
      kind: "unrecognised",
      reason: `reply names service 0x${payload[0].toString(16)}, not 0x${expectedService.toString(16)}`,
    };
  }
  return { kind: "positive", service: payload[0], body: payload.slice(1) };
}

/**
 * What a `75` RequestUpload reply said, from the body after the service byte.
 *
 * ⚠️ Only ONE such reply has ever been seen — `75 12 E9`, in the 2026-08-08 census — and
 * the census kept the bytes without recording what they mean. Two readings fit, and this
 * reports both rather than picking; the field names below assume the stronger one. See
 * docs/vcu-parameters.md §10.
 *
 * Nothing in this repo ACTS on either number: the block length is not used to size
 * anything, and the loop stops on what the micro does rather than on a count derived from
 * `E9`. It is carried so the first live run can settle it.
 */
export interface VcuUploadGrant {
  /** Byte 0 of the body. Expected to echo `0x12`; reported whatever it is. */
  routineEcho: number;
  /** Byte 1 of the body. Expected `0xE9`; see the two readings above. */
  blockLengthByte: number;
  /** The whole body as hex, so a reply of an unexpected length loses nothing. */
  rawHex: string;
  /** False when the body was not the 2 bytes the captured one was. Loud, not silent. */
  asCaptured: boolean;
}

/** Reads a `75` body. Pure; reports rather than validates. */
export function readUploadGrant(body: Uint8Array): VcuUploadGrant {
  return {
    routineEcho: body.length > 0 ? body[0] : -1,
    blockLengthByte: body.length > 1 ? body[1] : -1,
    rawHex: toHex(body),
    asCaptured: body.length === 2 && body[0] === ROUTINE_READ_FREEZE_FRAME,
  };
}

/**
 * Is this `76` body the end of the upload?
 *
 * ⚠️ INFERRED, and it is the second assumption most likely to be wrong. The
 * captured transfer ran 1198 blocks and then sent `0x37`, but the census did not
 * record what the 1198th reply looked like or what made the software stop. An
 * empty body is the conventional end-of-upload marker and is what this treats as
 * the end.
 *
 * The consequence of being wrong is bounded rather than silent, which is why it
 * is acceptable to guess here at all: too eager and the log comes back short with
 * its block count visible in the result; too lax and the block cap in
 * ./freeze-frame-log.ts stops it and says so. Neither produces a wrong record —
 * every block that arrived is kept exactly as it arrived.
 */
export function isUploadFinished(body: Uint8Array): boolean {
  return body.length === 0;
}

/**
 * One `58` ReadDTCByStatus reply, split into its records.
 *
 * ⚠️ The LAYOUT is decompiled from the service tool's decoder, not captured:
 * `58 <count>` then three-byte `<codeHi> <codeLo> <status>` records, which is the
 * shape ../diagnostics/freeze-frame.ts' header argues for from the same source, and
 * which the second owner's tool documents identically (the service tool
 * "unconditionally skips payload[0]", then walks 3-byte records). `declaredCount` and
 * `trailingHex` are both reported so the first live reply settles it instead of
 * being smoothed over — the same tell `headerBytesThatFit` gives for `0x17`.
 */
export interface VcuStoredDtcList {
  /** Byte 0 of the body: how many records the micro says follow. */
  declaredCount: number;
  /**
   * Every record parsed, in wire order, INCLUDING `(0, 0)` padding.
   *
   * The service tool filters those out. This does not: a padding record and a real record
   * for component 0 are the same three bytes, and dropping them here would make
   * "the micro padded its reply" indistinguishable from "the micro had nothing to
   * say about component 0". `paddingRecords` counts them so a caller can filter
   * with the count still visible.
   */
  records: { code: number; status: number }[];
  /** How many of `records` are `(0, 0)`. The service tool treats these as padding. */
  paddingRecords: number;
  /** Bytes after the last whole record. Empty if the layout is right. */
  trailingHex: string;
  /** The body carried fewer whole records than it declared. */
  truncated: boolean;
}

const STORED_DTC_RECORD_BYTES = 3;

/** Splits a `58` body. Pure; reports every disagreement rather than resolving it. */
export function decodeStoredDtcList(body: Uint8Array): VcuStoredDtcList {
  if (body.length === 0) {
    return { declaredCount: 0, records: [], paddingRecords: 0, trailingHex: "", truncated: true };
  }
  const declaredCount = body[0];
  const records: { code: number; status: number }[] = [];
  let offset = 1;
  while (offset + STORED_DTC_RECORD_BYTES <= body.length && records.length < declaredCount) {
    records.push({ code: (body[offset] << 8) | body[offset + 1], status: body[offset + 2] });
    offset += STORED_DTC_RECORD_BYTES;
  }
  return {
    declaredCount,
    records,
    paddingRecords: records.filter(record => record.code === 0 && record.status === 0).length,
    trailingHex: toHex(body.subarray(offset)),
    truncated: records.length < declaredCount,
  };
}

/** Uppercase, space-separated hex — the shape obd-garage's notes quote raw payloads in. */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0").toUpperCase()).join(" ");
}
