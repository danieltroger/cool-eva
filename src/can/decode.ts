// Pure per-frame decoders for the Energica broadcast frames we log.
// Byte layouts come from obd-garage/CAN_MAP.md. Each decoder returns the list of
// (signal key, value) pairs carried by that frame; unknown IDs return [].
//
// The 0x2xx / 0x300 / 0x66x frames are the LiBAL s-BMS's own TX frames, and their
// layouts are NOT reverse-engineered: they were read out of the bike's decrypted BMS
// configuration file (`stockconfig_eva_ribelle_2021.bms`) cross-referenced with the
// LiBAL Application Engineering Manual's memory map. Where that disagreed with the
// bus notes, the config wins — see the "Corrections" section of CAN_MAP.md.
//
// BE = big-endian pair, LE = little-endian pair. Battery temps are signed (can go
// below 0 °C); pack current is signed (charge vs discharge). Everything the BMS
// sends is big-endian except 0x207 and 0x300, which the config marks little-endian.

export interface DecodedValue {
  key: string;
  value: number;
}

const signedByte = (byte: number): number => (byte > 127 ? byte - 256 : byte);
const u16be = (hi: number, lo: number): number => (hi << 8) | lo;
const i16be = (hi: number, lo: number): number => {
  const value = (hi << 8) | lo;
  return value > 32767 ? value - 65536 : value;
};
const u16le = (lo: number, hi: number): number => (hi << 8) | lo;
const bit = (word: number, index: number): number => (word >>> index) & 1;

