import { describeNegativeResponseCode } from "../diagnostics/obd-dtc.ts";
import { CALIBRATION_BANK, recordLengthFor, type VcuMicro, type VcuParameter } from "./param-table.ts";

// Pure codec for the VCU micros' custom KWP framing: requests in, bytes out; bytes in,
// values out. No socket, no clock, no state — so the whole protocol can be exercised from
// a laptop against records captured off the bike. src/vcu/kwp-client.ts is the only part
// that touches a bus. Same split as iso-tp.ts / obd-dtc.ts.
//
// ⚠️ READ-ONLY BY CONSTRUCTION, NOT BY CONVENTION. The public entry point takes a
// `VcuRequest`: a closed union of three alternatives — start a session, say hello, read
// one parameter — with no overload, option or escape hatch that accepts caller-supplied
// service bytes. Adding a write would mean adding a variant to that union and a branch to
// the switch, in a file that says this, which is the point. It stays true even though
// ./write-codec.ts now exists: the two guarantees are deliberately separate, so that
// whether a READ can change something is answerable from this file alone.
//
// ⚠️ A caller CAN choose the target, the bank and the index — WHICH thing is read. A caller
// still cannot choose the SERVICE or the VALUE, and those are the two that make a write.
// Keep that line where it is: widening "which" is recoverable, widening "what to do to it"
// is not. Never implement IN THIS FILE: 0x2E, 0x3B, 0x27, 0x31, 0x11, 0x2F, or OBD Mode 04.
//
// ⚠️ The framing is extended-addressed ISO-TP on 0x7C0/0x7E0, and it is NOT compatible with
// src/can/iso-tp.ts: a First Frame carries five data bytes there, not six, and that
// reassembler rejects it outright. Reusing it would silently drop every multi-frame reply.
//
// ⚠️ No parameter read in this table can produce a multi-frame reply, so none is assembled
// here and — the property three other modules cite by name — **no transmit address is ever
// derived from something the bus said**: it only ever addresses a micro the caller named.
//
// ⚠️⚠️ There used to be a third target — the charge manager, as 0xA4 on 0x7C3/0x7E3. **It
// has been removed and that pair must not come back**; see the note above VcuTarget.
//
// Why single frame only is not a gap: docs/vcu-parameters.md §9.

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
  /**
   * `22 [hi] [lo]` ReadDataByCommonIdentifier, where the identifier is
   * `(bank << 12) | index`. Bank 1 is the EEPROM calibration the parameter table
   * describes; bank 2 is live data. Both are read the same way.
   *
   * ⚠️ The BANK is a parameter, so a caller can name any identifier in the 16-bit space.
   * Every one of them is still a READ — `22` has no write semantics in KWP whatever you
   * point it at — and a caller still cannot name a SERVICE or a VALUE, which is what makes
   * a write unexpressible rather than merely absent. Precisely what this widened and what
   * it did not: docs/vcu-parameters.md §9.
   */
  | { kind: "read-parameter"; bank: number; index: number };

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

/**
 * Everything on this bus that anything here may address: `A8` and `A9`, the two VCU micros
 * the parameter table describes. A7 is deliberately absent — it answers no read on any bank.
 *
 * ⚠️⚠️ THE CHARGE MANAGER WAS HERE AS A THIRD TARGET, ON 0x7C3/0x7E3, AND IT WAS WRONG.
 * Removed 2026-08-16, and that pair must not come back: **`0x7E3` is DashboardV2's REQUEST
 * id**, so a probe on it, believing it was asking the charge manager, could have been
 * talking to the DASHBOARD — the exact failure the rest of this file is built to avoid.
 *
 * ⚠️ Node `0xA4` really is the charge manager's 11-bit identity; the PAIRING was not, and
 * the pairing is what goes on the wire. It answers on 29-bit ISO-TP instead, which needs
 * its own transmit flag, RX filter and addressing math — a feature, not a constant, which
 * is why the target is REMOVED rather than re-pointed. Those addresses, and the rest of the
 * handover note (its SecurityAccess is NOT `securityKeyForSeed`): docs/vcu-parameters.md §9.
 */
