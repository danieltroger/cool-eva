import { identifierForIndex } from "./param-codec.ts";
import { CALIBRATION_BANK, type ParameterStorageType, type VcuMicro } from "./param-table.ts";

// The 25 bank-1 parameters A8 serves that `params.ecf` does not describe — indices 278,
// 279, 613-627 and 1000-1007 (#219). Pure data plus a lookup; nothing here touches a bus.
//
// ⚠️ These are NOT a parameter table and must never be merged into one. `params.ecf` and
// the 29 tables built from it are fingerprinted against Energica's own bundles, so a row
// added there fails its fingerprint at module load; and `./write-targets.ts` generates a
// write target for every row the active table carries, so a row added there is a new
// WRITE TARGET — including the odometer master. Same bargain ./service-actions.ts already
// struck for ids 1000-1003: named here, with their provenance, rather than smuggled into a
// table that claims a different source.
//
// ⚠️ WIDTH ONLY, AND THE WIDTH IS A CLAIM. The storage type comes from A8's own firmware
// parameter table, and nothing has confirmed that the A8 in this bike runs that build. The
// TYPE column of `params.ecf`, by contrast, was checked against 233 live records with zero
// mismatches. That difference is why a sweep parks the OBD poller for these rows and not
// for the other 277, and why no row here carries a sign: the firmware entry types the
// width and says nothing about signedness, so there is no honest typed value to show.
//
// Provenance row by row — the firmware table's address and entry shape, the EEPROM offsets
// and RAM shadows, what is live-confirmed and what is not: docs/vcu-parameters.md §2.

/**
 * The firmware-table row for an identifier, or null.
 *
 * ⚠️ Keyed on the MICRO and the BANK as well as the index, and both matter. A8 bank 1
 * index 1000 is the service date's low word; A9 bank 1 index 1000 and A8 **bank 2** index
 * 1000 are neither, and ./probe.ts can name any target and any bank from a phone. A
 * registry keyed on the index alone would attach this provenance to a live-data reading.
 */
export function firmwareRowFor(micro: VcuMicro, bank: number, index: number): A8FirmwareRow | null {
  if (micro !== FIRMWARE_TABLE_MICRO || bank !== CALIBRATION_BANK) {
    return null;
  }
  return ROWS_BY_INDEX.get(index) ?? null;
}

/** Every row, ascending by index. */
export function a8FirmwareRows(): readonly A8FirmwareRow[] {
  return ROWS;
}

/**
 * One row as a sentence, for a journal line, a probe's `note` or a snapshot row.
 *
 * Says what is known and stops. "Nothing traced" is written out rather than left as an
 * absence: a row that reads 0 with no sentence next to it looks like a parameter nobody
 * has got round to naming, when in fact somebody looked and there was nothing there.
 */
export function describeFirmwareRow(row: A8FirmwareRow): string {
  const known = row.known ?? "nothing traced beyond the row and its width";
  return `not in params.ecf — A8's own firmware table types index ${row.index} ${row.type}; ${known} (docs/vcu-parameters.md §2)`;
}

/** One row of A8's firmware parameter table that `params.ecf` does not describe. */
export interface A8FirmwareRow {
  index: number;
  /** `0x1000 | index`. Every row here is bank 1, which is what makes the bank check above a constant. */
  identifier: number;
  micro: typeof FIRMWARE_TABLE_MICRO;
  /** The storage type at +0x04 of the firmware table entry. A claim, not a measurement — see the header. */
  type: ParameterStorageType;
  /** Names this table in any message about a width, so a mismatch says which claim it contradicts. */
  describedBy: typeof FIRMWARE_TABLE_NAME;
  /**
   * ⚠️ Always null, and that is the finding rather than a gap. The firmware entry types
   * the WIDTH; nothing in it says whether the record is two's complement. `interpretRecord`
   * withholds the typed value on exactly this, so a row here reports raw bytes and an
   * unsigned reading and never a number that implies a sign nobody has established.
   */
  signed: null;
  /** What is known beyond the row's existence and its width, or null when that is all there is. */
  known: string | null;
}

/** How a message names this width's source, next to `NAME_TABLE` in ./param-codec.ts. */
const FIRMWARE_TABLE_NAME = "A8's firmware table";

/**
 * The micro whose firmware table this is. A9 serves none of these.
 *
 * Annotated with the literal rather than `VcuMicro`, so a row's `micro` is "A8" and not
 * "A8" | "A9" — and the comparison in firmwareRowFor() is what keeps it a real micro:
 * TypeScript rejects `micro !== FIRMWARE_TABLE_MICRO` outright if the two cannot overlap.
 */
const FIRMWARE_TABLE_MICRO: "A8" = "A8";

