import { describeNegativeResponseCode } from "../diagnostics/obd-dtc.ts";
import { CALIBRATION_BANK, recordLengthFor, type VcuMicro, type VcuParameter } from "./param-table.ts";

// Pure codec for the VCU micros' custom KWP framing: requests in, bytes out; bytes
// in, values out. No socket, no clock, no state — so the whole protocol can be
// exercised from a laptop against records captured off the bike, which is what
// scripts/check-vcu-params.ts does. src/vcu/kwp-client.ts is the only part that
// touches a bus. Same split as iso-tp.ts / obd-dtc.ts.
//
// ── ⚠️ READ-ONLY BY CONSTRUCTION, not by convention ──────────────────────────
// The public entry point takes a `VcuRequest`, which is a closed union of three
// alternatives — start a session, say hello, read one parameter. There is no
// overload, option or escape hatch that accepts caller-supplied service bytes, so
// there is no code path in this repo that can put a write on this bus. Adding one
// would mean adding a variant to that union and a branch to the switch, in a file
// that says this, which is the point.
//
// Never implement, here or anywhere: 0x2E WriteDataByCommonIdentifier, 0x3B
// WriteDataByLocalIdentifier, 0x27 SecurityAccess, 0x31 StartRoutineByLocalId,
// 0x11 ECUReset, 0x2F InputOutputControl, or OBD Mode 04. This is the bike's
// calibration EEPROM: one wrong word in it is a throttle map, a cell limit or a
// charge current, and nothing here is worth that. Reading needs none of them —
// A8 and A9 serve banks 1 and 2 with no authentication at all, so there is not
// even an argument for 0x27 (and per DIAG_ADDRESSES.md §3 the bank-0 refusal is
// NRC 0x12 subFunctionNotSupported, not 0x33, so 0x27 would not open it anyway).
//
// ── The framing, from obd-garage/CAN_MAP.md and DIAG_ADDRESSES.md §3 ─────────
// Request  0x7C0: [target] [PCI] [service] …      target = 0xA9 / 0xA8
// Response 0x7E0: [0xF1]   [PCI] [service+0x40] … 0xF1 is the tester's address
//
// That is ISO-TP with EXTENDED addressing — byte 0 is the address of whoever the
// frame is for, and everything else shifts one along. Byte 1 is an ordinary ISO-TP
// PCI: `0x0N` single frame, `0x1N` first frame, `0x2N` consecutive, `0x3N` flow
// control (the documented `[target] 30 FF 00`).
//
// ⚠️ It is NOT compatible with src/can/iso-tp.ts, which assumes normal addressing.
// Under extended addressing a First Frame carries five data bytes, not six, and
// arrives as seven bytes after the address is stripped — which that reassembler
// rejects outright. Reusing it would silently drop every multi-frame reply.
//
// ── Why single-frame only, and why that is not a gap ─────────────────────────
// A bank-1 record is 1 or 2 bytes (the TYPE column), so the longest possible reply
// is `62 <hi> <lo> <b0> <b1>` = 5 payload bytes, and extended addressing leaves
// room for 6 in a single frame. **No parameter read in this table can produce a
// multi-frame reply.** So none is assembled, and — the part that actually matters
// — no flow-control frame is ever sent: this module derives no transmit address
// from anything the bus said, it only ever addresses a micro the caller named.
// A First Frame is reported as its own outcome rather than being decoded from its
// first fragment, because a truthful "this did not fit the shape I understand"
// beats a plausible-looking value assembled from half a record.

/** Everything this codebase is permitted to ask a VCU micro. Closed on purpose — see the header. */
export type VcuRequest =
  /**
   * `10 81` StartDiagnosticSession, standard session. The micros answer nothing at
   * all until one is open (DIAG_ADDRESSES.md §3: `A9 01 3E` alone gets silence), so
   * this is unavoidable rather than chosen. It is also the only request here that
   * changes anything in an ECU, and what it changes expires by itself after ~2.5 s
   * of silence. Sub-function 0x81 is hard-coded: nothing may reach the bus that
   * could ask for a programming or extended session.
   */
  | { kind: "start-session" }
  /** `3E` TesterPresent — holds an open session open. Carries no sub-function on this bike. */
  | { kind: "tester-present" }
  /** `22 [0x10|hi] [lo]` ReadDataByCommonIdentifier against bank 1. */
  | { kind: "read-parameter"; index: number };

