import { lookupByComponentSymptom } from "./dtc-table.ts";
import { freezeFrameFieldBytes, infokeyFieldsFor, infokeysFor, type FaultInfokeys } from "./fault-infokeys.ts";
import { infokeyWidth, scaleInfokeyValue, type InfokeyDatatype, type InfokeyField } from "./infokey-table.ts";
import { describeNegativeResponseCode } from "./obd-dtc.ts";

// The third fault channel: what the bike was doing at the moment a code latched.
//
// Pure — bytes in, values out, no socket and no clock — so the whole thing is
// exercised from a laptop against constructed payloads (scripts/check-freeze-frame.ts).
// Same split as ./obd-dtc.ts and src/vcu/param-codec.ts.
//
// ── ⚠️ THE THREE CHANNELS ARE DIFFERENT QUESTIONS. DO NOT MERGE THEM. ───────
//   • Connectivity Hub type-25 (mirrored to CAN 0x410) — what is ACTIVE right
//     now. 0 or 1 entries, and it flickers. src/diagnostics/decode.ts.
//   • OBD-II mode 03 — what is STORED. 39 entries on this bike, stable.
//     src/diagnostics/obd-dtc.ts.
//   • THIS — the conditions when ONE code latched. One record per component.
// Conflating them has already caused confusion in this project's own notes.
//
// ── ⚠️ AND THE ENCODINGS ARE DIFFERENT TOO, WHICH IS THE ACTUAL TRAP ────────
// This service speaks Energica's (component, symptom) pair, NOT the 16-bit
// binary DTC that mode 03 returns. The `code` in the request is the COMPONENT
// NUMBER, 1…63 — the "COD." column of ./dtc-table.ts. Sending 0x0514 here
// because mode 03 called something P0514 asks for component 1300, which does not
// exist. Going the other way, mode 03's `2C 00` is P002C under its own encoding
// and P0A07 under this one. src/diagnostics/obd-dtc.ts' header warns about the
// same trap from the other side.
//
// The SYMPTOM is not in the request. It comes back in the status byte's high
// nibble, so the caller asks about a component and the ECU says which of that
// component's faults it has a frame for. Everything below therefore keys off the
// RETURNED pair, never the requested one.
//
// ── The wire format, and exactly how much of it is established ──────────────
//
// ✅ THE REQUEST IS PROVEN, twice over.
//   • On the wire, 2026-08-08, passive capture of the Energica factory software
//     (obd-garage/DIAG_ADDRESSES.md §9.1): service `0x17` was sent 29 times, to
//     micro A8 and to no other, and every one of the 29 got a POSITIVE `57`
//     reply. So the service exists on THIS bike, on that micro, and it answers.
//   • In Energica's own code, 2026-08-16: the service tool's shared library has
//     `KWP2000::ReadDiagnosticTroubleCodeInformation` emitting service byte `0x17`
//     with a two-byte identifier `[(code & 0xFF00) >> 8, code & 0xFF]`, and its
//     caller `ReadDTCDetails` does TesterPresent → `10 81` → SetFullDLC → send,
//     against `MotorbikeECU.VCUSafety`. No SecurityAccess anywhere in that path.
//
//   request   7C0:  A8 03 17 <componentHi> <componentLo> 00 00 00
//   response  7E0:  F1 ..  57 …
//
// ⚠️ THE RESPONSE LAYOUT IS NOT PROVEN. The census counted service bytes and
// discarded the payloads, so no `0x17` reply has ever been recorded.
//
// 🟡 What IS known: the service tool's `DTCode.GetInfoDetails` reads the status from
// index 3 of its buffer and starts the fields at index 4, walking the DTC's infokeys in
// order by datatype width (recovered from IL; the second owner's tool documents
// the same two constants). Both agree the status sits immediately before the
// fields. What neither settles is whether that buffer still has the `57` service
// byte on the front — so there are two readings, and they differ by ONE byte:
//
//   5-byte header  57 <count> <compHi> <compLo> <status> <fields…>   ← implemented
//   4-byte header  57         <compHi> <compLo> <status> <fields…>
//
// The 5-byte reading is preferred because it makes `0x17` the same shape as its
// sibling `0x18` ReadDTCByStatus, which was seen on A8 in the same capture and
// answers `58 <count>` followed by 3-byte `<hi> <lo> <status>` records — the tool
// "unconditionally skips payload[0]" before walking those. A `0x17` reply that is
// that header with exactly one record, then the fields, puts status at index 3
// and fields at index 4 of a service-byte-less buffer, which is precisely what
// GetInfoDetails does. That is a coherent story, not a proof.
//
// ⚠️ SO THE DECODER REPORTS RATHER THAN ASSUMES, and the reply's own LENGTH is
// what settles it: the two readings predict payloads one byte apart, and the
// fault's shortlist says exactly how many field bytes there should be.
// `headerBytesThatFit` does that arithmetic on every decode and is the first
// thing to read on the first live reply. `trailingHex`, `truncated` and a
// `recordCount` that is not 1 are the other tells, and none of them is smoothed
// away.
//
// ── The OTHER freeze-frame route, deliberately not implemented ──────────────
// The service tool has a second one: `KWP2000Moto.ReadFreezeFrame` dumps the whole
// stored freeze-frame LOG as a stream, via `0x35` RequestUpload with identifier byte
// `0x12` (`RoutinesID.ReadFreezeFrame`) and operand `FF`×10, then N × `0x36`
// TransferData, then `0x37`. That is what the 1198-frame transfer in
// obd-garage/DIAG_ADDRESSES.md §9.6 actually was: `A8 10 0C 35 12 FF FF FF` is
// RequestUpload with identifier `0x12` and a 10-byte operand, and `1 + 1 + 10`
// is the `0x0C` the First Frame declares. ⚠️ That file (local-only, not in this
// repo) calls it "the software dumping A8's memory image", which is WRONG and
// should be corrected there. Each `0x36` reply carries one record: a 4-byte big-endian timestamp
// (seconds since 2000-01-01), then `<compHi> <compLo> <status>`, then the same
// info-key field block. It is a read, and it would give timestamps this service
// does not — but it is 1200 frames of upload-family services, and `0x17` answers
// the question this app is asking about one code at a time.
//
// ── ⚠️ READ-ONLY, AND STRUCTURALLY SO ──────────────────────────────────────
// `FreezeFrameRequest` is a closed union with ONE member, and the encoder throws
// on anything else. `0x17` is a read; the things next to it in the tool are not,
// and none of them may ever be expressible here:
//
//   • `31 FE` StartRoutine (`RoutinesID.VCUErase`) with the 8-byte operand
//     `01 00 00 00 01 FF FF FF`, then `33 FE` RequestRoutineResults polled until
//     it reports 0 — the tool's freeze-frame ERASE, and it takes SecurityAccess
//     first (`27 01` on A8) where the read takes none. It exists, it is written
//     down here so nobody has to rediscover it, and it is deliberately not
//     implemented. It is a flash erase of the bike's own record of why it
//     faulted: the least reversible thing in this corner of the protocol, and
//     worth nothing to a telemetry app.
//   • `14 FF FF` ClearDiagnosticInformation — clears the stored codes. Also not
//     ours. Note the factory software sends both, erase then clear, in that order.
//   • `0x35`/`0x36`/`0x37` upload — the factory tool's 7-minute bulk read-out of
//     A8. A read, but a 1200-frame one, and not this.
//
// src/vcu/param-codec.ts' header lists the services that must never appear there;
// this is the same rule for this service's own module. Why this is a separate
// closed union rather than a fourth member of that one is argued at
// `buildFreezeFrameRequestFrame`.

