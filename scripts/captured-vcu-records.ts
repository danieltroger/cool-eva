import type { VcuMicro } from "../src/vcu/param-table.ts";

// Real material read off this bike's VCU micros, checked in so the codec can be
// exercised on a laptop — the bike is reachable for a few minutes at a time in a
// garage with no reception, and `socketcan` does not build on macOS anyway. Same
// role as scripts/captured-dtc-transfer.ts, and scripts/check-vcu-params.ts is the
// thing that replays it.
//
// ⚠️ Two DIFFERENT kinds of evidence live here and they are kept apart on purpose.
//
//   CAPTURED_FRAMES  — whole CAN frames, quoted byte for byte from
//                      obd-garage/DIAG_ADDRESSES.md §3, where they were written
//                      down as they came off the bus on 2026-08-08. These are the
//                      only things that prove the FRAMING.
//
//   LIVE_BANK1_READS — parameter values read live on 2026-08-08 (§4 and §5). The
//                      notes recorded the identifier, the record bytes and the
//                      decoded value, but NOT the enclosing frame — so the frame
//                      is reconstructed around them in the check script. They
//                      prove the name table, the routing and the interpretation;
//                      they do not independently prove the framing, and are not
//                      presented as if they did.

/** Whole frames, exactly as obd-garage/DIAG_ADDRESSES.md §3 recorded them on 2026-08-08. */
export const CAPTURED_FRAMES = {
  /** A9 answering `02 10 81` StartDiagnosticSession. */
  sessionOpened: "F1 02 50 81",
  /** A9 answering `22 2001` — a bank-2 (live data) read, single frame. */
  bank2SingleFrame: "F1 05 62 20 01 01 23",
  /** A8 answering the same read: a First Frame declaring 7 bytes. Nothing here assembles it. */
  bank2FirstFrame: "F1 10 07 62 20 01 00 09",
  /** Either micro refusing bank 0: NRC 0x12 subFunctionNotSupported, NOT 0x33. */
  bank0Refused: "F1 03 7F 22 12",
} as const;

/** One parameter read live off the bike on 2026-08-08. */
export interface LiveBank1Read {
  micro: VcuMicro;
  index: number;
  /** The name the read was made under, so a table edit that renames it fails here. */
  name: string;
  /** The record bytes as the notes quote them. */
  rawHex: string;
  /** The value those bytes were reported as. */
  value: number;
}

/**
 * Every bank-1 parameter with a live value written down in
 * obd-garage/DIAG_ADDRESSES.md §4 and §5. Both micros, which matters: the A8 half
 * of the table had never been checked against anything before that session, since
 * obd-garage/kwp_scan_raw.txt contains A9 records only.
 */
export const LIVE_BANK1_READS: LiveBank1Read[] = [
  // §4, control reads
  { micro: "A9", index: 6, name: "CHARGE_RESTART_HOLDOFF", rawHex: "14", value: 20 },
  { micro: "A9", index: 8, name: "DC_DC_OVER_CURRENT", rawHex: "9C 40", value: 40000 },
  { micro: "A9", index: 18, name: "INNACTIVITY_TIMEOUT", rawHex: "0E 10", value: 3600 },
  { micro: "A9", index: 31, name: "FAN_MAX_CURR_TH", rawHex: "0C E4", value: 3300 },
  { micro: "A8", index: 223, name: "HORN_MIN_CURRENT_TH", rawHex: "02 58", value: 600 },
  { micro: "A8", index: 224, name: "HORN_MAX_CURRENT_TH", rawHex: "0D AC", value: 3500 },
  { micro: "A8", index: 253, name: "SPEED_ODO_FRONTWHEEL_C", rawHex: "07 3C", value: 1852 },
  { micro: "A8", index: 254, name: "SPEED_ODO_REARWHEEL_C", rawHex: "07 BF", value: 1983 },
  // §4, the [WATER_PUMP] block
  { micro: "A8", index: 227, name: "WATER_PUMP_ON_TH", rawHex: "23", value: 35 },
  { micro: "A8", index: 228, name: "WATER_PUMP_OVERTEMP_TH", rawHex: "50", value: 80 },
  { micro: "A8", index: 229, name: "WATER_PUMP_OFF_TH", rawHex: "1E", value: 30 },
  { micro: "A8", index: 230, name: "WATER_PUMP_MAX_CURR_TH", rawHex: "09 C4", value: 2500 },
  { micro: "A8", index: 231, name: "WATER_PUMP_MIN_CURR_TH", rawHex: "01 90", value: 400 },
  { micro: "A8", index: 232, name: "WATER_PUMP_INITIAL_TEST", rawHex: "01", value: 1 },
  // §5, the whole [EVSE] block
  { micro: "A9", index: 257, name: "MAX_AC_CHG_CURRENT", rawHex: "0F", value: 15 },
  { micro: "A9", index: 258, name: "MAX_DC_CHG_CURRENT", rawHex: "4B", value: 75 },
  { micro: "A9", index: 259, name: "FCHG_CURRENT_GAIN", rawHex: "00 E1", value: 225 },
  { micro: "A9", index: 260, name: "EE_EVSE_DUMMY_1", rawHex: "00 00", value: 0 },
  { micro: "A9", index: 261, name: "MAX_C_TEMP", rawHex: "69", value: 105 },
  { micro: "A9", index: 262, name: "EE_EVSE_DUMMY_2", rawHex: "00 00", value: 0 },
  { micro: "A9", index: 263, name: "EE_EVSE_DUMMY_3", rawHex: "00 00", value: 0 },
  { micro: "A9", index: 264, name: "CHARGER_TYPE", rawHex: "00 01", value: 1 },
  { micro: "A9", index: 265, name: "EVSE_DUMMY_WORD4", rawHex: "00 00", value: 0 },
  // ⚠️ Not from 2026-08-08 and not from DIAG_ADDRESSES.md — this one is line 233 of
  // obd-garage/kwp_scan_raw.txt, the full A9 dump taken 2026-06-14:
  //
  //     A9 B1 0114 2 4017
  //
  // It is here because it is the single most load-bearing value on this list. It is
  // the bike naming its own parameter table — 0x4017 = 16407 — and it is the whole
  // evidence that src/vcu/param-table.ts describes THIS motorcycle rather than the
  // one params.ecf came from, which reports 16406. That dump is local-only, so
  // without this row the claim would leave the repo with it. See PARAM_TABLES.md in
  // the same folder for the 28-table comparison behind it.
  { micro: "A9", index: 276, name: "TABLE_TYPE_uC", rawHex: "40 17", value: 16407 },
];

