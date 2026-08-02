// Pure per-frame decoders for the LiBAL s-BMS's own TX frames.
//
// These layouts are NOT reverse-engineered. They were read out of the bike's
// decrypted BMS configuration file (`stockconfig_eva_ribelle_2021.bms`) cross-
// referenced with the memory map and flag tables in the LiBAL Application
// Engineering Manual. Where that disagreed with the notes taken off the wire, the
// config wins — see the "Corrections" section of obd-garage/CAN_MAP.md.
//
// Everything the BMS sends is big-endian except 0x207 and 0x300, which the config
// marks little-endian. 0x660-0x665 only exist once the extended config is flashed;
// until then they simply never arrive.

import { type DecodedValue, bit, i16be, signedByte, u16be, u16le } from "./frame.ts";

export function decodeBmsFrame(id: number, data: Buffer): DecodedValue[] {
  switch (id) {
    // 0x200 — BMS: temps, SOC/SOH, pack V/I (20 Hz). ✅
    case 0x200: {
      if (data.length < 8) return [];
      const packVolts = u16be(data[4], data[5]) / 10;
      const packAmps = i16be(data[6], data[7]) / 10; // signed
      return [
        { key: "batt_temp_lo", value: signedByte(data[0]) },
        { key: "soc", value: data[1] },
        { key: "soh", value: data[2] },
        { key: "batt_temp_hi", value: signedByte(data[3]) },
        { key: "pack_v", value: packVolts },
        { key: "pack_a", value: packAmps },
        { key: "pack_kw", value: Math.round(((packVolts * packAmps) / 1000) * 1000) / 1000 },
      ];
    }

    // 0x201 — BMS system state + error/warning bitfields (10 Hz).
    //  • b0   = System State bitfield (mem 2006). NOT "1 = idle": 1 is bit 0 =
    //    Discharge and 16 is Idle. `charge_state` keeps the raw byte unchanged so it
    //    stays comparable with the rows already in the DB; the bms_state_* booleans
    //    below are the real meaning.
    //  • b1-4 = Error Flags   (mem 2012, BE uint32)
    //  • b5-7 = Warning Flags, BE uint24 = warning bits 23…0. The full word is a
    //    uint32 starting at mem 2016; these three bytes are the 24-bit slice starting
    //    at 2017, i.e. the top byte is dropped because bits 24-31 are all N/A.
    // Both words are logged raw so no flag is ever lost; only the flags worth acting
    // on get their own boolean (the rest are permanently 0 on a healthy pack and
    // would just be dead signals).
    case 0x201: {
      if (data.length < 1) return [];
      const systemState = data[0];
      const values: DecodedValue[] = [{ key: "charge_state", value: systemState }];
      for (const [mask, key] of SYSTEM_STATE_BITS) {
        values.push({ key, value: systemState & mask ? 1 : 0 });
      }
      if (data.length < 8) return values;
      const errorFlags = data.readUInt32BE(1);
      const warningFlags = data.readUIntBE(5, 3);
      values.push(
        { key: "bms_error_flags", value: errorFlags },
        { key: "bms_warning_flags", value: warningFlags },
        { key: "bms_err_cell_overvoltage", value: bit(errorFlags, 0) },
        { key: "bms_err_cell_undervoltage", value: bit(errorFlags, 1) },
        { key: "bms_err_over_temp", value: errorFlags & OVER_TEMPERATURE_ERROR_MASK ? 1 : 0 },
        { key: "bms_err_leak_detected", value: bit(errorFlags, 16) },
        { key: "bms_err_leak_detect_failed", value: bit(errorFlags, 17) },
        { key: "bms_err_contactor", value: errorFlags & CONTACTOR_ERROR_MASK ? 1 : 0 },
        { key: "bms_warn_low_soc", value: bit(warningFlags, 16) },
        { key: "bms_warn_balancing_required", value: bit(warningFlags, 17) }
      );
      return values;
    }

    // 0x202 — allowed current limits (10 Hz). Bytes 0-3 are CONSTANTS, not live data:
    // the stock config transmits the literals 2006 / 2012 / 0 / 2016 (memory ids typed
    // into the constant field by mistake) as four 8-bit signals. Confirmed on the bus
    // 2026-08-02 — those four bytes read D6 DC 00 E0 across 899 frames, which is
    // exactly those literals truncated to 8 bits. Only b4-7 are real. The config marks
    // neither current as signed, so both are read unsigned.
    case 0x202: {
      if (data.length < 8) return [];
      return [
        { key: "allowed_discharge_a", value: u16be(data[4], data[5]) / 10 },
        { key: "allowed_regen_a", value: u16be(data[6], data[7]) / 10 },
      ];
    }

    // 0x203 — cell balance: indices + min/max cell mV (20 Hz).
    // b2 is mem 2025 = "Cell with lowest voltage" and b3 is mem 2024 = "Cell with
    // highest voltage" — the opposite of what the bus notes assumed. That mapping is
    // the BMS config's, not an inference: a parked capture can't tell the two apart,
    // since both indices just sit on whichever cells happen to be extreme.
    case 0x203: {
      if (data.length < 8) return [];
      const minCellMv = u16be(data[4], data[5]);
      const maxCellMv = u16be(data[6], data[7]);
      return [
        { key: "cell_avg_mv", value: u16be(data[0], data[1]) }, // mem 2061, average cell mV
        { key: "cell_min_mv", value: minCellMv },
        { key: "cell_max_mv", value: maxCellMv },
        { key: "cell_spread_mv", value: maxCellMv - minCellMv },
        { key: "cell_lowest_v_idx", value: data[2] },
        { key: "cell_highest_v_idx", value: data[3] },
      ];
    }

    // 0x205 — energy/charge counters (1 Hz).
    // cell_deviation_mv is the BMS's own max−min (mem 2063); cell_spread_mv is the
    // same quantity computed here from 0x203. They agreed exactly (9 mV) on the
    // 2026-08-02 capture, so either one disagreeing later means a misread frame.
    case 0x205: {
      if (data.length < 8) return [];
      return [
        // Remaining energy, coarse. The memory map states mem 2065 is "1KWh
        // resolution, unsigned" (and mem 2150, in 0x661, "1Wh resolution, unsigned")
        // — whole kWh is the documented unit, and the reason the 24-bit high-res
        // field exists at all. Left as a raw count rather than labelled kWh because
        // the 2026-08-02 capture read 964 here at 43 % SOC on a 21.5 kWh pack, which
        // whole kWh cannot explain; 10 Wh units would (9.64 kWh). The cross-check
        // that settles it: once 0x661 is live, bms_remaining_energy_wh / 1000 must
        // track this. If it does, rescale and rename; if it doesn't, one of the two
        // offsets is wrong.
        { key: "bms_remaining_energy_raw", value: u16be(data[0], data[1]) },
        { key: "cell_deviation_mv", value: u16be(data[2], data[3]) },
        // "Amp_H_sum". Read 25.3 Ah at 43 % SOC, where remaining capacity should be
        // nearer 32 Ah, so this may be a coulomb counter rather than what's left.
        { key: "remaining_ah", value: u16be(data[4], data[5]) / 10 },
        { key: "cells_connected", value: u16be(data[6], data[7]) },
      ];
    }

    // 0x206 — pack resistance + module comms (1 Hz). b7 repeats Pack Temp Low, which
    // 0x200 already logs at 20 Hz, so it is skipped. lmu_comm_warnings is a bitmask
    // with bit n = LMU n; bms_io_state is a bitfield with bit n = IO n+1.
    // pack_resistance_mohm reads 0 with the pack at rest — the BMS needs current
    // flowing to measure it, so 0 parked is expected rather than a decode failure.
    case 0x206: {
      if (data.length < 7) return [];
      return [
        { key: "pack_resistance_mohm", value: u16be(data[0], data[1]) },
        { key: "lmu_comm_warnings", value: data.readUInt32BE(2) },
        { key: "bms_io_state", value: data[6] },
      ];
    }

    // 0x207 — isolation test (10 Hz). LITTLE-endian, unlike every other BMS frame.
    // 10-bit ADC readings where 512 is ideal and the leak magnitude is |512 − value|;
    // logged raw because the direction is the diagnostic part (IsoTest1 high = leak
    // nearer the positive terminal, IsoTest2 high = nearer the negative, both equal =
    // a Y-capacitor in the charger or load rather than a fault). A leak is flagged
    // when IsoTestTotal exceeds the measured pack voltage. The BMCU only measures
    // above 25 VDC, so these are meaningless with the pack contactors open.
    case 0x207: {
      if (data.length < 8) return [];
      return [
        { key: "iso_test_1", value: u16le(data[0], data[1]) },
        { key: "iso_test_2", value: u16le(data[2], data[3]) },
        { key: "iso_test_total", value: u16le(data[4], data[5]) },
        { key: "cell_voltage_sum_v", value: u16le(data[6], data[7]) },
      ];
    }

    // 0x300 — charger enable + DC limits the BMS grants the charger (10 Hz, LE).
    case 0x300: {
      if (data.length < 7) return [];
      return [
        { key: "charger_enabled", value: data[0] },
        // Post Processor 1 (mem 2070, 10 bits) is a configurable scratch slot — what
        // this config feeds into it is unknown, so it is logged raw and unscaled.
        { key: "bms_post_processor_1", value: u16le(data[1], data[2]) },
        { key: "charger_max_dc_v", value: u16le(data[3], data[4]) / 10 },
        { key: "charger_max_dc_a", value: u16le(data[5], data[6]) / 10 },
      ];
    }

    // 0x660 — pack thermal summary (1 Hz, 3 bytes). The per-module temperatures are
    // NOT here: mem 2146-2149 sit inside the multiplexed [2129]-[2149] LMU block, so
    // they only mean anything next to an LMU number and ride in 0x664 instead.
    case 0x660: {
      if (data.length < 3) return [];
      return [
        { key: "lmu_temp_high_idx", value: data[0] },
        { key: "lmu_temp_low_idx", value: data[1] },
        { key: "pack_temp_avg", value: signedByte(data[2]) },
      ];
    }

    // 0x661 — high-resolution remaining energy + BMCU hour meter (1 Hz, DLC 6).
    // bms_remaining_energy_wh is the BMS's own figure in 1 Wh steps; residual_energy_wh
    // from 0x10A is the VCU's, in 2 Wh steps. bms_uptime_min counts BMCU power-up
    // minutes and is monotonic, so it doubles as an hour meter for the pack.
    //
    // Deliberately 6 bytes: cells connected (2034) used to sit in b6-7, but 0x205
    // already carries it. Two frames feeding one signal turns any disagreement into a
    // value that flaps every frame instead of an obvious decode error, so the
    // duplicate was removed from the config rather than given a second key.
    case 0x661: {
      if (data.length < 6) return [];
      return [
        { key: "bms_remaining_energy_wh", value: data.readUIntBE(0, 3) },
        { key: "bms_uptime_min", value: data.readUIntBE(3, 3) },
      ];
    }

    // 0x662-0x664 — one LMU module's cells, multiplexed by the module number in
    // byte 0 (see decodeLmuCellVoltages). 20 Hz.
    case 0x662: {
      if (data.length < 7) return [];
      return decodeLmuCellVoltages(data, [1, 2, 3]);
    }

    case 0x663: {
      if (data.length < 7) return [];
      return decodeLmuCellVoltages(data, [4, 5, 6]);
    }

    // 0x664 carries the module's temperatures alongside its last two cells — they
    // come from the same multiplexed memory block, so they are per-LMU readings and
    // only mean anything next to the module number in byte 0.
    case 0x664: {
      if (data.length < 5) return [];
      const values = decodeLmuCellVoltages(data, [7, 8]);
      if (data.length >= 8) {
        values.push(...decodeLmuTemperatures(data));
      }
      return values;
    }

    // 0x665 — the cell limits the BMS is configured with (1 Hz), so nothing
    // downstream has to hardcode them. These four are LITERAL CONSTANTS in the frame
    // definition, not memory reads: the CAN memory map is 82 entries of live
    // measurements and command registers, and none of them exposes the configuration,
    // so a constant is the only way to get the limits onto the bus. The frame is
    // therefore static by design — an unchanging value here is not a stuck signal —
    // and it goes stale if someone edits the limits in the Diagnostic Software
    // without regenerating the frame.
    //
    // Reading cell_min_mv (0x203) against cell_cutoff_mv gives "how close am I to
    // cutting out", but two things stop that from being a cliff edge:
    // DischargeModeUnderVoltageCutOffTimer is 60 s, so the minimum cell has to stay
    // under the threshold for a full minute before the BMS opens the contactors; and
    // allowed_discharge_a (0x202) is derated toward zero before the voltage limit is
    // reached at all, which makes it both the earlier warning and the one signal here
    // that can never go stale.
    case 0x665: {
      if (data.length < 8) return [];
      return [
        { key: "cell_cutoff_mv", value: u16be(data[0], data[1]) },
        { key: "cell_end_of_life_mv", value: u16be(data[2], data[3]) },
        { key: "cell_overvoltage_mv", value: u16be(data[4], data[5]) },
        { key: "cell_target_mv", value: u16be(data[6], data[7]) },
      ];
    }

    default:
      return [];
  }
}