/** `0x17` ReadDiagnosticTroubleCodeInformation, in KWP2000 terms. The only service here. */
const SERVICE_READ_DTC_INFORMATION = 0x17;

/** ISO 14229: a positive response echoes the request service plus 0x40. */
const POSITIVE_RESPONSE_OFFSET = 0x40;
const NEGATIVE_RESPONSE_SERVICE = 0x7f;

/**
 * Byte 0 of a request under this bus' extended addressing: who it is for. A8, the
 * VCU safety micro, and only A8.
 *
 * Not a parameter, because it is not a choice: all 29 captured `0x17` requests
 * went to A8, the service tool's own code targets `MotorbikeECU.VCUSafety`, and the
 * freeze-frame flash bookkeeping fields (`FlashExt*`, infokeys 102…105) sit with
 * the safety micro. Making the target callable would invite asking A9, which
 * would at best answer nothing and at worst answer something else. The CAN ids
 * are the ordinary VCU pair, 0x7C0 out and 0x7E0 back — stated in the header
 * rather than as constants here, since nothing in this module sends a frame.
 */
const VCU_SAFETY_ADDRESS = 0xa8;

/** `57 <count> <componentHi> <componentLo> <status>` — everything before the first field. */
export const FREEZE_FRAME_HEADER_BYTES = 5;