const SERVICE_START_DIAGNOSTIC_SESSION = 0x10;
const SERVICE_TESTER_PRESENT = 0x3e;
const SERVICE_READ_BY_COMMON_IDENTIFIER = 0x22;
const STANDARD_DIAGNOSTIC_SESSION = 0x81;

/**
 * Belt and braces behind the closed union above: every service byte this module is
 * allowed to emit, checked on the way out. The union makes a write unexpressible;
 * this makes it unreachable even if someone later widens the union without reading
 * the header.
 */
const READ_ONLY_SERVICES: ReadonlySet<number> = new Set([
  SERVICE_START_DIAGNOSTIC_SESSION,
  SERVICE_TESTER_PRESENT,
  SERVICE_READ_BY_COMMON_IDENTIFIER,
]);

/** The tester's own address, which every reply is addressed to. */
export const TESTER_ADDRESS = 0xf1;

/** 11-bit CAN id every request goes out on. */
export const KWP_REQUEST_CAN_ID = 0x7c0;

/** 11-bit CAN id every reply comes back on. */
export const KWP_RESPONSE_CAN_ID = 0x7e0;

/** Byte 0 of a request: the micro being addressed. A7 is deliberately absent — it answers no read on any bank. */
const MICRO_ADDRESS: Record<VcuMicro, number> = { A8: 0xa8, A9: 0xa9 };

const NEGATIVE_RESPONSE_SERVICE = 0x7f;
const POSITIVE_RESPONSE_OFFSET = 0x40;

const SINGLE_FRAME = 0x0;
const FIRST_FRAME = 0x1;
const CONSECUTIVE_FRAME = 0x2;
const FLOW_CONTROL_FRAME = 0x3;

/** Largest single-frame payload under extended addressing: 8 bytes − 1 address − 1 PCI. */
const MAX_SINGLE_FRAME_PAYLOAD = 6;

/**
 * Builds the 8-byte CAN frame for one request. Zero-padded, like every other frame
 * on this bus.
 *
 * Throws rather than returning an error value: every input comes from this repo's
 * own code, so a bad one is a bug to fix now, not a condition to handle. The
 * read-only assertion at the end is the one that must never be removed.
 */
export function buildRequestFrame(micro: VcuMicro, request: VcuRequest): Uint8Array {
  const payload = encodeRequestPayload(request);
  if (!READ_ONLY_SERVICES.has(payload[0])) {
    // Unreachable through the union above, which is exactly why it is here.
    throw new Error(`vcu: refusing to transmit service 0x${payload[0].toString(16)} — not a read-only service`);
  }
  if (payload.length > MAX_SINGLE_FRAME_PAYLOAD) {
    throw new Error(`vcu: request payload of ${payload.length} bytes does not fit one frame`);
  }
  const frame = new Uint8Array(8);
  frame[0] = MICRO_ADDRESS[micro];
  frame[1] = payload.length;
  frame.set(payload, 2);
  return frame;
}

/** The bank-1 CommonIdentifier for a parameter index: `0x1000 | index`. */
export function identifierForIndex(index: number): number {
  if (!Number.isInteger(index) || index < 0 || index > 0x0fff) {
    throw new Error(`vcu: parameter index ${index} is outside bank ${CALIBRATION_BANK}`);
  }
  return (CALIBRATION_BANK << 12) | index;
}

function encodeRequestPayload(request: VcuRequest): Uint8Array {
  switch (request.kind) {
    case "start-session":
      return Uint8Array.from([SERVICE_START_DIAGNOSTIC_SESSION, STANDARD_DIAGNOSTIC_SESSION]);
    case "tester-present":
      return Uint8Array.from([SERVICE_TESTER_PRESENT]);
    case "read-parameter": {
      const identifier = identifierForIndex(request.index);
      return Uint8Array.from([SERVICE_READ_BY_COMMON_IDENTIFIER, identifier >> 8, identifier & 0xff]);
    }
    default:
      // Unreachable while the union stays closed, and TypeScript proves that at
      // compile time. It exists for the version of this file where someone widens
      // the union and forgets a branch: falling through would otherwise return
      // `undefined` and crash with a type error three frames away, instead of
      // saying what actually went wrong.
      throw new Error(`vcu: unknown request kind ${JSON.stringify(request)}`);
  }
}