// System State bitfield (mem 2006) carried in 0x201 b0.
const SYSTEM_STATE_BITS: ReadonlyArray<readonly [number, string]> = [
  [0x01, "bms_state_discharge"],
  [0x02, "bms_state_charge"],
  [0x04, "bms_state_balancing"],
  [0x08, "bms_state_trickle"],
  [0x10, "bms_state_idle"],
  [0x20, "bms_state_charge_complete"],
  [0x40, "bms_state_maintenance"], // BMS firmware v6.16+ only
];

// Error-flag bits collapsed into one boolean each — bms_error_flags still carries
// the individual bits, so nothing is lost by not giving all five contactor faults
// their own permanently-zero signal.
const OVER_TEMPERATURE_ERROR_MASK = (1 << 4) | (1 << 7); // cell | LMU over temperature
const CONTACTOR_ERROR_MASK = (1 << 21) | (1 << 22) | (1 << 23) | (1 << 24) | (1 << 25); // main +/−, precharge, midpack, precharge timeout

// 11 LMU modules: 1-4 have 8 cells enabled, 5-11 have 7 → 81 series positions,
// matching the pack's 81s topology.
export const LMU_COUNT = 11;

// BattTemp1Enabled is False on these two modules, so 0x664 b5 carries nothing
// meaningful for them. Absence here is configuration, not a failed sensor. (BAT2,
// mem 2149, is disabled on all 11 and isn't broadcast at all.)
export const LMUS_WITHOUT_BATTERY_TEMP = [6, 8];