/**
 * The header lengths that are still on the table, longest first.
 *
 * 5 is what this module decodes with; 4 is the same layout without the record-count
 * byte. See the header for why 5 is preferred and why neither is proven. A reply's
 * length picks between them, because the two predict payloads exactly one byte
 * apart — `headerBytesThatFit` on every decoded frame does that arithmetic.
 */
const CANDIDATE_HEADER_BYTES: readonly number[] = [FREEZE_FRAME_HEADER_BYTES, 4];

/** The VCU's component numbers, per ./dtc-table.ts. Anything outside is a caller bug. */
const MIN_COMPONENT = 1;
const MAX_COMPONENT = 63;

/**
 * Everything this module is permitted to ask. One member, on purpose — see the
 * header for the neighbouring services that must stay unexpressible.
 */
export type FreezeFrameRequest = { kind: "read-freeze-frame"; component: number };

/** Every service byte this module may emit. Checked on the way out, behind the union. */
const READ_ONLY_SERVICES: ReadonlySet<number> = new Set([SERVICE_READ_DTC_INFORMATION]);

/**
 * The 8-byte CAN frame that asks for one component's freeze frame.
 *
 * Zero-padded to a full 8-byte DLC because that is what the service tool sends
 * (OTHER_TOOL_AUDIT.md §4.3, "full 8-byte DLC") — the length byte governs, but a
 * short frame is a difference from the only known-good sender and this is not the
 * place to introduce one.
 *
 * ⚠️ NOT built through src/vcu/param-codec.ts, and that is deliberate rather than
 * duplication. That module's request union is the guarantee that nothing in this
 * repo can write to the VCU's calibration EEPROM, and its comment says which
 * services may never be added to it. Widening it for a service that reads a
 * different thing entirely would spend that guarantee for no gain, and would put
 * `0x17` one keystroke away from `0x14` and `0x31` in the same switch. The
 * FRAMING is shared — same extended addressing, same target byte, same PCI, same
 * request and response ids — and it is shared by being the same three lines,
 * which is cheaper than the coupling. What CANNOT be duplicated so cheaply is the
 * session, which is why nothing in this repo sends this frame yet: see the note
 * on flow control in ./extended-iso-tp.ts.
 *
 * Throws rather than returning an error: every caller is this repo's own code.
 */
export function buildFreezeFrameRequestFrame(request: FreezeFrameRequest): Uint8Array {
  const payload = encodeRequestPayload(request);
  if (!READ_ONLY_SERVICES.has(payload[0])) {
    // Unreachable through the union above, which is exactly why it is here.
    throw new Error(`freeze-frame: refusing to transmit service 0x${payload[0].toString(16)} — not a read`);
  }
  const frame = new Uint8Array(8);
  frame[0] = VCU_SAFETY_ADDRESS;
  frame[1] = payload.length;
  frame.set(payload, 2);
  return frame;
}

