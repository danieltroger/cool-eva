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
   * ✅ The REQUEST is now a quotation rather than a reconstruction: the 2026-08-08 capture
   * has all 29 of them as `A8 03 17 00 <component> 00 00 00`, each answered `57`. ⚠️ The
   * REPLY layout is a different question and is still open — docs/vcu-parameters.md §10.
   */
  | FreezeFrameRequest
  /**
   * `18 02 FF FF` ReadDiagnosticTroubleCodesByStatus — which components have a
   * stored code at all, so `0x17` can be asked about components that exist
   * instead of all 63 in turn.
   *
   * ✅ CAPTURED: `7C0: A8 04 18 02 FF FF 00 00`, once on A8 in the 2026-08-08 capture,
   * answered `58`. That is byte for byte the frame obd-garage/OTHER_TOOL_AUDIT.md §4.3 had
   * DECOMPILED from the second owner's tool — the two now agree. §4.3 also records that **a
   * bare status byte is rejected with incorrectMessageLengthOrInvalidFormat**, so the three
   * operand bytes are required rather than conventional.
   */
  | { kind: "list-stored-dtcs" }
  /**
   * `35 12 FF FF FF FF FF FF FF FF FF FF` RequestUpload — open the bulk freeze-frame log
   * read-out. `0x12` is `RoutinesID.ReadFreezeFrame`. Upload means ECU → tester, so this is
   * a read; `0x34` RequestDownload, which is not, must never be added beside it.
   *
   * ✅ CAPTURED VERBATIM, all twelve payload bytes, 2026-08-08 19:04:32. The ten `0xFF` were
   * this repo's least-supported byte sequence until then; they are not a guess any more.
   * The three request frames, the micro's flow control between them and the `75 12 E9` that
   * answered are quoted in docs/vcu-parameters.md §10.
   */
  | { kind: "request-upload-freeze-frame-log" }
  /**
   * `36 12` TransferData — one block of the open upload. Sent 1198 times in the
   * captured transfer, each answered `76 …`.
   *
   * ✅ The operand is CAPTURED: all 1198 requests are `A8 02 36 12`. This repo sent a bare
   * `36` until 2026-08-20 — see `TRANSFER_DATA_OPERAND` for which half of the old note was
   * right and which half was wrong.
   */
  | { kind: "transfer-data" }
  /**
   * `37` RequestTransferExit — closes the upload.
   *
   * ✅ CAPTURED: `7C0: A8 01 37` → `7E0: F1 02 77 FF`. A bare `37`, exactly as KWP2000 and
   * ISO 14229 specify, so the `FF` is a status byte of the micro's own and not an echo of
   * anything we sent. The `37 FF` this note used to hold out as the fallback to try next is
   * NOT needed and should not be sent (docs/vcu-parameters.md §10).
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
 * The operand after `35 12`: ten `0xFF`, captured whole rather than reasoned to.
 *
 * Ten is arithmetic as well — it is what makes the First Frame's declared length
 * `1 + 1 + 10 = 0x0C`. This used to be split into a captured half and a guessed half so
 * that the guess stayed countable; the capture settled it, so it is one array again.
 */
const READ_FREEZE_FRAME_OPERAND = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];

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
 * The operand after `36`: the routine id again — and still NOT a block-sequence counter.
 *
 * ISO 14229's TransferData is `36 <blockSequenceCounter> …`, counting 01, 02, … and
 * wrapping. This micro does neither. All 1198 requests in the 2026-08-08 capture are
 * `A8 02 36 12`: a CONSTANT `0x12`, the `RoutinesID.ReadFreezeFrame` the upload was opened
 * with. The note that stood here was half right — no counter — and half wrong, because it
 * read "no counter" as "no operand" and shipped a bare `36`, which is one byte short of
 * anything this micro has been seen to accept. docs/vcu-parameters.md §10.
 */
const TRANSFER_DATA_OPERAND = [ROUTINE_READ_FREEZE_FRAME];

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

