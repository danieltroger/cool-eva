import { formatObdDtc, lookupByObdCode, type DtcTableEntry } from "./dtc-table.ts";

// Decoder for the OBD-II trouble-code services — mode 03 (stored), 07 (pending)
// and 0A (permanent). Pure: bytes in, codes out, so a reply captured off the bus
// can be replayed on a laptop; scripts/decode-dtc-response.ts does that against
// the 2026-08-04 transfer, which is proven byte-identical across five captures.
//
// This is a DIFFERENT list from the one src/diagnostics/decode.ts decodes — that
// one is the bike's ACTIVE faults (0 or 1 here, and it flickers minute to minute),
// this one is STORED history (39 here, and it does not).
//
// ⚠️ AND THE TWO USE DIFFERENT CODE ENCODINGS, WHICH IS THE TRAP. The hub sends a
// 20-bit (component, symptom) pair keyed the way Energica's own table is keyed;
// mode 03 sends the 16-bit binary DTC a generic scan tool prints, so the table is
// reached through its OBD column instead, via lookupByObdCode(). Feeding one
// encoding to the other's lookup silently produces WRONG NAMES rather than no
// names: the hub's `2C 00 00` reads as P0A07 one way and as P002C the other.
//
// ⚠️ MODES 07 AND 0A HAVE NEVER ANSWERED — six attempts over 5 s windows on a
// quiet bus, silence rather than a negative response. That is NOT the same claim
// as "nothing is pending", and nothing here or on the dashboard may render it as
// one: an ECU that does not implement the service and an ECU suppressing the
// answer look identical from here. The transport reports silence as its own
// outcome (src/can/obd-dtc.ts) rather than as an empty list.
//
// The captured payload and what it establishes: docs/diagnostics-and-checks.md §4.

/** The three read-only trouble-code request services. Nothing else belongs here. */
export const MODE_STORED_DTCS = 0x03;
export const MODE_PENDING_DTCS = 0x07;
export const MODE_PERMANENT_DTCS = 0x0a;

/** ISO 14229: a positive response echoes the request service plus 0x40. */
const POSITIVE_RESPONSE_OFFSET = 0x40;
const NEGATIVE_RESPONSE_SID = 0x7f;

export type DtcListKind = "stored" | "pending" | "permanent";

const LIST_KIND_BY_MODE: Record<number, DtcListKind> = {
  [MODE_STORED_DTCS]: "stored",
  [MODE_PENDING_DTCS]: "pending",
  [MODE_PERMANENT_DTCS]: "permanent",
};

export interface ObdTroubleCode {
  /** The 16-bit field exactly as the bike sent it. Always meaningful. */
  raw: number;
  /** Rendered the way a scan tool prints it, e.g. "P0514". */
  code: string;
  /** Energica's row for that code, or null when the table does not list it. */
  entry: DtcTableEntry | null;
}

export type ObdDtcResponse =
  | {
      kind: "codes";
      list: DtcListKind;
      /** The count byte the bike sent, before we looked at the payload. */
      declaredCount: number;
      codes: ObdTroubleCode[];
      /**
       * True when fewer codes were present than the count byte promised — i.e. the
       * reply was cut short. The codes we did get are still returned; a partial
       * list is useful, a silently short one is not.
       */
      truncated: boolean;
    }
  | { kind: "negative"; requestedService: number; negativeResponseCode: number }
  | { kind: "unrecognised"; reason: string };

/**
 * Decodes one reassembled trouble-code reply.
 *
 * `payload` is the service data with every ISO-TP PCI byte already stripped, so it
 * begins with the response service id — `43`, `47` or `4A` for a positive reply,
 * `7F` for a refusal.
 *
 * `requestedMode` is what we asked for, and it is checked against what came back.
 * The bus carries replies to the whole 0x7E0-0x7EF range, and the OBD poller is
 * asking mode-01 questions on the same functional address at 2 Hz, so a reply to
 * someone else's question is a thing that actually happens here. Matching on the
 * service id is what keeps a mode-01 answer out of the mode-03 list.
 */