function encodeRequestPayload(request: FreezeFrameRequest): Uint8Array {
  switch (request.kind) {
    case "read-freeze-frame": {
      const { component } = request;
      if (!Number.isInteger(component) || component < MIN_COMPONENT || component > MAX_COMPONENT) {
        // Thrown, not clamped. A component number out of range is a bug in the
        // caller, and truncating it into range would ask about a different fault
        // and answer confidently about the wrong one.
        throw new Error(`freeze-frame: component ${component} is outside ${MIN_COMPONENT}…${MAX_COMPONENT}`);
      }
      return Uint8Array.from([SERVICE_READ_DTC_INFORMATION, (component >> 8) & 0xff, component & 0xff]);
    }
    default:
      // Unreachable while the union stays closed; TypeScript proves that. It
      // exists for the version of this file where someone adds a member and
      // forgets a branch — see src/vcu/param-codec.ts for the same guard.
      throw new Error(`freeze-frame: unknown request kind ${JSON.stringify(request)}`);
  }
}

/**
 * What the status byte says, beyond the symptom.
 *
 * 🟡 INFERRED, 2026-08-16, and one notch weaker than the layout above: this comes
 * from the second owner's reading of the service tool's `DTCodeKey` UF* properties
 * (obd-garage/OTHER_TOOL_AUDIT.md), not from any capture. It is NOT the generic
 * ISO 14229 DTCStatusMask, which assigns those bits differently — so decoding one
 * of these with a standard scan-tool status decoder gives confident nonsense.
 *
 *   bits 7:4  symptom — part of the code's identity, not a flag
 *   bit  3    lamp on
 *   bits 2:1  0 = not active · 1 = active · 2 = memory / freeze frame
 *   bit  0    stored in memory
 *
 * `activity` is kept as the raw two-bit field rather than being flattened into
 * booleans: the value 3 is not described by any source, and a boolean pair would
 * have to invent a meaning for it.
 */
export interface FreezeFrameStatusFlags {
  /** Bit 3 — this code has the malfunction indicator lamp on. */
  lampOn: boolean;
  /** Bit 0 — stored in memory. */
  stored: boolean;
  /** Bits 2:1, verbatim. 0 not active, 1 active, 2 memory/freeze-frame, 3 undocumented. */
  activity: number;
  /** True only for `activity === 2`, the value that means a freeze frame exists. */
  hasFreezeFrame: boolean;
}

/** Splits a status byte into its flags. Pure; the symptom is read separately. */
export function decodeFreezeFrameStatus(status: number): FreezeFrameStatusFlags {
  const activity = (status & 0x06) >> 1;
  return {
    lampOn: (status & 0x08) !== 0,
    stored: (status & 0x01) !== 0,
    activity,
    hasFreezeFrame: activity === 2,
  };
}

/** One field of a freeze frame, as read and as scaled. */
export interface FreezeFrameValue {
  /** The infokey id, 1…120. An index into Energica's dictionary, never an address. */
  infokey: number;
  /** Energica's own name for it, verbatim. */
  name: string;
  /** The unit AFTER scaling. Empty for a flag or a status word. */
  unit: string;
  datatype: InfokeyDatatype;
  /** Exactly what the bytes said, signed per the datatype. Always meaningful. */
  raw: number;
  /**
   * The number to show a human, or null when Energica states a scaling this repo
   * refuses to apply. Null is not "no value" — `raw` is still true — it is "we
   * will not put a unit on this".
   */
  value: number | null;
  /** Energica's equation, verbatim, so a null `value` can be argued about. */
  equation: string;
  /** Why `value` is null, or null when it is not. */
  scalingNote: string | null;
}

