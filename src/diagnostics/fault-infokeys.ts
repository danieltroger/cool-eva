import { lookupInfokey, infokeyWidth, type InfokeyField } from "./infokey-table.ts";

// Energica's own answer to "what do you need to see to diagnose THIS fault" — one
// ordered shortlist of ./infokey-table.ts ids per fault. Data only. 155 faults, 944
// references, every one resolving into 1…120 with none dangling. Extracted from the
// manufacturer's service-tool data; provenance, and why the two tool builds are ONE
// source rather than two: docs/diagnostics-and-checks.md §5.3.
//
// ── ⚠️ THE ORDER IS THE WIRE LAYOUT, NOT A DISPLAY PREFERENCE ───────────────
// A freeze-frame payload is these fields concatenated in exactly this order, each
// occupying its datatype's width. Sorting a list, de-duplicating it, or filtering
// out a field whose name means nothing to us would silently shift every field
// after it and decode the rest of the frame as garbage that still looks like
// numbers. Treat each array as a struct definition. ./freeze-frame.ts is the only
// thing that walks them.
//
// ── ⚠️ KEYED (component, symptom), WHICH IS NOT THE MODE-03 ENCODING ────────
// The same trap ./obd-dtc.ts' header warns about, from the other side: this key is
// Energica's own (COD., SYMPTOM) pair, NOT the 16-bit binary DTC mode 03 returns,
// and the two are not convertible by arithmetic. Reaching this table from a mode-03
// code means going through ./dtc-table.ts' OBD column, which is what
// `infokeysForObdCode` does — and why it can return more than one answer.
//
// ── ⚠️ `serviceToolObdCode` IS A CROSS-CHECK, NOT AN AUTHORITY ──────────────
// Where it disagrees with ./dtc-table.ts, THE DTC TABLE WINS: that table is
// reconciled against the type-approval PDF and this bike's own mode-03 reply, and
// this one is a single vendor build. Exactly two disagreements today, both the
// water pump, and scripts/check-freeze-frame.ts asserts the set is still those two.
//
// One fault, (60,0) `P1052`, has an EMPTY shortlist. That is Energica's data, not
// a gap in the extraction, and it decodes to a frame with no fields — a real
// answer, not an error.

/** One fault's shortlist. */
export interface FaultInfokeys {
  /** Energica's "COD." — the VCU's component number, 1…63. */
  component: number;
  /** Which fault of that component, 0…15. */
  symptom: number;
  /** What the service tool calls this pair. A cross-check only — see the header. */
  serviceToolObdCode: string;
  /**
   * The infokey ids, IN PAYLOAD ORDER. May be empty — see the note on (60,0).
   * Never sort this.
   */
  infokeys: readonly number[];
}

/** The shortlist for a (component, symptom) pair, or null when the service tool lists none. */
export function infokeysFor(component: number, symptom: number): FaultInfokeys | null {
  return BY_COMPONENT_SYMPTOM.get(key(component, symptom)) ?? null;
}

/**
 * Every shortlist the service tool files under an OBD code.
 *
 * A LIST, because the OBD column is not unique: `U0182` is both (39,3) and
 * (40,3), two different components with the same generic code. Returning one of
 * them would be a coin flip decided by insertion order, and the caller cannot
 * tell it happened. A caller that has the (component, symptom) pair — which the
 * hub's active list does — should use `infokeysFor` and never come here.
 */
export function infokeysForObdCode(obdCode: string): readonly FaultInfokeys[] {
  return BY_OBD_CODE.get(obdCode) ?? [];
}

/**
 * The fields a fault's freeze frame is made of, resolved and in payload order.
 *
 * Throws on an id the dictionary does not describe. That cannot happen for the
 * table below — all 944 references resolve, and the check asserts it — so it
 * means someone added a shortlist referencing a field that does not exist, and
 * skipping it would misalign every field after it. Loud beats plausible.
 */
export function infokeyFieldsFor(shortlist: FaultInfokeys): readonly InfokeyField[] {
  return shortlist.infokeys.map(id => {
    const field = lookupInfokey(id);
    if (!field) {
      throw new Error(
        `fault ${shortlist.component}/${shortlist.symptom} names infokey ${id}, which is not one of the 120`
      );
    }
    return field;
  });
}

/** How many payload bytes this fault's fields occupy, excluding the header. */
export function freezeFrameFieldBytes(shortlist: FaultInfokeys): number {
  return infokeyFieldsFor(shortlist).reduce((total, field) => total + infokeyWidth(field.datatype), 0);
}

