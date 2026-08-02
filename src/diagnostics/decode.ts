import { formatObdDtc, lookupByComponentSymptom, lookupByObdCode, type DtcTableEntry } from "./dtc-table.ts";

// Decoder for the Connectivity Hub's DIAGNOSTICS message (type 25 / 0x19), which
// is how the bike hands over its stored trouble codes. Pure: bytes in, values
// out, no I/O and no clock reads, so it can be replayed from a capture.
//
// The same 8-byte message reaches us over two transports and this decoder serves
// both (see src/ble/client.ts and src/can/hub-mirror.ts):
//   • Bluetooth — the hub's notify characteristic, in reply to `04 11 25 FF`
//   • CAN 0x410 — the hub mirrors every one of its Bluetooth messages onto the
//     VDB bus with byte 0 = type and byte 1 = sub-index (confirmed in
//     obd-garage/captures/2026-08-02_bms_90s.log: `1A 00`/`1A 01`/`1A FE` GPS,
//     `02 xx` vehicle status, `04 xx` odometer, `00 FF` seed)
//
// Layout, from CommParser.java's `case DIAGNOSTICS:` branch — an unfinished stub
// that decodes two codes per message and then throws them away:
//
//   b0 = 25          message type
//   b1               sub-index: 0x00 first page, 0xFE last page, 0xFF whole list
//   b2..b4           first code:  b2 | b3<<8 | (b4 & 0x0F)<<16
//   b5..b7           second code: b5 | b6<<8 | (b7 & 0x0F)<<16
//
// So each code is 20 bits and the top nibble of b4/b7 is masked off — the app
// never used it, and we log it (see `flags`) rather than assume it is padding.
//
// ⚠️ NO CODE HAS EVER BEEN DECODED. The request/reply mechanism is verified —
// asking gets a well-formed type-25 reply on both transports, byte-identical
// across two runs 60 s apart — but every list so far has come back EMPTY (zero
// codes) while OBD-II PID 0x01 says 38 are stored. Two readings of that fit and
// neither is settled: the hub may serve only *currently active* faults while PID
// 0x01 counts *stored* history, or the VCU may simply refuse the list while the
// bike is parked. `dtc_list_count` sits next to `dtc_count` so a ride, or a real
// fault, will show which.
//
// ⚠️ Because the list is always empty, what those 20 bits MEAN is UNTESTED — no
// non-zero field has ever arrived. It is documented nowhere we have. Two readings
// fit the type-approval table, and this decoder resolves both and reports which
// one matched rather than picking one blind (see DiagnosticCode.matchedBy):
//   • low 16 bits = the table's "COD." component number, top nibble = SYMPTOM.
//     This matches the table's own primary key exactly, symptom values run 0-15
//     which is precisely one nibble, and it is the VCU's native identity.
//   • low 16 bits = a binary OBD-II DTC, i.e. what a scan tool would print.
// The first non-empty list settles it; `raw` is carried through either way so
// nothing is lost if both readings miss. Keep the two-reading design until then.

const DIAGNOSTICS_MESSAGE_TYPE = 25;
// The hub answers `04 11 25 FF` with TWO messages, ~10 ms apart: a type 31 that
// no version of the app knows about, then the type-25 list. Verified live
// 2026-08-02 on both transports — type 31 appears only in reply to this request
// (it is absent from the 90 s baseline capture) and always immediately before
// the list, twice in a row 60 s apart, payload `1F FF 01 03 01 02 04 00` both
// times. What its six bytes mean is unknown, so it is logged, not decoded.
const DIAGNOSTICS_INFO_MESSAGE_TYPE = 31;
const SUB_INDEX_FIRST_PAGE = 0x00;
const SUB_INDEX_LAST_PAGE = 0xfe;
const SUB_INDEX_WHOLE_LIST = 0xff;

// A stuck hub that never sends a last page must not grow the list without bound.
// 38 codes (what PID 0x01 reports on this bike) is 19 pages, so this is ~5x the
// largest list we have any reason to expect.
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
 * Stateful because the list is paged: each message carries at most two codes, so
 * a list the size of the 38 PID 0x01 reports would arrive spread over ~19 of
 * them. `push` returns null while the list is still coming in and the finished
 * report on the last page.
 *
 * Paging has never actually been observed — every reply so far has been a single
 * `0xFF` frame carrying no codes (see the note at the top of this file). All of
 * the below is therefore inferred, not confirmed.
 *
 * Deliberately tolerant about paging. The sub-index convention is inferred from
 * the hub's other multi-part messages (odometer, GPS and vehicle status all end
 * their sequence with 0xFE and use 0xFF when the whole message fits in one
 * frame), not documented — so any sub-index is accepted as a continuation page
 * and only 0xFE/0xFF end the list.
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