/** A decoded freeze frame. */
export interface FreezeFrame {
  /** The component the ECU echoed back, 1…63. */
  component: number;
  /** From the status byte's high nibble — which fault of that component. */
  symptom: number;
  /** The whole status byte, raw, so nothing about it is lost to the reading below. */
  status: number;
  /** The status byte's flags. See decodeFreezeFrameStatus for how firmly they are known. */
  flags: FreezeFrameStatusFlags;
  /**
   * The record-count byte. Expected 1, since one component was asked about.
   * Carried rather than checked into an error, because a bike that answers 0 or 2
   * here is telling us the header reading is wrong and that is worth seeing.
   */
  recordCount: number;
  /** ./dtc-table.ts' OBD code for the returned pair, or null if it lists none. */
  obdCode: string | null;
  /** What Energica means by this code on this vehicle, or null if unlisted. */
  description: string | null;
  /** The fields, in payload order. Empty when the fault's shortlist is empty. */
  values: FreezeFrameValue[];
  /**
   * False when the service tool lists no shortlist for the returned pair, in which case
   * `values` is empty because nothing could be decoded — NOT because the frame
   * was empty. The two must not look the same on screen.
   */
  shortlistKnown: boolean;
  /**
   * The payload ended before the shortlist did. The fields that did fit are still
   * returned; a short frame is useful, a silently short one is not.
   */
  truncated: boolean;
  /**
   * Every byte of the body that no field consumed, as hex — surplus after the
   * last field, or the fragment of a field that did not fit when `truncated`.
   *
   * MUST be empty if the layout in this file's header is right, which makes it
   * the single most informative field in the whole structure on the first live
   * read. Never dropped: on a real reply these are the bytes that would explain
   * what the layout actually is.
   */
  trailingHex: string;
  /**
   * Which of the candidate header lengths this reply's LENGTH is consistent with,
   * given the fault's shortlist. The tie-breaker for the one thing about the wire
   * format that is genuinely unresolved.
   *
   *   [5]     the implemented reading is right
   *   [4]     🚨 the header has no record-count byte; every field here is shifted
   *           one byte and the numbers are wrong. Change FREEZE_FRAME_HEADER_BYTES.
   *   []      neither fits — the layout is something else again, and `rawHex` is
   *           the evidence
   *   [5, 4]  impossible unless the shortlist is empty, since the two differ by one
   *
   * Empty when the shortlist is unknown, because then there is nothing to
   * compare a length against.
   */
  headerBytesThatFit: number[];
  /** Everything the bike sent, uppercase hex. Always present, whatever else failed. */
  rawHex: string;
}

/**
 * How one freeze-frame read came out.
 *
 * ⚠️ EVERY variant carries `rawHex`, not just the successful one, and that is
 * deliberate: on the first read against a real bike the LIKELIEST outcome is
 * `unrecognised` — the header below is an inference — and that is precisely the
 * reply whose bytes would say what the layout actually is. A one-line reason with
 * the payload thrown away would waste the only run that could settle it.
 */
export type FreezeFrameResponse =
  | { kind: "frame"; frame: FreezeFrame }
  /** The micro said no to THIS service, by name. */
  | { kind: "refused"; service: number; negativeResponseCode: number; description: string; rawHex: string }
  /**
   * A well-formed frame about a DIFFERENT component. Kept apart from
   * `unrecognised` for the reason src/vcu/param-codec.ts keeps
   * `identifier-mismatch` apart: the bytes decode perfectly, they are just the
   * answer to another question, and filing them under the component we asked
   * about is the exact silent wrong answer this repo refuses to produce.
   */
  | { kind: "component-mismatch"; requested: number; received: number; rawHex: string }
  /** Something answered in a shape this service does not define. */
  | { kind: "unrecognised"; reason: string; rawHex: string };

/**
 * Decodes one reassembled `0x17` reply.
 *
 * `payload` starts with the response service byte — `57` for a positive reply,
 * `7F` for a refusal — with every ISO-TP PCI byte already stripped. That is this
 * repo's convention everywhere (./obd-dtc.ts, src/vcu/param-codec.ts) and it is
 * ONE MORE than the index the second owner's tool counts from, which counts a
 * payload with the service byte removed. Both readings put the fields in the same
 * place; only the numbers in the two files' comments differ.
 *
 * `requestedComponent` is checked against the echo. The bus carries every VCU
 * reply on one id with no request tag, so an answer to somebody else's question
 * is a thing that happens here.
 */
