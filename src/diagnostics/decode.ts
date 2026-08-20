import { formatObdDtc, lookupByComponentSymptom, lookupByObdCode, type DtcTableEntry } from "./dtc-table.ts";

// Decoder for the Connectivity Hub's DIAGNOSTICS message (type 25 / 0x19) — the
// bike's currently-ACTIVE fault list, not stored history (mode 03 is that; see
// ./obd-dtc.ts). Pure: bytes in, values out, no I/O and no clock reads, so it can
// be replayed from a capture. The same 8-byte message arrives over Bluetooth and
// over CAN 0x410, where the hub mirrors it, and this decoder serves both — see
// src/ble/client.ts and src/can/hub-mirror.ts.
//
// Layout, from CommParser.java's `case DIAGNOSTICS:` branch — an unfinished stub
// that decodes two codes per message and then throws them away:
//
//   b0 = 25          message type
//   b1               sub-index: 0x00 first page, 0xFE last page, 0xFF whole list
//   b2..b4           first code:  b2 | b3<<8 | (b4 & 0x0F)<<16
//   b5..b7           second code: b5 | b6<<8 | (b7 & 0x0F)<<16
//
// ✅ The low 16 bits are the component number: every non-zero field ever seen is
// raw 0x0002C — component 44, P0A07, this bike's own unwired water pump. Read as
// a binary OBD-II DTC the same bytes give "P002C", which is in no table.
//
// ⚠️ 🟡 THE TOP NIBBLE BEING *SYMPTOM* IS UNTESTED, and stays that way until a
// code with a non-zero nibble arrives: it has been 0 in every reply ever received,
// so "symptom", "padding" and "flags" all predict exactly what we have seen. DO
// NOT upgrade that marker on the strength of more symptom-0 codes — `flags`
// carries the nibble separately for precisely that reason, and both readings stay
// computed (see DiagnosticCode.matchedBy).
//
// Evidence for active-vs-stored, the code's flapping, and why paging is inferred:
// docs/diagnostics-and-checks.md §3.

const DIAGNOSTICS_MESSAGE_TYPE = 25;
// The hub answers `04 11 25 FF` with TWO messages ~10 ms apart: a type 31 no
// version of the app knows about, then the type-25 list. Its six bytes mean
// something unknown, so it is logged rather than decoded.
const DIAGNOSTICS_INFO_MESSAGE_TYPE = 31;
const SUB_INDEX_FIRST_PAGE = 0x00;
const SUB_INDEX_LAST_PAGE = 0xfe;
const SUB_INDEX_WHOLE_LIST = 0xff;

// A stuck hub that never sends a last page must not grow the list without bound.
// 39 codes is 20 pages, so this is ~5× the largest list we have reason to expect.
const MAX_PAGES = 100;

export interface DiagnosticCode {
  /** The 20-bit field exactly as the hub sent it. Always meaningful. */
  raw: number;
  /** Low 16 bits read as the type-approval table's "COD." component number. */
  component: number;
  /** Bits 16-19 read as the table's SYMPTOM index (0-15). */
  symptom: number;
  /** Low 16 bits read instead as a binary OBD-II DTC, e.g. "P1046". */
  obdCodeFromRaw: string;
  /** The masked-off top nibble of b4/b7 — purpose unknown, logged not assumed. */
  flags: number;
  /** The matching table row, or null when neither reading is listed. */
  entry: DtcTableEntry | null;
  /** Which of the two readings produced `entry`. */
  matchedBy: "component" | "obd" | null;
}

export interface DiagnosticReport {
  codes: DiagnosticCode[];
  /** Pages that went into this list — a cheap sanity check on the wire format. */
  pages: number;
}

/**
 * Reassembles a diagnostics list out of the hub's 8-byte messages.
 *
 * Stateful because the list is paged: each message carries at most two codes.
 * `push` returns null while the list is still coming in and the finished report
 * on the last page.
 *
 * ⚠️ PAGING HAS NEVER ACTUALLY BEEN OBSERVED — every reply so far has been a
 * single `0xFF` frame carrying one code or none. So the sub-index convention here
 * is inferred from the hub's other multi-part messages, not documented, which is
 * why it is deliberately tolerant: any sub-index is accepted as a continuation
 * page and only 0xFE/0xFF end the list. docs/diagnostics-and-checks.md §3.
 */
export class DiagnosticListAssembler {
  #codes: DiagnosticCode[] = [];
  #pages = 0;

  push(frame: Uint8Array): DiagnosticReport | null {
    if (frame.length < 8 || frame[0] !== DIAGNOSTICS_MESSAGE_TYPE) {
      return null;
    }
    const subIndex = frame[1];
    if (subIndex === SUB_INDEX_FIRST_PAGE || subIndex === SUB_INDEX_WHOLE_LIST) {
      this.reset();
    }

    this.#pages += 1;
    for (const field of [readCodeField(frame, 2), readCodeField(frame, 5)]) {
      // A list with an odd number of codes leaves the second slot of the last
      // page zeroed, and component 0 does not exist in the table — so a zero
      // field is padding, not a code. This also discards that slot's flags
      // nibble; if the top nibble ever turns out to carry something on its own,
      // the raw-frame dump in record.ts is what would show it.
      if (field.value === 0) {
        continue;
      }
      const code = describeDiagnosticCode(field.value, field.flags);
      if (!this.#codes.some(existing => existing.raw === code.raw)) {
        this.#codes.push(code);
      }
    }

    if (subIndex === SUB_INDEX_LAST_PAGE || subIndex === SUB_INDEX_WHOLE_LIST || this.#pages >= MAX_PAGES) {
      const report: DiagnosticReport = { codes: this.#codes, pages: this.#pages };
      this.reset();
      return report;
    }
    return null;
  }

  reset(): void {
    this.#codes = [];
    this.#pages = 0;
  }
}

/** Both readings of one 20-bit code field, resolved against the table. */
export function describeDiagnosticCode(raw: number, flags: number): DiagnosticCode {
  const component = raw & 0xffff;
  const symptom = (raw >> 16) & 0x0f;
  const obdCodeFromRaw = formatObdDtc(component);

  const byComponent = lookupByComponentSymptom(component, symptom);
  if (byComponent) {
    return { raw, component, symptom, obdCodeFromRaw, flags, entry: byComponent, matchedBy: "component" };
  }
  const byObdCode = lookupByObdCode(obdCodeFromRaw);
  if (byObdCode) {
    return { raw, component, symptom, obdCodeFromRaw, flags, entry: byObdCode, matchedBy: "obd" };
  }
  return { raw, component, symptom, obdCodeFromRaw, flags, entry: null, matchedBy: null };
}

/** Is this an 8-byte hub message carrying diagnostics? */
export function isDiagnosticsMessage(frame: Uint8Array): boolean {
  return frame.length >= 8 && frame[0] === DIAGNOSTICS_MESSAGE_TYPE;
}

/** Is this the undecoded type-31 message the hub sends with the code list? */
export function isDiagnosticsInfoMessage(frame: Uint8Array): boolean {
  return frame.length >= 8 && frame[0] === DIAGNOSTICS_INFO_MESSAGE_TYPE;
}

function readCodeField(frame: Uint8Array, offset: number): { value: number; flags: number } {
  return {
    value: frame[offset] | (frame[offset + 1] << 8) | ((frame[offset + 2] & 0x0f) << 16),
    flags: (frame[offset + 2] >> 4) & 0x0f,
  };
}
