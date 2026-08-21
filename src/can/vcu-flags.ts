// The VCU's error and status bitfield, CAN 0x100 `VCU_VEHICLE_FLAGS` at 10 Hz.
//
// Energica's `FramesDB.ParseVCU_VEHICLE_FLAGS` names all 64 bits of it — byte 0 bit 0
// through byte 7 bit 7, one named flag each, no multi-byte fields at all
// (the 2024 service-tool analysis in obd-garage/, §`0x100` `VCU_VEHICLE_FLAGS`). That
// makes it the VCU's counterpart to the BMS's own error/warning words on 0x201, and it
// is handled the same way this repo already handles those: log the raw words so no flag
// can ever be lost, then break out only the ones worth an alert.
//
// The reason it is worth having at all is `ERR_ChargeCM_Out`, byte 7 bit 1 — a rollup of
// charge-manager faults, which matters directly to the open question of why DC fast
// charging caps below the bike's advertised 75 A.
//
// ⚠️ This block used to say the charge manager's own `CM_ERROR_SOURCE` / `CM_ERROR_CODE`
// "is not broadcast anywhere and needs a diagnostic session". That was wrong: it is on
// 0x610 b1 and b2-3 at 10 Hz, decoded since 2026-08-20 (src/can/charge-manager.ts). The
// two are worth keeping side by side rather than one replacing the other. ⚠️ This used to
// say the bit "stayed 0" through all three fault episodes; it does not, and the reason to
// keep both is the opposite of what was written. The bit rises 0.162 s after 0x610
// publishes a code in three episodes — and in a FOURTH it is set for 269.7 s with 0x610
// b1-3 at zero throughout. So neither is a summary of the other, and a charge-fault check
// that watches only one misses that fourth event entirely.

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

// ✅ Scanned over 105 736 frames (every raw capture on disk, checked 2026-08-16): the frame
// really is the named bitfield it claims to be. Three of its bits MOVE, and each moves when
// the vendor's name says it should — `ERR_CheckModules` matches the mode-03 stored list of
// open-circuit body modules exactly, `CheckModulesSts` sets on the second of the DC session's
// unplug (established from an entirely different frame), and `WARN_SocMisaligned` appears
// nine minutes after a partial fast charge ended at 57 % SOC.
//
// ✅ `ERR_ChargeCM_Out` HAS fired — this paragraph said the opposite until 2026-08-20, on the
// strength of a 105 736-frame sample. Archive-wide it is set in 3 563 frames, in four windows,
// and in three of them it rises exactly 0.162 s after 0x610 publishes a charge-manager error
// code. The fourth has no code, so this bit and 0x610 b1-3 are not equivalent and a charge-fault
// check needs both. Evidence: docs/charge-manager.md § "The fault corpus".

// ⚠️ The other 57 bits, including all eleven broken out above beyond those three and
// `V_PGood12V`, read 0 in every frame of every capture. Their positions are Energica's word
// and nothing on this bike has ever exercised them. Treat any of them reading 1 as a lead to
// check against 0x201, the mode-03 list and the bike's own dash — not as a confirmed fault.
// That is also why both raw words are logged: a wrong position still leaves the byte in the log.
//
// Payload census and the per-bit evidence: docs/can-decode-findings.md § "0x100".