export function decodeFreezeFrameResponse(payload: Uint8Array, requestedComponent: number): FreezeFrameResponse {
  const rawHex = toHex(payload);
  if (payload.length === 0) {
    return { kind: "unrecognised", reason: "empty payload", rawHex };
  }
  if (payload[0] === NEGATIVE_RESPONSE_SERVICE) {
    if (payload.length < 3) {
      return { kind: "unrecognised", reason: "negative response without a service and a code", rawHex };
    }
    if (payload[1] !== SERVICE_READ_DTC_INFORMATION) {
      // Somebody else's refusal on the shared response id — this repo's own
      // parameter sweep asks `0x22` on 0x7C0 and is answered on 0x7E0, so a
      // `7F 22 31` landing in our reply window is a thing that happens rather
      // than a hypothetical. Filing it as ours would report the freeze-frame read
      // as refused when the micro never heard the question, and `service` sitting
      // in the result does not help: the KIND already claims it answered us.
      return {
        kind: "unrecognised",
        reason: `refusal names service 0x${payload[1].toString(16)}, not 0x17`,
        rawHex,
      };
    }
    // ⚠️ NRC 0x78 responsePending is in here too, and it is a WAIT, not a
    // refusal — the micro is saying "ask again shortly". Whoever wires the
    // transport must keep the reply window open after one instead of treating
    // this kind as terminal; `negativeResponseCode` is what to switch on.
    return {
      kind: "refused",
      service: payload[1],
      negativeResponseCode: payload[2],
      description: describeNegativeResponseCode(payload[2]),
      rawHex,
    };
  }
  if (payload[0] !== SERVICE_READ_DTC_INFORMATION + POSITIVE_RESPONSE_OFFSET) {
    return { kind: "unrecognised", reason: `reply names service 0x${payload[0].toString(16)}, not 0x57`, rawHex };
  }
  if (payload.length < FREEZE_FRAME_HEADER_BYTES) {
    // ⚠️ A reply of exactly 4 bytes is the interesting case here: that is a valid
    // empty-shortlist frame UNDER THE 4-BYTE READING this file's header says is
    // still on the table, i.e. the one reply shape that would falsify the choice.
    // It is still reported rather than decoded — reading it would mean silently
    // switching layouts mid-flight — but `rawHex` carries the bytes out, which is
    // what makes it actionable instead of merely rejected.
    return {
      kind: "unrecognised",
      reason: `positive reply of ${payload.length} bytes is shorter than the ${FREEZE_FRAME_HEADER_BYTES}-byte header`,
      rawHex,
    };
  }

  const recordCount = payload[1];
  const component = (payload[2] << 8) | payload[3];
  const status = payload[4];
  if (component !== requestedComponent) {
    return { kind: "component-mismatch", requested: requestedComponent, received: component, rawHex };
  }
  // The symptom is part of the code's identity, not a status flag: component 8
  // symptom 3 is U0113 and symptom 4 is U0114. The service tool's own DTCode.FindDTCFrom
  // matches on `(status & 240) >> 4`.
  const symptom = (status & 0xf0) >> 4;

  const shortlist = infokeysFor(component, symptom);
  const tableEntry = lookupByComponentSymptom(component, symptom);
  const body = payload.subarray(FREEZE_FRAME_HEADER_BYTES);

  const frame: FreezeFrame = {
    component,
    symptom,
    status,
    flags: decodeFreezeFrameStatus(status),
    recordCount,
    obdCode: tableEntry?.obdCode ?? null,
    description: tableEntry?.description ?? null,
    values: [],
    shortlistKnown: shortlist !== null,
    truncated: false,
    trailingHex: "",
    headerBytesThatFit: shortlist ? headerBytesThatFit(payload.length, freezeFrameFieldBytes(shortlist)) : [],
    rawHex,
  };
  if (!shortlist) {
    // No shortlist means no layout, so the body cannot be split into fields at
    // all. Handing back the whole body as "trailing" is the honest rendering:
    // these are bytes we have and cannot name.
    frame.trailingHex = toHex(body);
    return { kind: "frame", frame };
  }

  const { values, consumed, truncated } = readFields(body, shortlist);
  frame.values = values;
  frame.truncated = truncated;
  frame.trailingHex = toHex(body.subarray(consumed));
  return { kind: "frame", frame };
}