/**
 * 🔴 The first Consecutive Frame is sequence 0 here, where ISO 15765-2 says 1. This was 1
 * until 2026-08-20, so the `0x35` request went out as `A8 21`/`A8 22` where the only sender
 * this ECU is known to have accepted sent `A8 20`/`A8 21`.
 *
 * The capture settles it in both directions: the factory tool's own request is 0-based and
 * was granted, and 1229 of 1229 replies FROM the micros are 0-based too. Shared with
 * ../diagnostics/extended-iso-tp.ts, which had the mirror image of this bug.
 * docs/vcu-parameters.md §10.
 */
const FIRST_CONSECUTIVE_FRAME_SEQUENCE_NUMBER = 0;

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
      return Uint8Array.from([SERVICE_REQUEST_UPLOAD, ROUTINE_READ_FREEZE_FRAME, ...READ_FREEZE_FRAME_OPERAND]);
    case "transfer-data":
      return Uint8Array.from([SERVICE_TRANSFER_DATA, ...TRANSFER_DATA_OPERAND]);
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
  let sequenceNumber = FIRST_CONSECUTIVE_FRAME_SEQUENCE_NUMBER;
  while (sent < payload.length) {
    const consecutive = new Uint8Array(8);
    consecutive[0] = address;
    // Wraps 0…15, 0… — the low nibble is all there is room for, and a transfer long
    // enough to wrap cannot be produced by this union anyway.
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
 * ✅ `FF 00` — BlockSize 255, SeparationTime 0 — is CAPTURED on this channel in both
 * directions, which it was not when this note said no flow-control frame ever had been: the
 * 2026-08-08 capture has ours 1227 times as `A8 30 FF 00`, and the micro's own once as
 * `F1 30 FF 00`, sent 11 ms after our `0x35` First Frame. docs/vcu-parameters.md §10.
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
 * ✅ `75 12 E9`, and the capture settles what the two bytes mean: `12` echoes the routine
 * id, and `E9` = 233 is a maxNumberOfBlockLength — the longest of the 1198 `76` replies
 * that followed is exactly 233 bytes. The rival reading (`12` as a lengthFormatIdentifier)
 * is out. docs/vcu-parameters.md §10.
 *
 * Nothing here ACTS on the number even so: the loop stops on what the micro does rather
 * than on a count derived from `E9`. But ./freeze-frame-log.ts DOES have to be able to hold
 * 233 bytes, which is what `TRANSFER_BLOCK_MAX_PAYLOAD_BYTES` is now sized from.
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
 * ⚠️⚠️ STILL INFERRED, and the capture makes it LESS likely rather than more: the factory
 * tool's 1198th reply was 64 body bytes, not empty, and no `7F` refusal followed it either.
 * So whatever told that tool to stop, an empty body is not it, and this test may simply
 * never fire. Read docs/vcu-parameters.md §11 before changing it — the block lengths vary
 * 206…233, so "shorter than the last one" is not a rule either.
 *
 * Left as it is because being wrong here is bounded rather than silent: too lax and the
 * block cap in ./freeze-frame-log.ts stops the read and says so, with every block that
 * arrived kept exactly as it arrived.
 */
export function isUploadFinished(body: Uint8Array): boolean {
  return body.length === 0;
}

/**
 * One `58` ReadDTCByStatus reply, split into its records.
 *
 * ✅ The LAYOUT was decompiled from the service tool's decoder rather than captured,
 * and has since been captured and confirmed: `58 <count>` then three-byte
 * `<codeHi> <codeLo> <status>` records, which is the shape
 * ../diagnostics/freeze-frame.ts' header argues for from the same source, and which the
 * second owner's tool documents identically (the service tool "unconditionally skips
 * payload[0]", then walks 3-byte records). The 2026-08-08 session holds an 89-byte
 * `0x58` reply — count byte `0x1D` = 29, then 29 records whose `(component, status)`
 * pairs match the 29 freeze-frame replies exactly, in order. The decompiled reading was
 * right. `declaredCount` and `trailingHex` are still both reported rather than smoothed
 * over — the same tell `headerBytesThatFit` gives for `0x17`.
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