/** All 155 shortlists, in (component, symptom) order. */
export const FAULT_INFOKEYS: readonly FaultInfokeys[] = [
  shortlist(1, 0, "P0562", [1, 2, 3, 4, 5, 46, 6, 7]),
  shortlist(1, 1, "P0563", [1, 2, 3, 4, 5, 46, 6, 7]),
  shortlist(2, 0, "U0028", [1, 113, 114]),
  shortlist(2, 1, "U0031", [1, 113, 114]),
  shortlist(2, 2, "U0034", [1, 113, 114]),
  shortlist(3, 0, "P1000", [1, 2, 6, 7, 8, 9, 10, 11]),
  shortlist(3, 1, "P1001", [1, 2, 6, 7, 8, 9, 10, 11]),
  shortlist(4, 0, "P1002", [1, 2, 6, 7, 8, 9, 10, 11]),
  shortlist(4, 1, "P1003", [1, 2, 6, 7, 8, 9, 10, 11]),
  shortlist(4, 2, "P0514", [1, 2, 6, 7, 8, 9, 10, 11]),
  shortlist(4, 3, "P0516", [1, 2, 6, 7, 8, 9, 10, 11]),
  shortlist(4, 4, "P0517", [1, 2, 6, 7, 8, 9, 10, 11]),
  shortlist(4, 5, "U0115", [1, 2, 6, 7, 8, 9, 10, 11]),
  shortlist(5, 0, "U0111", [1, 2, 6, 7, 12, 13, 14, 11]),
  shortlist(6, 0, "U0112", [1, 2, 6, 7, 12, 13, 14, 11]),
  shortlist(7, 0, "P1004", [10, 9, 8, 6, 7, 15, 16, 17, 18, 11]),
  shortlist(7, 1, "P1005", [10, 9, 8, 6, 7, 15, 16, 17, 18, 11]),
  shortlist(7, 2, "P1006", [10, 9, 8, 6, 7, 15, 16, 17, 18, 11]),
  shortlist(7, 3, "P1064", [10, 9, 8, 6, 7, 15, 16, 17, 18, 11]),
  shortlist(8, 0, "P1007", [10, 9, 8, 6, 7, 15, 16, 17, 18]),
  shortlist(8, 1, "P1008", [10, 9, 8, 6, 7, 15, 16, 17, 18]),
  shortlist(8, 2, "P1009", [10, 9, 8, 6, 7, 15, 16, 17, 18]),
  shortlist(8, 3, "U0113", [10, 9, 8, 6, 7, 15, 16, 17, 18]),
  shortlist(8, 4, "U0114", [10, 9, 8, 6, 7, 15, 16, 17, 18]),
  shortlist(9, 0, "U0301", [19, 20, 21, 22]),
  shortlist(10, 0, "P1010", [1, 23, 24, 25, 11]),
  shortlist(10, 1, "P1011", [1, 23, 24, 25, 11]),
  shortlist(10, 2, "P1012", [1, 23, 24, 25, 11]),
  shortlist(10, 3, "P1013", [1, 23, 24, 25, 11]),
  shortlist(11, 0, "P1014", [1, 115, 116, 25, 11]),
  shortlist(11, 1, "P1015", [1, 115, 116, 25, 11]),
  shortlist(11, 2, "P1016", [1, 115, 116, 25, 11]),
  shortlist(11, 3, "P1017", [1, 115, 116, 25, 11]),
  shortlist(12, 0, "P1018", [1, 26, 27, 25, 11]),
  shortlist(12, 1, "P1019", [1, 26, 27, 25, 11]),
  shortlist(12, 2, "P1020", [1, 26, 27, 25, 11]),
  shortlist(12, 3, "P1021", [1, 26, 27, 25, 11]),
  shortlist(13, 0, "P1022", [1, 117, 27, 25]),
  shortlist(13, 1, "P1023", [1, 117, 27, 25]),
  shortlist(13, 2, "P1024", [1, 117, 27, 25]),
  shortlist(14, 0, "P1025", [1, 25, 6, 26, 23, 24, 27, 28]),
  shortlist(14, 1, "P1026", [1, 25, 6, 26, 23, 24, 27, 28]),
  shortlist(14, 2, "P1027", [1, 25, 6, 26, 23, 24, 27, 28]),
  shortlist(15, 0, "P0A08", [1, 5, 4, 3, 29, 30, 31, 11]),
  shortlist(16, 0, "P0A10", [1, 5, 4, 3, 29, 30, 31]),
  shortlist(16, 1, "P0A09", [1, 5, 4, 3, 29, 30, 31]),
  shortlist(17, 0, "P1028", [1, 5, 4, 3, 29, 30, 31]),
  shortlist(18, 0, "U0037", [1, 113, 114]),
  shortlist(18, 1, "U0040", [1, 113, 114]),
  shortlist(18, 2, "U0043", [1, 113, 114]),
  shortlist(19, 0, "P0117", [1, 2, 32, 33, 34, 11]),
  shortlist(19, 1, "P0118", [1, 2, 32, 33, 34, 11]),
  shortlist(19, 2, "P0298", [1, 2, 32, 33, 34, 11]),
  shortlist(20, 0, "P1049", [1, 2, 32, 33, 34, 11, 47]),
  shortlist(20, 1, "U0110", [1, 2, 32, 33, 34, 11, 47]),
  shortlist(20, 2, "P0A02", [1, 2, 32, 33, 34, 11, 47]),
  shortlist(20, 3, "P0A03", [1, 2, 32, 33, 34, 11, 47]),
  shortlist(20, 4, "P0335", [1, 2, 32, 33, 34, 11, 47]),
  shortlist(21, 0, "P1029", [1, 36]),
  shortlist(21, 1, "P0632", [1, 36]),
  shortlist(22, 0, "P1030", [10, 9, 8, 6, 7, 15, 16, 17, 18, 11]),
  shortlist(23, 0, "C1000", [1, 2, 6, 7, 12, 13, 14, 11]),
  shortlist(24, 0, "C1001", [1, 2, 6, 7, 12, 13, 14, 11]),
  shortlist(25, 0, "C1002", [1, 2, 6, 7, 12, 13, 14, 11]),
  shortlist(26, 0, "P2503", [1, 37, 38, 39, 40, 41, 42, 43, 44, 45]),
  shortlist(26, 1, "P2504", [1, 37, 38, 39, 40, 41, 42, 43, 44, 45]),
  shortlist(26, 2, "P1031", [1, 37, 38, 39, 40, 41, 42, 43, 44, 45]),
  shortlist(27, 0, "P1032", [1, 37, 38, 39, 40, 41, 42, 43, 44, 45]),
  shortlist(28, 0, "P1033", [1, 37, 38, 39, 40, 41, 42, 43, 44, 45]),
  shortlist(29, 0, "P1034", [1, 37, 38, 39, 40, 41, 42, 43, 44, 45]),
  shortlist(30, 0, "P1035", [1, 37, 38, 39, 40, 41, 42, 43, 44, 45]),
  shortlist(30, 1, "P1036", [1, 37, 38, 39, 40, 41, 42, 43, 44, 45]),
  shortlist(31, 0, "P1037", [1, 37, 38, 39, 40, 41, 42, 43, 44, 45]),
  shortlist(31, 1, "P1038", [1, 37, 38, 39, 40, 41, 42, 43, 44, 45]),
  shortlist(32, 0, "P1039", [1, 37, 38, 39, 40, 41, 42, 43, 44, 45]),
  shortlist(33, 0, "P1040", [1, 39, 40, 41, 42, 54, 56, 43, 44, 45]),
  shortlist(33, 1, "P1041", [1, 39, 40, 41, 42, 54, 56, 43, 44, 45]),
  shortlist(33, 2, "P1042", [1, 39, 40, 41, 42, 54, 56, 43, 44, 45]),
  shortlist(34, 0, "B1000", [1, 48, 55, 3, 31]),
  shortlist(34, 1, "B1001", [1, 48, 55, 3, 31]),
  shortlist(35, 0, "B1002", [1, 49, 55, 3, 31]),
  shortlist(35, 1, "B1003", [1, 49, 55, 3, 31]),
  // ⚠️ The one pair with NO row in ./dtc-table.ts. That table leaves B1021 out on
  // purpose — no source states its MIL or what Energica means by it — so this
  // shortlist is usable while the code itself is still unnamed there.
  shortlist(35, 2, "B1021", [1, 48, 55, 3, 31]),
  shortlist(36, 0, "B1004", [1, 50, 57, 3, 31]),
  shortlist(36, 1, "B1005", [1, 50, 57, 3, 31]),
  shortlist(37, 0, "B1006", [1, 51, 57, 3, 31]),
  shortlist(37, 1, "B1007", [1, 51, 57, 3, 31]),
  shortlist(38, 0, "B1008", [1, 3, 31]),
  shortlist(39, 0, "B1009", [1, 52, 55, 3, 31]),
  shortlist(39, 1, "B1010", [1, 52, 55, 3, 31]),
  shortlist(39, 2, "B1011", [1, 52, 55, 3, 31]),
  // U0182 twice, under two components — the reason infokeysForObdCode returns a list.
  shortlist(39, 3, "U0182", [1, 52, 55, 3, 31]),
  shortlist(40, 0, "B1012", [1, 52, 55, 3, 31]),
  shortlist(40, 1, "B1013", [1, 52, 55, 3, 31]),
  shortlist(40, 2, "B1014", [1, 52, 55, 3, 31]),
  shortlist(40, 3, "U0182", [1, 52, 55, 3, 31]),
  shortlist(41, 0, "P0120", [1, 2, 64, 65, 66, 67, 68, 69, 60]),
  shortlist(42, 0, "P0121", [1, 2, 64, 65, 66, 67, 68, 69, 60]),
  shortlist(43, 0, "B1015", [1, 53, 59, 3, 31]),
  shortlist(43, 1, "B1016", [1, 53, 59, 3, 31]),
  // ⚠️ (44,0) and (44,2): the service tool says P0A05 / P0A07 where ./dtc-table.ts says
  // P0A07 / P0A05. The DTC table wins — see this file's header. The SHORTLIST is
  // the same for all three symptoms anyway, so the disagreement changes nothing
  // about what a pump freeze frame contains: pump current, pump module status and
  // the three IGBT temperatures either way.
  shortlist(44, 0, "P0A05", [1, 47, 58, 61, 62, 63, 11]),
  shortlist(44, 1, "P0A06", [1, 47, 58, 61, 62, 63, 11]),
  shortlist(44, 2, "P0A07", [1, 47, 58, 61, 62, 63, 11]),
  shortlist(45, 0, "P1043", [1, 6, 39, 3]),
  shortlist(46, 0, "P1044", [10, 9, 8, 6, 7, 15, 16, 17, 18, 11]),
  shortlist(47, 0, "B1017", [1, 52, 55, 3, 29, 4, 31, 11]),
  shortlist(48, 0, "P1045", [1, 3, 29, 4, 31, 11]),
  shortlist(49, 0, "P1046", [1, 10, 17, 18, 77, 15, 16, 11]),
  shortlist(50, 0, "P1047", [1, 10, 17, 18, 77, 11]),
  // The longest shortlist: 12 fields, 20 bytes. That plus the 4-byte header is the
  // largest freeze frame this table can produce — see MAX_FREEZE_FRAME_PAYLOAD.
  shortlist(51, 0, "P1050", [1, 10, 78, 79, 77, 15, 16, 6, 7, 18, 17, 36]),
  shortlist(52, 0, "P1051", [80, 81, 82, 83, 84, 86]),
  shortlist(53, 0, "U1000", [87, 88]),
  shortlist(53, 1, "P1053", [87, 88]),
  shortlist(53, 2, "P0610", [87, 88]),
  shortlist(53, 3, "P1054", [87, 88]),
  shortlist(53, 4, "P0601", [87, 88]),
  shortlist(53, 5, "P1055", [87, 88]),
  shortlist(53, 6, "P1063", [87, 88]),
  shortlist(53, 7, "P1056", [87, 88]),
  shortlist(53, 8, "P0603", [87, 88]),
  shortlist(53, 9, "P1057", [87, 88]),
  shortlist(53, 10, "P1058", [87, 88]),
  shortlist(53, 11, "P2641", [87, 88]),
  shortlist(53, 12, "P1059", [87, 88]),
  shortlist(53, 13, "P1060", [87, 88]),
  shortlist(53, 14, "P1061", [87, 88]),
  shortlist(53, 15, "P1062", [87, 88]),
  shortlist(54, 0, "C1003", [1, 89, 118, 119, 120]),
  shortlist(54, 1, "C1004", [1, 89, 118, 119, 120]),
  shortlist(54, 2, "C1005", [1, 89, 118, 119, 120]),
  shortlist(54, 3, "C1006", [1, 89, 118, 119, 120]),
  shortlist(54, 4, "C1007", [1, 89, 118, 119, 120]),
  shortlist(54, 5, "C1008", [1, 89, 118, 119, 120]),
  shortlist(54, 6, "C1009", [1, 89, 118, 119, 120]),
  shortlist(54, 7, "C1010", [1, 89, 118, 119, 120]),
  shortlist(54, 8, "C1011", [1, 89, 118, 119, 120]),
  shortlist(54, 9, "C1012", [1, 89, 118, 119, 120]),
  shortlist(54, 10, "C1013", [1, 89, 118, 119, 120]),
  shortlist(54, 11, "C1014", [1, 89, 118, 119, 120]),
  shortlist(54, 12, "C1015", [1, 89, 118, 119, 120]),
  // Energica's own answer to a charge-current fault is CM_ERROR_SOURCE plus a
  // 16-bit CM_ERROR_CODE split MSB/LSB. ⚠️ The freeze-frame route is NOT the
  // shortcut it looks like: the one component-54 reply this bike actually sent
  // (54,11 in scripts/captured-freeze-frames.ts) carries the triple as 0, 0, 0.
  // docs/charge-manager.md § "The fault corpus".
  shortlist(54, 13, "C1018", [1, 89, 118, 119, 120]),
  shortlist(55, 0, "P2637", [1, 93, 94, 95]),
  shortlist(56, 0, "C1016", [1, 96, 97, 98, 99, 100, 101]),
  shortlist(56, 1, "C1017", [1, 96, 97, 98, 99, 100, 101]),
  shortlist(57, 0, "B1018", [102, 103, 104]),
  shortlist(58, 0, "P0605", [102, 103, 105]),
  shortlist(59, 0, "U0412", [1, 12, 17, 18, 15, 16, 8, 9]),
  // Empty in Energica's data. Decodes to a freeze frame with no fields.
  shortlist(60, 0, "P1052", []),
  shortlist(61, 0, "P0500", [1, 106, 107, 108, 109, 110, 111, 112, 3, 4]),
  shortlist(61, 1, "P2158", [1, 106, 107, 108, 109, 110, 111, 112, 3, 4]),
  shortlist(61, 2, "C0065", [1, 106, 107, 108, 109, 110, 111, 112, 3, 4]),
  shortlist(61, 3, "P2162", [1, 106, 107, 108, 109, 110, 111, 112, 3, 4]),
  shortlist(62, 0, "U0121", [1, 106, 3, 4]),
  shortlist(63, 0, "B1019", [1, 48, 55, 3, 31]),
  shortlist(63, 1, "B1020", [1, 48, 55, 3, 31]),
];