/**
 * ⚠️ What each row is allowed to say. A `known` sentence records something somebody
 * traced — a use in the firmware, a read or a write captured on the wire — and never a
 * purpose inferred from a neighbour, a name or a plausible-looking value. Eighteen of the
 * 25 say nothing, which is the honest state of them.
 */
const FIRMWARE_TABLE: readonly { index: number; type: ParameterStorageType; known: string | null }[] = [
  {
    index: 278,
    type: "DWORD",
    known:
      "one of the two odometer-master cells the manufacturer's service tool writes in its odometer-change " +
      "action, as a 32-bit value followed by an ECU reset — which half is which is NOT established. Answered a " +
      "7-byte reply on 2026-09-14, consistent with the 4-byte record. This project reads them and never writes them",
  },
  {
    index: 279,
    type: "DWORD",
    known: "the other odometer-master cell — see 278, and never written from here either. Nothing has ever read it",
  },
  { index: 613, type: "WORD", known: null },
  { index: 614, type: "WORD", known: null },
  { index: 615, type: "WORD", known: null },
  { index: 616, type: "WORD", known: null },
  { index: 617, type: "WORD", known: null },
  { index: 618, type: "WORD", known: null },
  { index: 619, type: "WORD", known: null },
  { index: 620, type: "WORD", known: null },
  { index: 621, type: "WORD", known: null },
  {
    index: 622,
    type: "WORD",
    known:
      "used as a scale factor at A8 0x10EB4 — `(sensor × PARAM_622) >> 12`, the product range-checked against " +
      "parameters 223 and 224 (600…2500). The only use traced anywhere in 613-627, and it is a use rather than a meaning",
  },
  { index: 623, type: "WORD", known: null },
  { index: 624, type: "WORD", known: null },
  { index: 625, type: "WORD", known: null },
  { index: 626, type: "DWORD", known: null },
  {
    index: 627,
    type: "BYTE",
    known: "the only BYTE in the block, so a 4-byte REPLY — three of framing plus one of record — confirms the width",
  },
  { index: 1000, type: "WORD", known: serviceStampKnown("the last-service date's low word") },
  { index: 1001, type: "WORD", known: serviceStampKnown("the last-service date's high word") },
  { index: 1002, type: "WORD", known: serviceStampKnown("the last-service odometer's low word") },
  { index: 1003, type: "WORD", known: serviceStampKnown("the last-service odometer's high word") },
  { index: 1004, type: "WORD", known: null },
  { index: 1005, type: "WORD", known: null },
  {
    index: 1006,
    type: "WORD",
    known:
      "one of the only two identifiers the manufacturer's service tool was ever captured WRITING (2026-08-08): it " +
      "read this one back as 0x9380 and wrote the same value, which reads more like a handshake than a tuning " +
      "change. Read-only from here",
  },
  {
    index: 1007,
    type: "WORD",
    known: "the other one the service tool wrote, 0x29C2, in the same 2026-08-08 capture. Read-only from here",
  },
];

/**
 * ⚠️ Said the same way on all four, because the four are one 32-bit pair of pairs and a
 * row that described only its own half would invite reading it on its own:
 * `value = (high << 16) | low`, the date a count of seconds since 2000-01-01 UTC.
 * ./service-actions.ts owns the decode and `SERVICE_STAMP_IDENTIFIERS` owns the addresses;
 * scripts/check-a8-block.ts asserts the two agree.
 */
function serviceStampKnown(half: string): string {
  return (
    `${half} of the last-service stamp — value = (high << 16) | low, the date a count of seconds since ` +
    "2000-01-01 UTC, decompiled from the manufacturer's service tool and live-confirmed on 2026-09-08 " +
    "(all four answered two bytes, all zero). Written only by the service-point routine, never by a parameter write"
  );
}

/**
 * ⚠️ Plain consts rather than lazy builders: 25 rows is not worth two mutable module
 * globals and a `??=` each. Function declarations hoist, so the main function still reads
 * first, and nothing calls it at import time. `identifierForIndex` rather than a shift —
 * it range-checks the 12 bits instead of truncating into them.
 */
const ROWS: readonly A8FirmwareRow[] = FIRMWARE_TABLE.map(entry => ({
  index: entry.index,
  identifier: identifierForIndex(entry.index),
  micro: FIRMWARE_TABLE_MICRO,
  type: entry.type,
  describedBy: FIRMWARE_TABLE_NAME,
  signed: null,
  known: entry.known,
}));

/** Ascending because FIRMWARE_TABLE is written ascending — scripts/check-a8-block.ts asserts exactly that. */
const ROWS_BY_INDEX: ReadonlyMap<number, A8FirmwareRow> = new Map(ROWS.map(row => [row.index, row]));