/**
 * Which candidate header lengths a payload of this size is consistent with.
 *
 * Pure arithmetic on two numbers, kept as its own function so the check can
 * exercise the 4-byte arm without having to forge a whole reply in the wrong
 * layout — which would look exactly like a bug to the next reader.
 */
export function headerBytesThatFit(payloadBytes: number, fieldBytes: number): number[] {
  return CANDIDATE_HEADER_BYTES.filter(header => payloadBytes - header === fieldBytes);
}

/** Walks a shortlist across the body. Stops at the first field that does not fit. */
function readFields(
  body: Uint8Array,
  shortlist: FaultInfokeys
): { values: FreezeFrameValue[]; consumed: number; truncated: boolean } {
  const values: FreezeFrameValue[] = [];
  let offset = 0;
  for (const field of infokeyFieldsFor(shortlist)) {
    const width = infokeyWidth(field.datatype);
    if (offset + width > body.length) {
      // Stop, do not skip. Skipping a field that did not fit and carrying on
      // would decode every LATER field from the wrong offset — and those would
      // come out as numbers, not as errors.
      return { values, consumed: offset, truncated: true };
    }
    values.push(readField(field, body.subarray(offset, offset + width)));
    offset += width;
  }
  return { values, consumed: offset, truncated: false };
}

function readField(field: InfokeyField, bytes: Uint8Array): FreezeFrameValue {
  // Big-endian, like every other multi-byte value on this diagnostic channel —
  // and unlike the broadcast frames, which are little-endian (src/can/decode.ts).
  // Mixing those up is a silent factor-of-256 error, so it is stated here.
  const unsigned = bytes.reduce((accumulated, byte) => accumulated * 256 + byte, 0);
  const bits = bytes.length * 8;
  const signed = field.datatype.startsWith("int") && unsigned >= 2 ** (bits - 1) ? unsigned - 2 ** bits : unsigned;
  const scaling = scaleInfokeyValue(field, signed);
  return {
    infokey: field.id,
    name: field.name,
    unit: field.unit,
    datatype: field.datatype,
    raw: signed,
    value: scaling.applied ? scaling.value : null,
    equation: field.equation,
    scalingNote: scaling.applied ? null : scaling.reason,
  };
}

/**
 * How many payload bytes a fault's freeze frame should be, header included.
 *
 * The prediction the first live read gets to falsify: if the layout in this
 * file's header is right, a reply is exactly this long.
 */
export function expectedFreezeFramePayloadBytes(shortlist: FaultInfokeys): number {
  return FREEZE_FRAME_HEADER_BYTES + freezeFrameFieldBytes(shortlist);
}

/** One field as a log line: "B_PACK_V = 345.2 V (raw 3452)". */
export function formatFreezeFrameValue(value: FreezeFrameValue): string {
  if (value.value === null) {
    return `${value.name} = ${value.raw} [raw; ${value.scalingNote}: ${value.equation}]`;
  }
  const shown = Number.isInteger(value.value) ? value.value : Number(value.value.toFixed(3));
  const unit = value.unit ? ` ${value.unit}` : "";
  return value.equation ? `${value.name} = ${shown}${unit} (raw ${value.raw})` : `${value.name} = ${shown}${unit}`;
}

/** Uppercase, space-separated hex — the shape obd-garage's notes quote raw payloads in. */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0").toUpperCase()).join(" ");
}