export type VcuTarget = VcuMicro;

/** Byte 0 of a request: the ECU being addressed, under extended addressing. */
const TARGET_ADDRESS: Record<VcuTarget, number> = { A8: 0xa8, A9: 0xa9 };

/**
 * Which 11-bit CAN ids each target speaks on.
 *
 * Both micros share one pair and differ only by the address byte. Live since
 * 2026-08-08. Nothing else may be added here without a decompile or a capture behind
 * it — see the removal note above for what happens when a pair is written down from
 * a plausible guess.
 */
const TARGET_CAN_IDS: Record<VcuTarget, { request: number; response: number }> = {
  A8: { request: 0x7c0, response: 0x7e0 },
  A9: { request: 0x7c0, response: 0x7e0 },
};

/** Where a request to this target goes, and where its reply comes back. */
export function canIdsFor(target: VcuTarget): { request: number; response: number } {
  return TARGET_CAN_IDS[target];
}

/** Every id a reply can arrive on, so a shared socket can be filtered without knowing who is being asked. */
export function kwpResponseCanIds(): number[] {
  return [...new Set(Object.values(TARGET_CAN_IDS).map(ids => ids.response))];
}

/** 11-bit CAN id the VCU micros' requests go out on. Kept for callers that only ever talk to A8/A9. */
export const KWP_REQUEST_CAN_ID = TARGET_CAN_IDS.A9.request;

/** 11-bit CAN id the VCU micros' replies come back on. */
export const KWP_RESPONSE_CAN_ID = TARGET_CAN_IDS.A9.response;

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
export function buildRequestFrame(target: VcuTarget, request: VcuRequest): Uint8Array {
  const payload = encodeRequestPayload(request);
  if (!READ_ONLY_SERVICES.has(payload[0])) {
    // Unreachable through the union above, which is exactly why it is here.
    throw new Error(`vcu: refusing to transmit service 0x${payload[0].toString(16)} — not a read-only service`);
  }
  if (payload.length > MAX_SINGLE_FRAME_PAYLOAD) {
    throw new Error(`vcu: request payload of ${payload.length} bytes does not fit one frame`);
  }
  const frame = new Uint8Array(8);
  frame[0] = TARGET_ADDRESS[target];
  frame[1] = payload.length;
  frame.set(payload, 2);
  return frame;
}

/**
 * The CommonIdentifier for a bank and an index: `(bank << 12) | index`.
 *
 * Throws on anything outside the 16-bit space rather than truncating into it, which
 * is the difference between "you asked for something impossible" and "you silently
 * read a different parameter". Both halves are checked, because a caller-supplied
 * bank is now a thing that exists.
 */
export function identifierFor(bank: number, index: number): number {
  if (!Number.isInteger(bank) || bank < 0 || bank > 0xf) {
    throw new Error(`vcu: bank ${bank} is not one of the 16 banks a CommonIdentifier can name`);
  }
  if (!Number.isInteger(index) || index < 0 || index > 0x0fff) {
    throw new Error(`vcu: index ${index} does not fit the 12 bits a bank has`);
  }
  return (bank << 12) | index;
}

/** The bank-1 CommonIdentifier for a parameter index: `0x1000 | index`. The whole parameter table is bank 1. */
export function identifierForIndex(index: number): number {
  return identifierFor(CALIBRATION_BANK, index);
}

function encodeRequestPayload(request: VcuRequest): Uint8Array {
  switch (request.kind) {
    case "start-session":
      return Uint8Array.from([SERVICE_START_DIAGNOSTIC_SESSION, STANDARD_DIAGNOSTIC_SESSION]);
    case "tester-present":
      return Uint8Array.from([SERVICE_TESTER_PRESENT]);
    case "read-parameter": {
      const identifier = identifierFor(request.bank, request.index);
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