export function cellsInLmu(lmuNumber: number): number {
  return lmuNumber <= 4 ? 8 : 7;
}

// The registry generates its per-module signal defs through these, so the keys it
// declares can't drift from the keys the decoder emits.
export function cellVoltageKey(lmuNumber: number, cellNumber: number): string {
  return `lmu${lmuNumber}_cell${cellNumber}_mv`;
}

export function lmuTemperatureKey(lmuNumber: number, sensor: LmuTemperatureSensor): string {
  return `lmu${lmuNumber}_${sensor}_c`;
}

export type LmuTemperatureSensor = "bat1" | "pcb1" | "pcb2";

// 0x662/0x663/0x664 each carry three, three and two of one module's cells, with the
// module number repeated in byte 0 of all three. Every frame is decoded on its own
// and keyed off the LMU number in that SAME frame: decoders are pure (no cross-frame
// state), and these are three separate messages, so the module can advance between
// 0x662 and 0x664.
//
// The multiplexing itself is confirmed by the manual — from v6.11 the BMCU polls the
// LMUs one by one and overwrites mem [2129]-[2149] with each one's data, which is
// also why 20 Hz matters: the manual's recommended broadcast interval for the block
// is 50 ms, and sampling slower than the BMCU's poll silently skips modules.
//
// The range check below still earns its keep: if byte 0 ever came back static or out
// of range we would keep re-logging one module rather than smear its values across
// the others' keys.
function decodeLmuCellVoltages(data: Buffer, cellNumbers: number[]): DecodedValue[] {
  const lmuNumber = data[0];
  // Always log the selector itself, valid or not. Without it, "byte 0 isn't the LMU
  // number after all" and "the frames never arrived" both show up as zero per-cell
  // signals, and telling them apart would need a bus capture in the garage. It also
  // makes the rotation visible: watch lmu_cell_mux in the debug view and you can see
  // whether it really walks 1…11 or sits on one module.
  const values: DecodedValue[] = [{ key: "lmu_cell_mux", value: lmuNumber }];
  if (lmuNumber < 1 || lmuNumber > LMU_COUNT) return values;
  const cellsPresent = cellsInLmu(lmuNumber);
  for (let slot = 0; slot < cellNumbers.length; slot++) {
    const cellNumber = cellNumbers[slot];
    // LMUs 5-11 have no cell #8, so 0x664's second slot is meaningless for them.
    if (cellNumber > cellsPresent) continue;
    const millivolts = u16be(data[1 + slot * 2], data[2 + slot * 2]);
    // 0 mV is the BMS's "no reading" placeholder, never a real series cell.
    if (millivolts === 0) continue;
    values.push({ key: cellVoltageKey(lmuNumber, cellNumber), value: millivolts });
  }
  return values;
}

// 0x664 b5-7 — the temperatures of the module named in byte 0.
function decodeLmuTemperatures(data: Buffer): DecodedValue[] {
  const lmuNumber = data[0];
  if (lmuNumber < 1 || lmuNumber > LMU_COUNT) return [];
  const values: DecodedValue[] = [
    { key: lmuTemperatureKey(lmuNumber, "pcb1"), value: signedByte(data[6]) },
    { key: lmuTemperatureKey(lmuNumber, "pcb2"), value: signedByte(data[7]) },
  ];
  if (!LMUS_WITHOUT_BATTERY_TEMP.includes(lmuNumber)) {
    values.push({ key: lmuTemperatureKey(lmuNumber, "bat1"), value: signedByte(data[5]) });
  }
  return values;
}

// The BMS frames we decode. 0x660-0x665 cost nothing but an unused RX filter until
// the extended config is flashed.
export const BMS_STREAM_IDS = [
  0x200, 0x201, 0x202, 0x203, 0x205, 0x206, 0x207, 0x300, 0x660, 0x661, 0x662, 0x663, 0x664, 0x665,
];