/** What one received CAN frame turned out to be. */
export type VcuFrame =
  /** A whole reply. `payload` excludes the address and the PCI byte. */
  | { kind: "payload"; payload: Uint8Array }
  /**
   * The start of a multi-frame reply, which nothing here assembles. No parameter in
   * the table can produce one, so seeing it means an assumption is wrong — report
   * it, do not decode the fragment.
   */
  | { kind: "multi-frame"; totalLength: number }
  /** Not addressed to us, or not a shape this framing defines. Never an error on a shared bus. */
  | { kind: "ignored"; reason: string };

/**
 * The subset that is genuinely an answer to something we asked. Named so the
 * transport can hand it around without every caller re-proving that an `ignored`
 * frame — of which a shared bus carries plenty — cannot be one.
 */
export type VcuAddressedFrame = Exclude<VcuFrame, { kind: "ignored" }>;

/** Splits a reply frame into its payload. Pure; the caller decides what to do with the outcome. */
export function parseResponseFrame(frame: Uint8Array): VcuFrame {
  if (frame.length < 2) {
    return { kind: "ignored", reason: "frame shorter than an address plus a PCI byte" };
  }
  if (frame[0] !== TESTER_ADDRESS) {
    // Another tester's traffic, or a micro talking to something that is not us.
    return { kind: "ignored", reason: `addressed to 0x${frame[0].toString(16)}, not the tester` };
  }
  const protocolControl = frame[1];
  switch (protocolControl >> 4) {
    case SINGLE_FRAME: {
      const length = protocolControl & 0x0f;
      if (length === 0) {
        return { kind: "ignored", reason: "single frame declaring zero payload bytes" };
      }
      if (frame.length < 2 + length) {
        return { kind: "ignored", reason: `single frame claims ${length} bytes but carries ${frame.length - 2}` };
      }
      // COPIED, not sliced. The caller is handed a Buffer straight out of the CAN
      // socket, and `Buffer.prototype.slice` returns a VIEW onto it rather than a
      // copy — unlike the Uint8Array method of the same name. The payload then
      // outlives the frame handler by at least one await, so a driver that reuses
      // its receive buffer would rewrite a record we had already "read". That is
      // exactly the class of bug this repo refuses to ship: it would not throw, it
      // would just occasionally file one parameter's bytes under another's name.
      return { kind: "payload", payload: Uint8Array.from(frame.subarray(2, 2 + length)) };
    }
    case FIRST_FRAME: {
      if (frame.length < 3) {
        return { kind: "ignored", reason: "first frame without its length byte" };
      }
      return { kind: "multi-frame", totalLength: ((protocolControl & 0x0f) << 8) | frame[2] };
    }
    case CONSECUTIVE_FRAME:
      // Only reachable as the tail of a multi-frame reply we declined to follow.
      return { kind: "ignored", reason: "consecutive frame of a transfer we are not assembling" };
    case FLOW_CONTROL_FRAME:
      return { kind: "ignored", reason: "flow-control frame, which is ours to send and never to receive" };
    default:
      return { kind: "ignored", reason: `unknown PCI 0x${(protocolControl >> 4).toString(16)}` };
  }
}

/** Did this payload positively answer `10 81`? */
export function isSessionOpened(payload: Uint8Array): boolean {
  return payload.length >= 1 && payload[0] === SERVICE_START_DIAGNOSTIC_SESSION + POSITIVE_RESPONSE_OFFSET;
}

/** How a parameter read came out. */
export type VcuParameterReply =
  /** The micro answered with a record. `record` is exactly the bytes it sent. */
  | { kind: "record"; identifier: number; record: Uint8Array }
  /** The micro said no, by name. */
  | { kind: "refused"; service: number; negativeResponseCode: number; description: string }
  /**
   * A well-formed record answering a DIFFERENT identifier. Kept apart from
   * `unrecognised` because it is the one failure that would otherwise be invisible:
   * the bytes decode perfectly, they are just the answer to another question, and
   * filing them under the name we asked about is the exact "silent wrong answer"
   * this repo refuses to produce.
   */
  | { kind: "identifier-mismatch"; expected: number; received: number }
  /** Something answered in a shape this service does not define. */
  | { kind: "unrecognised"; reason: string };