/**
 * Values that differ from the variant file — this bike's, and the reason the file's
 * column may never be shown as a reading. `MAX_DC_CHG_CURRENT` is the headline: 75 A
 * here against the file's 60, corroborated by the 75 A the bike advertises on
 * 0x120/0x121 (obd-garage/DIAG_ADDRESSES.md §5).
 */
export const KNOWN_VARIANT_DIFFERENCES: { index: number; name: string; thisBike: number; otherBike: number }[] = [
  { index: 258, name: "MAX_DC_CHG_CURRENT", thisBike: 75, otherBike: 60 },
  { index: 264, name: "CHARGER_TYPE", thisBike: 1, otherBike: 0 },
  // The difference that turned out to matter. Not a variant tuning like the two
  // above: it is the two bikes running different REVISIONS of Energica's parameter
  // table, which is why 249 is called R_BRAKE_POPUP here and LM_TYPE in the file.
  { index: 276, name: "TABLE_TYPE_uC", thisBike: 16407, otherBike: 16406 },
];

/**
 * Real SecurityAccess seed/key pairs, off THIS bike's A8, on 2026-08-08.
 *
 * ⚠️ The most valuable four rows in this file. They come from a passive candump taken
 * while ENERGICA'S OWN diagnostic software was connected (obd-garage/DIAG_ADDRESSES.md
 * §9.3) — nothing was transmitted to obtain them — and they are the only live ground
 * truth anywhere in the write path. Everything else about writing is decompiled,
 * inferred, or reasoned about.
 *
 * They matter beyond confirming the arithmetic. A wrong key costs one of about three
 * attempts, and the lockout clears only on a VCU power cycle — so an untested key
 * function is not merely unverified, it is a way to lock the micro from a phone in a
 * garage. Both on the wire, big-endian.
 */
export const CAPTURED_SECURITY_PAIRS: [seed: string, key: string][] = [
  ["A57D5F18", "1C5F69E2"],
  ["874C790E", "0D2D70CB"],
  ["98F4A11B", "26990CE5"],
  ["EF2BA23F", "A0B80BFD"],
];

/**
 * Two RTC-sync frames that really went out on CAN 0x120, on 2026-08-16.
 *
 * From another Energica owner's tool, whose own log recorded the bytes and the local
 * time; the ISO instants here are those times converted to UTC (that machine runs at
 * UTC+9:30). 2026-08-16 was a Sunday, which is what makes the weekday nibble check
 * meaningful — .NET's `DayOfWeek` puts Sunday at 0, and so does JavaScript's
 * `getUTCDay()`.
 *
 * They are the end-to-end evidence for the bit packing in src/vcu/service-actions.ts,
 * which is otherwise only a reading of a decompiled method.
 */
export const CAPTURED_RTC_FRAMES: [hex: string, iso: string][] = [
  ["94 FF 04 02 20 10 1A 00", "2026-08-16T04:16:00Z"],
  ["94 FF 66 E8 20 10 1A 00", "2026-08-16T06:03:29Z"],
];

/** "01 90" or "0190" → bytes. Throws on anything that is not whole hex bytes. */
export function parseHexBytes(text: string): Uint8Array {
  const compact = text.replace(/\s+/g, "");
  if (compact.length === 0 || compact.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(compact)) {
    throw new Error(`not a whole number of hex bytes: "${text}"`);
  }
  const bytes = new Uint8Array(compact.length / 2);
  for (let position = 0; position < bytes.length; position++) {
    bytes[position] = Number.parseInt(compact.slice(position * 2, position * 2 + 2), 16);
  }
  return bytes;
}