/**
 * The largest field payload any fault in the table can produce, in bytes.
 *
 * Derived from the table rather than written down: it is (51,0) `P1050`'s twelve
 * fields, and adding a longer shortlist moves it automatically.
 *
 * ⚠️ Its only reader is scripts/check-freeze-frame.ts, which asserts it is 20.
 * That is on purpose, and it is worth saying because the obvious guess is wrong:
 * ./extended-iso-tp.ts does NOT cap reassembly with this. It uses a deliberately
 * larger fixed cap, because a cap at the expected size would discard the one
 * reply that could show the layout in ./freeze-frame.ts is wrong. The check's
 * assertion is what ties the two together — grow the table past 20 bytes and the
 * build goes red, pointing at both this constant and that cap.
 */
export const MAX_FREEZE_FRAME_FIELD_BYTES: number = FAULT_INFOKEYS.reduce(
  (widest, entry) => Math.max(widest, freezeFrameFieldBytes(entry)),
  0
);

const BY_COMPONENT_SYMPTOM = new Map(FAULT_INFOKEYS.map(entry => [key(entry.component, entry.symptom), entry]));

const BY_OBD_CODE = FAULT_INFOKEYS.reduce((grouped, entry) => {
  const existing = grouped.get(entry.serviceToolObdCode);
  if (existing) {
    existing.push(entry);
  } else {
    grouped.set(entry.serviceToolObdCode, [entry]);
  }
  return grouped;
}, new Map<string, FaultInfokeys[]>());

function key(component: number, symptom: number): number {
  return component * 16 + symptom;
}

function shortlist(
  component: number,
  symptom: number,
  serviceToolObdCode: string,
  infokeys: readonly number[]
): FaultInfokeys {
  return { component, symptom, serviceToolObdCode, infokeys };
}