export function decodeFrame(id: number, data: Buffer): DecodedValue[] {
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
    //  • b5-7 = Warning Flags (BE uint24 carrying warning bits 23…0; the config
    //    frame table and the manual's flag table disagree on whether that memory is
    //    2016 or 2017, but the bit meanings and byte positions are the same either way)
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
    // into the constant field by mistake), and Energica's upgraded config puts a pack
    // stamp there instead. Only b4-7 are real. The config marks neither current as
    // signed, so both are read unsigned.
    case 0x202: {
      if (data.length < 8) return [];
      return [
        { key: "allowed_discharge_a", value: u16be(data[4], data[5]) / 10 },
        { key: "allowed_regen_a", value: u16be(data[6], data[7]) / 10 },
      ];
    }

    // 0x203 — cell balance: indices + min/max cell mV (20 Hz).
    // b2 is mem 2025 = "Cell with lowest voltage" and b3 is mem 2024 = "Cell with
    // highest voltage" — the opposite of what the bus notes assumed, so the weak cell
    // on this pack is #68, not #20.
    case 0x203: {
      if (data.length < 8) return [];
      const minCellMv = u16be(data[4], data[5]);
      const maxCellMv = u16be(data[6], data[7]);
      return [
        { key: "cell_avg_mv", value: u16be(data[0], data[1]) }, // mem 2061, average cell mV
        { key: "cell_min_mv", value: minCellMv },
        { key: "cell_max_mv", value: maxCellMv },
        { key: "cell_spread_mv", value: maxCellMv - minCellMv },
        { key: "min_cell_idx", value: data[2] },
        { key: "max_cell_idx", value: data[3] },
      ];
    }

    // 0x205 — energy/charge counters (1 Hz).
    // cell_deviation_mv is the BMS's own max−min (mem 2063); cell_spread_mv is the
    // same quantity computed here from 0x203, so a disagreement means one of the two
    // frames is being misread.
    case 0x205: {
      if (data.length < 8) return [];
      return [
        { key: "bms_remaining_energy_kwh", value: u16be(data[0], data[1]) },
        { key: "cell_deviation_mv", value: u16be(data[2], data[3]) },
        { key: "remaining_ah", value: u16be(data[4], data[5]) / 10 },
        { key: "cells_connected", value: u16be(data[6], data[7]) },
      ];
    }

    // 0x206 — pack resistance + module comms (1 Hz). b7 repeats Pack Temp Low, which
    // 0x200 already logs at 20 Hz, so it is skipped. lmu_comm_warnings is a bitmask
    // with bit n = LMU n; bms_io_state is a bitfield with bit n = IO n+1.
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

    // 0x10A — charge/energy status.
    //  • b3-4 LE, bit 15 masked off, × 2 = RES.ENERGY Wh (residual/available energy).
    //    Bit 15 is a FLAG, not part of the value: it toggles on ~half the frames, so
    //    reading the raw word alternated between the true value and value+65536 (the
    //    square wave in Grafana). Confirmed on 45k logged samples — every value showed
    //    up as a 0x8000-apart pair — and against the menu at two SOCs (4778×2=9556 vs
    //    menu 9557; 1095×2=2190 vs menu 2190). ✅
    //  • b7 = CHG.PWR.REF % → AC charge-current setpoint; amps = b7 ÷ 7 (RE'd live:
    //    7%→1 A, 21%→3 A, 49%→7 A; 100% ≈ 14.3 A AC max). ✅
    case 0x10a: {
      if (data.length < 8) return [];
      return [
        { key: "residual_energy_wh", value: (u16le(data[3], data[4]) & 0x7fff) * 2 },
        { key: "charge_limit_a", value: Math.round((data[7] / 7) * 10) / 10 },
      ];
    }

    // 0x025 — INST.CONS: b0-1 LE ÷10 = Wh (50 Hz). ✅
    case 0x025: {
      if (data.length < 2) return [];
      return [{ key: "inst_consumption_wh", value: u16le(data[0], data[1]) / 10 }];
    }

    // 0x305 — charger DC (charging only, 5 Hz). 🟡
    case 0x305: {
      if (data.length < 7) return [];
      return [
        { key: "mains_a", value: data[1] / 10 },
        { key: "dc_a", value: u16le(data[3], data[4]) / 10 },
        { key: "dc_v", value: u16le(data[5], data[6]) / 10 },
      ];
    }

    // 0x306 — charger AC: mains voltage (charging only, 5 Hz). 🟡
    case 0x306: {
      if (data.length < 3) return [];
      return [{ key: "mains_v", value: data[2] }];
    }

    // 0x109 — throttle position: b0-1 LE ÷10 = % (0 idle … 100). 🟡
    case 0x109: {
      if (data.length < 2) return [];
      return [{ key: "throttle_pct", value: u16le(data[0], data[1]) / 10 }];
    }

    // 0x102 — body/lights (decoded live on the bike). b0 bit6 (0x40) = high beam
    // (bit7 0x80 = low beam). b2 is a lights bitfield: 0x04 L blinker, 0x08 R
    // blinker, 0x10 horn, 0x20 front brake, 0x40 rear brake. ✅
    case 0x102: {
      if (data.length < 3) return [];
      const lights = data[2];
      return [
        { key: "high_beam", value: data[0] & 0x40 ? 1 : 0 },
        { key: "brake", value: lights & 0x60 ? 1 : 0 },
        { key: "blinker_left", value: lights & 0x04 ? 1 : 0 },
        { key: "blinker_right", value: lights & 0x08 ? 1 : 0 },
        { key: "horn", value: lights & 0x10 ? 1 : 0 },
      ];
    }

    // 0x480 — E-LOCK / keyless status (10 Hz, present key-on/parked). b2-5 LE
    // uint32 = ID of the key fob currently present; it matches slot 1 of the 3
    // fobs paired in the E-LOCK ECU (b0 = 05, b6 = 01 constant). 🟡
    case 0x480: {
      if (data.length < 6) return [];
      return [{ key: "key_fob_id", value: data.readUInt32LE(2) }];
    }

    // 0x660 — module/board temperatures (1 Hz). b7 repeats Pack Temp High, already
    // logged as batt_temp_hi from 0x200 at 20 Hz, so it is skipped.
    case 0x660: {
      if (data.length < 7) return [];
      return [
        { key: "lmu_temp_high_idx", value: data[0] },
        { key: "lmu_temp_low_idx", value: data[1] },
        { key: "pack_temp_avg", value: signedByte(data[2]) },
        { key: "board_temp_pcb1", value: signedByte(data[3]) },
        { key: "board_temp_pcb2", value: signedByte(data[4]) },
        { key: "board_temp_bat1", value: signedByte(data[5]) },
        { key: "board_temp_bat2", value: signedByte(data[6]) },
      ];
    }

    // 0x661 — high-resolution remaining energy + BMCU hour meter (1 Hz).
    // bms_remaining_energy_wh is the BMS's own figure in 1 Wh steps; residual_energy_wh
    // from 0x10A is the VCU's, in 2 Wh steps. bms_uptime_min counts BMCU power-up
    // minutes and is monotonic, so it doubles as an hour meter for the pack.
    case 0x661: {
      if (data.length < 8) return [];
      return [
        { key: "bms_remaining_energy_wh", value: data.readUIntBE(0, 3) },
        { key: "bms_uptime_min", value: data.readUIntBE(3, 3) },
        { key: "cells_connected", value: u16be(data[6], data[7]) },
      ];
    }

    // 0x662-0x664 — per-cell voltages for one LMU module, multiplexed by the module
    // number in byte 0 (see decodeLmuCellVoltages).
    case 0x662: {
      if (data.length < 7) return [];
      return decodeLmuCellVoltages(data, [1, 2, 3]);
    }

    case 0x663: {
      if (data.length < 7) return [];
      return decodeLmuCellVoltages(data, [4, 5, 6]);
    }

    case 0x664: {
      if (data.length < 5) return [];
      return decodeLmuCellVoltages(data, [7, 8]);
    }

    // 0x665 — the cell limits the BMS is configured with (1 Hz), so nothing
    // downstream has to hardcode them. These four are LITERAL CONSTANTS in the frame
    // definition, not memory reads: the BMS does not expose its own configuration
    // thresholds as CAN memory, so they are stamped in when the config is built. The
    // frame is therefore static by design — an unchanging value here is not a fault.
    // It also means the frame has to be regenerated whenever the BMS is reflashed
    // with different limits; if these ever disagree with observed cell voltages, the
    // config is stale, the decode is not.
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

export function cellsInLmu(lmuNumber: number): number {
  return lmuNumber <= 4 ? 8 : 7;
}

// The registry generates its per-cell signal defs through this, so the keys it
// declares can't drift from the keys the decoder emits.
export function cellVoltageKey(lmuNumber: number, cellNumber: number): string {
  return `lmu${lmuNumber}_cell${cellNumber}_mv`;
}

// 0x662/0x663/0x664 each carry three, three and two of one module's cells, with the
// module number repeated in byte 0 of all three. Every frame is decoded on its own
// and keyed off the LMU number in that SAME frame: decoders are pure (no cross-frame
// state) and nothing guarantees the module hasn't advanced between 0x662 and 0x664.
//
// The rotation through modules 1…11 is an ASSUMPTION — mem 2129 is an output with no
// selector input, so the BMS may just as well pin it to one module. If byte 0 turns
// out to be static we simply keep re-logging that module's cells and see 7-8 signals
// instead of 81; no cell value is ever written under another module's key.
function decodeLmuCellVoltages(data: Buffer, cellNumbers: number[]): DecodedValue[] {
  const lmuNumber = data[0];
  if (lmuNumber < 1 || lmuNumber > LMU_COUNT) return [];
  const cellsPresent = cellsInLmu(lmuNumber);
  const values: DecodedValue[] = [];
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

// CAN IDs we decode from the broadcast stream — used to set kernel RX filters.
// 0x660-0x665 only exist once the extended BMS config is flashed; until then they
// simply never arrive, which costs nothing but an unused RX filter.
export const STREAM_IDS = [
  0x025, 0x102, 0x109, 0x10a, 0x200, 0x201, 0x202, 0x203, 0x205, 0x206, 0x207, 0x300, 0x305, 0x306, 0x480, 0x660, 0x661,
  0x662, 0x663, 0x664, 0x665,
];