/** Decodes one reply payload against the identifier that was asked for. Pure. */
export function decodeParameterReply(payload: Uint8Array, expectedIdentifier: number): VcuParameterReply {
  if (payload.length === 0) {
    return { kind: "unrecognised", reason: "empty payload" };
  }
  if (payload[0] === NEGATIVE_RESPONSE_SERVICE) {
    if (payload.length < 3) {
      return { kind: "unrecognised", reason: "negative response without a service and a code" };
    }
    return {
      kind: "refused",
      service: payload[1],
      negativeResponseCode: payload[2],
      description: describeNegativeResponseCode(payload[2]),
    };
  }
  if (payload[0] !== SERVICE_READ_BY_COMMON_IDENTIFIER + POSITIVE_RESPONSE_OFFSET) {
    return { kind: "unrecognised", reason: `reply names service 0x${payload[0].toString(16)}, not 0x62` };
  }
  if (payload.length < 3) {
    return { kind: "unrecognised", reason: "positive reply without a full identifier echo" };
  }
  const received = (payload[1] << 8) | payload[2];
  if (received !== expectedIdentifier) {
    return { kind: "identifier-mismatch", expected: expectedIdentifier, received };
  }
  if (payload.length === 3) {
    return { kind: "unrecognised", reason: "identifier echoed with no record after it" };
  }
  return { kind: "record", identifier: received, record: payload.slice(3) };
}

/** A record's bytes turned into numbers, with the table's opinion of them where there is one. */
export interface VcuParameterValue {
  /** Exactly what the bike sent, uppercase hex, space-separated. Always present, whatever else failed. */
  rawHex: string;
  /** Big-endian, unsigned. Always meaningful. */
  unsigned: number;
  /** The same bytes read as two's complement. Meaningful only for `S` parameters. */
  signed: number;
  /**
   * The value per the table's S/U column — the number to show a human.
   *
   * Null when there is no honest typed reading: the identifier is not in the name
   * table (an index outside the 1…277 this variant's file describes), or its record
   * length contradicts the TYPE column. In both cases `rawHex` and `unsigned` still
   * carry everything the bike actually said, so nothing is lost by refusing to guess.
   */
  value: number | null;
  /** The record length disagrees with the table. Never seen on 233 records; loud if it ever is. */
  widthMismatch: boolean;
}

/**
 * Interprets a record. `parameter` is null for an identifier the name table does not
 * describe — which means an index outside the contiguous 1…277 this variant's file
 * covers, as it has no gaps (scripts/check-vcu-params.ts asserts exactly that). That
 * is an ordinary outcome, not an error: a bike with more parameters than this file
 * knows shows up here as more of them, with its raw bytes intact. (260/262/263/265
 * are NOT such cases — they are named EVSE placeholders, EE_EVSE_DUMMY_1 …
 * EVSE_DUMMY_WORD4, that happen to read 0 on this bike.)
 */
export function interpretRecord(record: Uint8Array, parameter: VcuParameter | null): VcuParameterValue {
  const unsigned = record.reduce((accumulated, byte) => accumulated * 256 + byte, 0);
  const bits = record.length * 8;
  const signed = record.length > 0 && unsigned >= 2 ** (bits - 1) ? unsigned - 2 ** bits : unsigned;
  const rawHex = toHex(record);

  if (!parameter) {
    return { rawHex, unsigned, signed, value: null, widthMismatch: false };
  }
  const widthMismatch = record.length !== recordLengthFor(parameter.type);
  if (widthMismatch) {
    return { rawHex, unsigned, signed, value: null, widthMismatch };
  }
  return { rawHex, unsigned, signed, value: parameter.signed ? signed : unsigned, widthMismatch };
}

/** Uppercase, space-separated hex — the same shape obd-garage's notes quote raw payloads in. */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0").toUpperCase()).join(" ");
}