export function decodeObdDtcResponse(payload: Uint8Array, requestedMode: number): ObdDtcResponse {
  if (payload.length < 1) {
    return { kind: "unrecognised", reason: "empty payload" };
  }
  const responseService = payload[0];

  if (responseService === NEGATIVE_RESPONSE_SID) {
    // `7F <service> <NRC>`. Both trailing bytes are optional in practice — a
    // truncated refusal is still a refusal, so report it with what arrived.
    return {
      kind: "negative",
      requestedService: payload[1] ?? 0,
      negativeResponseCode: payload[2] ?? 0,
    };
  }

  const list = LIST_KIND_BY_MODE[requestedMode];
  if (list === undefined) {
    return { kind: "unrecognised", reason: `mode 0x${requestedMode.toString(16)} is not a trouble-code service` };
  }
  if (responseService !== requestedMode + POSITIVE_RESPONSE_OFFSET) {
    return {
      kind: "unrecognised",
      reason: `service 0x${responseService.toString(16)} answering a mode 0x${requestedMode.toString(16)} request`,
    };
  }

  // ISO 15765-4 §6.3: over CAN the byte after the service id is the number of
  // codes. Confirmed on this bike 2026-08-04 — the byte read 0x27 and exactly 39
  // code pairs followed, matching mode 01 PID 01's count. It is trusted only as a
  // cross-check, never as the loop bound: the payload's own length decides how
  // many codes we read, so a wrong count byte cannot walk us off the end.
  const declaredCount = payload.length >= 2 ? payload[1] : 0;
  const body = payload.subarray(2);
  const codes: ObdTroubleCode[] = [];
  for (let offset = 0; offset + 1 < body.length; offset += 2) {
    const raw = (body[offset] << 8) | body[offset + 1];
    // `00 00` is an empty slot, not code P0000: a list with an odd number of codes
    // pads its last frame out, and the padding lands here. Energica's table has no
    // P0000 either, so keeping it would put an unnameable phantom on the screen.
    if (raw === 0) {
      continue;
    }
    const code = formatObdDtc(raw);
    codes.push({ raw, code, entry: lookupByObdCode(code) });
  }

  return { kind: "codes", list, declaredCount, codes, truncated: codes.length < declaredCount };
}

/**
 * A negative response code as text, for log lines. Only the codes ISO 14229 lists
 * that we have any reason to see on this bus; anything else is reported by number,
 * which is the honest answer for a code we cannot name.
 */
export function describeNegativeResponseCode(negativeResponseCode: number): string {
  const known: Record<number, string> = {
    0x10: "generalReject",
    0x11: "serviceNotSupported",
    0x12: "subFunctionNotSupported",
    0x21: "busyRepeatRequest",
    0x22: "conditionsNotCorrect",
    0x31: "requestOutOfRange",
    0x33: "securityAccessDenied",
    0x78: "responsePending",
  };
  const name = known[negativeResponseCode];
  const hex = `0x${negativeResponseCode.toString(16).padStart(2, "0")}`;
  return name ? `${hex} (${name})` : hex;
}

/** One code as a log line: "P0514 — Error reading temperature [MIL]". */
export function formatObdTroubleCode(troubleCode: ObdTroubleCode): string {
  if (!troubleCode.entry) {
    return `${troubleCode.code} — not in Energica's table (raw 0x${troubleCode.raw.toString(16).padStart(4, "0")})`;
  }
  return `${troubleCode.code} — ${troubleCode.entry.description}${milSuffix(troubleCode.entry.illuminatesMil)}`;
}

/**
 * "[MIL]", "[MIL?]" or nothing. The middle case is a code whose MIL column no
 * source states (dtc-table.ts nulls those); printing nothing there would read as
 * a positive "does not light the lamp".
 */
function milSuffix(illuminatesMil: boolean | null): string {
  if (illuminatesMil === null) {
    return " [MIL?]";
  }
  return illuminatesMil ? " [MIL]" : "";
}
