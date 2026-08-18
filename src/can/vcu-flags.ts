// The VCU's error and status bitfield, CAN 0x100 `VCU_VEHICLE_FLAGS` at 10 Hz.
//
// Energica's `FramesDB.ParseVCU_VEHICLE_FLAGS` names all 64 bits of it — byte 0 bit 0
// through byte 7 bit 7, one named flag each, no multi-byte fields at all
// (the 2024 service-tool analysis in obd-garage/, §`0x100` `VCU_VEHICLE_FLAGS`). That
// makes it the VCU's counterpart to the BMS's own error/warning words on 0x201, and it
// is handled the same way this repo already handles those: log the raw words so no flag
// can ever be lost, then break out only the ones worth an alert.
//
// The reason it is worth having at all is `ERR_ChargeCM_Out`, byte 7 bit 1. The charge
// manager has never been read on this bike — its own `CM_ERROR` / `CM_ERROR_SOURCE` /
// `CM_ERROR_CODE_*` telemetry is not broadcast anywhere and needs a diagnostic session
// with an ECU that was only recently located. This summary bit IS broadcast, so a
// charge-manager fault becomes visible passively, which matters directly to the open
// question of why DC fast charging caps below the bike's advertised 75 A.

import { type DecodedValue, bit } from "./frame.ts";

export const VCU_FLAGS_CAN_ID = 0x100;

/** Decodes one 0x100 frame. Pure: bytes in, values out. */
export function decodeVcuFlagsFrame(data: Buffer): DecodedValue[] {
  if (data.length < 8) return [];
  return [
    // The raw halves, so a flag this file does not break out below is still recorded and
    // a future reader can go back through the log for it. Two 32-bit words rather than one
    // 64-bit number because JavaScript's bitwise operators truncate to 32 bits, so a single
    // value would be unusable for exactly the thing it exists for. Little-endian within each
    // half, which makes bit N of the word byte N>>3, bit N&7 — the same convention every
    // other multi-byte field on this bus uses. Nothing reads meaning out of the words
    // themselves; they are a lossless record, not a measurement.
    { key: "vcu_flags_low", value: data.readUInt32LE(0) },
    { key: "vcu_flags_high", value: data.readUInt32LE(4) },

    // The requested one, and the reason this frame is decoded at all.
    { key: "vcu_err_charge_manager", value: bit(data[7], 1) },

    // The three bits that were ever seen to MOVE across every capture on disk. These are
    // the ones the corpus actually corroborates — see the evidence at the bottom.
    { key: "vcu_err_check_modules", value: bit(data[2], 7) },
    { key: "vcu_check_modules_status", value: bit(data[4], 3) },
    { key: "vcu_warn_soc_misaligned", value: bit(data[6], 4) },

    // Constant 1 everywhere, and worth logging for that: it is the VCU's own verdict on the
    // 12 V supply, and 0x501 in this same change reports that rail's actual millivolts. Two
    // independent readings of one thing, which is the arrangement that catches a wrong one.
    { key: "vcu_12v_power_good", value: bit(data[7], 0) },

    // 🟡 The rest: the flags worth an alert on a bike whose whole point is pack thermal
    // headroom, plus the three top-level rollups. Every one of them reads 0 in every frame of
    // every capture on disk, so their bit positions are Energica's word and nothing more — see
    // the caveat below. They are here because a flag that only matters when it fires is worth
    // having decoded BEFORE it fires, and because the raw words above mean a wrong position
    // costs a re-read of the log rather than a lost event.
    { key: "vcu_err_system_fault", value: bit(data[0], 0) },
    { key: "vcu_err_battery_ot", value: bit(data[3], 4) },
    { key: "vcu_err_motor_ot", value: bit(data[3], 5) },
    { key: "vcu_err_system_fatal_fault", value: bit(data[3], 6) },
    { key: "vcu_err_system_blocking_fault", value: bit(data[3], 7) },
    { key: "vcu_err_drive_ot", value: bit(data[4], 1) },
    { key: "vcu_err_leak_detect", value: bit(data[6], 0) },
  ];
}

// ## What the captures on disk say, checked 2026-08-16
//
// 0x100 was scanned across every raw capture there is: the 2026-08-02 garage lap (4087
// frames), the 2026-08-02 AC charge (18 509), and all 59 files of the 2026-08-04 session
// including the complete CCS DC fast charge (83 140). **105 736 frames, four distinct
// payloads.**
//
//     00 00 80 00 00 00 00 01   riding, and most of the 08-04 session
//     00 00 00 00 00 00 00 01   the whole AC charge, and the later 08-04 files
//     00 00 80 00 00 00 10 01   from 20:25:49 on 08-04 onward
//     00 00 00 00 08 00 00 01   two short bursts, 39 frames total
//
// ✅ **Byte 7 bit 1, `ERR_ChargeCM_Out`, is 0 in all 105 736 of them** — including every
// frame of the 2026-08-04 DC session, which ran to 20.04 kW and 66.2 A and completed
// cleanly. So the bit is well-formed and the charge manager was not complaining. ⚠️ That is
// a NEGATIVE and nothing more: no capture on this disk contains a charge-manager fault. The
// only time this bike's charge manager has ever complained is 2026-08-09 12:38:35-12:42:35,
// and no raw CAN for that window exists locally. **This decode has never been seen to fire.**
//
// 🔎 For whoever recovers those 2026-08-09 captures — this is the check that would confirm
// it outright in one pass. The bit should go **1 → 0 → 1 → 0 at 12:38:35 / 12:39:36 /
// 12:41:36 / 12:42:35**, i.e. byte 7 stepping 0x03 → 0x01 → 0x03 → 0x01 against a payload
// that is otherwise `00 00 ?? 00 00 00 ?? 01`. Four edges at four known seconds is not
// something a wrong bit position produces.
//
// ✅ What the corpus DOES confirm is that this frame is the named bitfield it claims to be,
// because three of its bits move and every one of them moves when the vendor's name says it
// should:
//
//  1. **`ERR_CheckModules` (b2 bit7)** is set through both rides and clear through the whole
//     AC charge. It matches the mode-03 stored list exactly — `B1000` position lights,
//     `B1002` stop, `B1004`/`B1006` indicators, `B1009` low beam, `B1012` high beam, all
//     open-circuit body modules — and it is the rolled-up version of the per-module round
//     robin on 0x105.
//  2. **`CheckModulesSts` (b4 bit3)** sets at **20:16:05.508 on 2026-08-04 and clears 2.5 s
//     later**. The DC session's unplug is at 20:16:05, established from an entirely different
//     frame. A bit transition landing on the second of a known event is the strongest single
//     piece of evidence here: it is the VCU re-running its module check as the session tears
//     down, and a wrong bit position does not coincide with anything.
//  3. **`WARN_SocMisaligned` (b6 bit4)** first appears at 20:25:49, nine minutes after that
//     same DC session ended at 57 % SOC — which is exactly when a coulomb-counted SOC estimate
//     gets flagged after a partial fast charge. 🟡 Suggestive rather than proof.
//
// ⚠️ The other 57 bits, including all eleven broken out above beyond those three and
// `V_PGood12V`, read 0 in every frame of every capture. Their positions come from Energica's
// database and nothing on this bike has ever exercised them. Treat any of them reading 1 as
// a lead to check against `0x201`, the mode-03 list and the bike's own dash — not as a
// confirmed fault. That is also why both raw words are logged: if a position turns out to be
// wrong, the log still holds the byte it came from.
