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
    //
    // b0/b3 are logged as batt_temp_*_vcu, NOT as batt_temp_*, because what they mean
    // depends on which BMS config is flashed. The VCU derates DC charging from 36 °C
    // reported pack temperature, which is far too early for a watercooled pack, so the
    // custom configs lower these two bytes to push that knee later. Only what is
    // transmitted changes — every BMS protection threshold, the regen shaping curve and
    // allowed_regen_a are still computed from the raw internal values.
    //
    // The size of that shift is NOT fixed, and assuming it is has already produced one
    // false alarm. Four configs have been flashed:
    //   5-custom-p32b-vcu-offset  a flat −15 °C. RETIRED — it broke charging.
    //   11-full-conditional-offset  a no-op: its postprocessor line never ran (verified
    //                             over 1900 samples, 0x660 b3/b4 identical to 0x200).
    //   14-signbit-clamp  pinned the reported value at 35 °C for ANY true temperature
    //                     above 35, and passed the true value through below it.
    //                     SUPERSEDED — see 15 below.
    //   15-bounded-clamp  (built 2026-08-09, NOT YET FLASHED) bounds that clamp at the top:
    //                     below 35 °C it passes the truth through, from 35 to 54 °C it
    //                     reports 35, and at 55 °C and above it reports the TRUTH again.
    // So under the live config the difference batt_temp_hi − batt_temp_hi_vcu is 0 below
    // 35 °C, (true − 35) from 35 to 54 °C, and 0 again from 55 °C up. A constant 15 is
    // the one thing it is NOT, and it is not even monotonic in temperature. Do not treat
    // any particular difference as a health check.
    //
    // The upper bound exists because the VCU enters limp mode at 55 °C (LIMP_B_TEMP = 55 in
    // the A9 parameter block — obd-garage/DC_CHARGE_LIMITS.md §7 puts it plainly: pinned at
    // 35, the unbounded clamp does not delay that protection, it disables it). Not
    // hypothetical: this bike's own log has the pack at a true 55 °C on 2026-08-08 13:45 UTC
    // with clamp_amount = 20 and batt_temp_hi_vcu last logged at 35.
    //
    // So these bytes are always "what the VCU and the dash see", which is honest under
    // every config; the true temperature comes from 0x660 when one of these is loaded.
    // pack-temperature.ts resolves which source feeds batt_temp_lo/batt_temp_hi.
    //
    // Measured 2026-08-02 under the retired flat-offset config: 0x200 reported 13/14 °C
    // while 0x660 b3/b4 reported 28/29 °C. Measured 2026-08-04 under the clamp: 0x200
    // reported 35/35 while 0x660 b3/b4 reported 36/36.
    case 0x200: {
      if (data.length < 8) return [];
      const packVolts = u16be(data[4], data[5]) / 10;
      const packAmps = i16be(data[6], data[7]) / 10; // signed
      return [
        { key: "batt_temp_lo_vcu", value: signedByte(data[0]) },
        { key: "soc", value: data[1] },
        { key: "soh", value: data[2] },
        { key: "batt_temp_hi_vcu", value: signedByte(data[3]) },
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
        // field exists at all. Left unscaled anyway, because the bus contradicts the
        // manual: the 2026-08-02 capture read 964 here while 0x10A in the same capture
        // read 6652 Wh residual, at 43 % SOC. That implies ~6.9 Wh per count — neither
        // the documented 1 kWh (964 kWh is impossible) nor any round number, so there
        // is no scale worth committing to. Resolver: once 0x661 is live, mem 2150 is
        // 1 Wh resolution and confirmed by the manual, so it settles this outright.
        { key: "bms_remaining_energy_raw", value: u16be(data[0], data[1]) },
        { key: "cell_deviation_mv", value: u16be(data[2], data[3]) },
        // "Amp_H_sum". Read 25.3 Ah at 43 % SOC, which implies ~58.8 Ah installed —
        // a good match for the 58 Ah in modified_eva_ribelle_2021.bms (58 × 0.43 =
        // 24.9). So the value itself looks right; what it *means* is still unconfirmed
        // (remaining capacity vs a coulomb counter).
        { key: "remaining_ah", value: u16be(data[4], data[5]) / 10 },
        // Series positions, not physical cells: the 2p81s pack reads 81 here, not 162
        // (2026-08-02 capture, every row). Anything lower means the BMS has dropped a
        // module, which is what the battery dashboard's threshold is set against.
        { key: "cells_connected", value: u16be(data[6], data[7]) },
      ];
    }

    // 0x206 — pack resistance + module comms (1 Hz). lmu_comm_warnings is a bitmask
    // with bit n = LMU n; bms_io_state is a bitfield with bit n = IO n+1.
    // pack_resistance_mohm reads 0 with the pack at rest — the BMS needs current
    // flowing to measure it, so 0 parked is expected rather than a decode failure.
    //
    // b7 is deliberately NOT decoded. It carries whatever 0x200 b0 carries — the true
    // pack temp low under the pre-offset config, the VCU-shifted one under the offset
    // config — so its meaning is config-dependent, and it is a 1 Hz duplicate of a
    // 20 Hz signal either way. Skipping it means this frame needs no config detection
    // at all, which is strictly safer than deciding what it means and being wrong.
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
    // 0x300 is a low, generic-looking ID, so it is worth saying why we attribute it to
    // the BMS rather than to some other ECU that happens to use it: it is frame 8 in
    // the BMS's own TX table in every config file we have, stock included.
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

    // 0x660 — pack thermal summary (1 Hz). The per-module temperatures are NOT here:
    // mem 2146-2149 sit inside the multiplexed [2129]-[2149] LMU block, so they only
    // mean anything next to an LMU number and ride in 0x664 instead.
    //
    // pack_temp_avg (mem 2123) is NOT offset by the VCU shift — only the two bytes on
    // 0x200 and 0x206 b7 are — so it stays directly comparable with batt_temp_*.
    case 0x660: {
      if (data.length < 3) return [];
      const values: DecodedValue[] = [
        { key: "lmu_temp_high_idx", value: data[0] },
        { key: "lmu_temp_low_idx", value: data[1] },
        { key: "pack_temp_avg", value: signedByte(data[2]) },
      ];
      // The frame is DLC 3 before the VCU temperature offset exists and DLC 8 after,
      // so its length is the only honest way to tell the two configs apart. Bytes 3-4
      // must never be read from the short form: CAN padding would decode as 0 °C,
      // which is plausible enough to be logged and believed rather than spotted.
      if (data.length >= OFFSET_CONFIG_MIN_DLC) {
        values.push(
          { key: "batt_temp_hi", value: signedByte(data[3]) },
          { key: "batt_temp_lo", value: signedByte(data[4]) }
        );
      }
      // b5-7 instrument the temperature clamp, one byte each. They used to be a single
      // 16-bit read of postprocessor slot Output3 spanning b5-6, which answered a
      // one-off question (a 1-byte result lands in the LOW byte of a 16-bit slot —
      // confirmed 2026-08-02, word 0x000E with b3 = 29 °C). The unconditional-offset
      // config that used that layout is retired; it broke charging. Every config from 11
      // on declares b5, b6 and b7 as three separate 1-byte signals, so the 16-bit decode
      // would now silently pair two unrelated bytes: it reported 0x0202 on 2026-08-04 and
      // was read as "the offset is not applied", when in fact diff = 2 and amount = 2 at a
      // true 37 °C was the clamp working.
      //
      // Read out of 15-bounded-clamp.bms (CANTX_Frame_10, DLC 8):
      //
      //   clamp_gate   (b5, mem 2103) = the gate that decides which regime is in force.
      //                  255 = closed, the clamp may subtract; 0 = open, the true
      //                  temperature is going out untouched. Called `mask2` in the config,
      //                  because it is an all-ones/all-zeroes byte ANDed over the amount.
      //   clamp_amount (b6, mem 2087) = how much the clamp WOULD subtract, before the gate
      //   batt_temp_hi_vcu_echo (b7, mem 2075) = the result the VCU is actually shown
      //
      // and the identity that ties all three to b3, checkable from this frame alone:
      //
      //   batt_temp_hi_vcu_echo === batt_temp_hi − (clamp_amount & clamp_gate)
      //
      // ⚠️ b6 is the PRE-gate amount, not "how much is being subtracted" — that changed
      // with config 15 even though the byte's address did not. At 55 °C and up the gate
      // opens, so clamp_amount reads (true − 35) ≥ 20 while nothing at all is subtracted.
      // The two only coincide while the gate is closed, which is every ordinary
      // temperature. Under 11-full-conditional-offset it is a flat 9 °C offset, and on
      // 2026-08-04 that config's postprocessor line never ran at all, so b5 and b6 both
      // read 0x00 through a whole DC charge while b7 carried the true temperature. So
      // these two keys mean "whatever the live config feeds those slots"; only b7 is the
      // same quantity in every config that has ever sent a long 0x660.
      //
      // The echo is not merely the same value as 0x200 b3, it is the same memory
      // (mem 2075, in configs 11 through 15 — verified against the decrypted XML), so a
      // disagreement between the two means a repointing error in the config rather than a
      // decode error here. pack-temperature.ts watches for it.
      //
      // ── WHY b5 IS DECODED AS THE GATE AND NOT AS 14-signbit-clamp's clamp_diff ──
      //
      // There is no reliable way to tell 14 from 15 apart at runtime, and this decoder does
      // not try. Both send 0x660 at DLC 8 with the same eight fields; only b5's source
      // memory moved (2079 → 2103). Under 14 b5 was `true − 35` wrapped, which takes 255 at
      // a true 34 °C and 0 at 35 °C — so a single frame at either of those temperatures is
      // literally indistinguishable from a healthy config 15, and the two configs' visible
      // behaviour only diverges above 54 °C.
      //
      // A per-frame discriminator does exist on paper (config 14 predicts b5 = (b3 − 35)
      // mod 256, config 15 predicts 255 below 55 °C and 0 above; those differ at every
      // temperature except exactly 34 °C) and it is deliberately NOT used. It is circular:
      // it assumes the postprocessor chain is healthy in order to decide what the byte
      // means, and telling us the chain is NOT healthy is the entire reason this byte is on
      // the bus. It would mislabel precisely the frames it exists to catch. A statistical
      // "b5 has only ever been 0 or 255" test is worse — it converges slowly and a pack
      // parked at 34 °C fakes it indefinitely.
      //
      // So the honest answer is that the operator declares the config by flashing it, and
      // this decoder is written for the config that is flashed. That is acceptable here,
      // and would NOT be under batt_temp_lo/batt_temp_hi, for two reasons:
      //   • b3/b4 are identical under both configs, so the true-temperature keys — the ones
      //     with years of history that pack-temperature.ts exists to protect — cannot be
      //     corrupted by getting this wrong. Only diagnostic instrumentation can.
      //   • being wrong is recoverable rather than silent. Config 14's b5 was exactly
      //     (batt_temp_hi − 35) mod 256, verified across all 198 same-timestamp pairs in the
      //     ride log (true 28…55 °C, zero exceptions), so if this decode is applied to a
      //     bike still on 14 the rows can be reconstructed from batt_temp_hi in the same
      //     frame — nothing is destroyed. And it will not be quiet about it:
      //     pack-temperature.ts warns once on any b5 that is not a mask.
      //
      // clamp_gate is decoded UNSIGNED, unlike the clamp_diff it replaces. 255 is a mask of
      // all ones, not minus one; signing it would render the normal, healthy, everything-is-
      // working state as "−1" on every chart and invite exactly the arithmetic (gate − 1,
      // gate + 35) that the byte no longer supports.
      if (data.length >= CLAMP_INSTRUMENTATION_MIN_DLC) {
        values.push(
          { key: "clamp_gate", value: data[5] },
          { key: "clamp_amount", value: data[6] },
          { key: "batt_temp_hi_vcu_echo", value: signedByte(data[7]) }
        );
      }
      return values;
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
    //
    // Unconfirmed: the energy field read 0 Wh at 38 % SOC on 2026-08-02, five minutes
    // after a BMS reboot. Most likely not yet computed that soon after boot rather
    // than a decode fault — do not treat a 0 here as authoritative until it has been
    // re-checked after a longer run.
    case 0x661: {
      if (data.length < 6) return [];
      return [
        { key: "bms_remaining_energy_wh", value: data.readUIntBE(0, 3) },
        { key: "bms_uptime_min", value: data.readUIntBE(3, 3) },
      ];
    }

    // 0x662-0x664 — one LMU module's cells, multiplexed by the module number in
    // byte 0 (see decodeLmuCellVoltages). 0x662 is 20 Hz; 0x663/0x664 were too, until
    // config 6 slowed them to 150 ms and 250 ms to break a phase lock. So cells 4-8
    // refresh more slowly than cells 1-3, and a module's eight cells are NOT all the
    // same age — anything drawing a per-cell view has to allow for that.
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

// 0x660 is DLC 3 before the VCU temperature offset exists and DLC 8 after, so its
// length is what distinguishes the two configs. Exported because pack-temperature.ts
// must suppress its 0x200 mirror on exactly the frames where the decoder above emits
// batt_temp_* — if the two ever disagreed, those keys would either stop updating or
// get two writers flapping 15 °C apart, and neither shows up as an error.
export const OFFSET_CONFIG_MIN_DLC = 5;

// The clamp instrumentation in b5-7 needs the frame to be full length, a stricter gate
// than OFFSET_CONFIG_MIN_DLC above: a DLC 5-7 frame proves the true temperatures are
// present without proving the clamp bytes are. Named rather than inline so the two
// thresholds are visibly different decisions instead of looking like one of them is a
// typo — every long 0x660 sent so far has been DLC 8, so the gap is untested in practice.
export const CLAMP_INSTRUMENTATION_MIN_DLC = 8;

// The only two values 0x660 b5 can hold under 15-bounded-clamp: the postprocessor builds
// it as (((true_hi − 55) & 0xFF) / 128) × 255, truncated to one byte, so it is a byte of
// all ones or a byte of all zeroes and nothing else.
//
// That the divide truncates toward zero on unsigned bytes — the assumption the whole mask
// trick rests on — is not taken on trust. It is proven by the config-14 rows already in the
// ride log, which use the identical construct one threshold lower: across 186 same-timestamp
// pairs, clamp_amount was 0 on every frame where clamp_diff was negative (raw byte ≥ 128, so
// the divide had to yield 1) and equal to clamp_diff on every frame where it was not (so the
// divide had to yield 0), with zero exceptions. Neither a signed nor a rounding divide can
// produce that pattern; see the warnings in pack-temperature.ts for what each would look
// like here.
export const CLAMP_GATE_CLOSED = 255;
export const CLAMP_GATE_OPEN = 0;

// The two temperatures that bound the clamp, both in true °C.
//
// CLAMP_FLOOR_C is what the VCU is shown throughout the clamped band, chosen to sit just
// under the 36 °C DC-charge derate knee. LIMP_MODE_TEMP_C is the VCU's LIMP_B_TEMP, and the
// reason the clamp is bounded at all: at and above it the config reports the truth so that
// the VCU's own thermal protection can still fire. Exported for the plausibility checks in
// pack-temperature.ts, which need to know which regime a given true temperature implies.
export const CLAMP_FLOOR_C = 35;
export const LIMP_MODE_TEMP_C = 55;

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
//
// KNOWN GAP (config-side, not a decode fault): 0x662 samples all 11 modules evenly,
// but 0x663 and 0x664 never sampled LMU 1 or 2 across 499 frames each on 2026-08-02,
// and the rest is heavily skewed. All three frames read the same mem 2129 at the same
// 20 Hz, so the fixed CAN transmit order is phase-locked to the BMCU's LMU poll.
// Consequence: cells 4-8 of LMU 1 and 2 were unobtainable, and it was a systematic
// zero rather than sparse sampling — a longer capture would not have filled it in.
// Keying every value off the LMU number in its own frame is what made this show up as
// missing data instead of as another module's cells being silently overwritten.
//
// Fixed config-side in 6-custom-p32b-lmu-phase.bms by slowing 0x663 to 150 ms and
// 0x664 to 250 ms so they no longer march in step with the poll. No decoder change was
// needed, which is the whole point of keying off the in-frame module number.
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
    if (!isPlausibleCellVoltage(millivolts)) continue;
    values.push({ key: cellVoltageKey(lmuNumber, cellNumber), value: millivolts });
  }
  return values;
}

// The BMS pads a slot it has no reading for with a sentinel, and that sentinel is NOT
// zero: 0x664's cell-8 field read 8192 mV (0x2000) in all 459 samples from LMUs 5-11
// on the 2026-08-02 capture, those modules having only 7 cells. A magic-number list
// would only cover the sentinels we happen to have seen, so anything outside a
// plausible series-cell band is dropped instead. The band is deliberately far wider
// than this pack's own configured limits (0x665: 2000 mV end-of-life, 4300 mV
// over-voltage), so no real cell — even a badly damaged one — can fall outside it.
//
// A genuinely shorted cell reading ~0 mV would be dropped too; 0x203's cell_min_mv
// still catches that, and it is measured by the BMS rather than inferred here.
const MIN_PLAUSIBLE_CELL_MV = 1000;
const MAX_PLAUSIBLE_CELL_MV = 5000;

function isPlausibleCellVoltage(millivolts: number): boolean {
  return millivolts >= MIN_PLAUSIBLE_CELL_MV && millivolts <= MAX_PLAUSIBLE_CELL_MV;
}

// The temperature bytes in the same multiplexed block need their own guard, and the
// measured pad settles what it has to catch: 0x664 b5 reads 0x7A = 122 °C on a module
// whose slot isn't freshly populated. (Not 0x20 = 32 °C — a byte-pattern pad mirroring
// the 0x2000 cell sentinel would have been indistinguishable from a real module
// temperature. It isn't, so this is catchable.) MaxLMUtemperature is 85 °C in the
// config, so anything above ~100 °C is definitionally not a reading the BMS tolerates.
const MIN_PLAUSIBLE_LMU_TEMP_C = -40;
const MAX_PLAUSIBLE_LMU_TEMP_C = 100;

function isPlausibleLmuTemperature(celsius: number): boolean {
  return celsius >= MIN_PLAUSIBLE_LMU_TEMP_C && celsius <= MAX_PLAUSIBLE_LMU_TEMP_C;
}

// 0x664 b5-7 — the temperatures of the module named in byte 0.
//
// The band and LMUS_WITHOUT_BATTERY_TEMP are NOT redundant; they catch different
// failures and both are required:
//   • the band catches pad values — a module the BMCU hasn't polled yet reads 122 °C;
//   • the exclusion list catches STALE values. LMU 6 and 8 have BattTemp1Enabled=False
//     and were measured reporting 0x7A sometimes but a perfectly plausible 28 °C other
//     times, which is near-certainly another module's reading left behind in the shared
//     [2129]-[2149] block. No band can catch a stale-but-plausible number; only knowing
//     from the config that those two modules have no sensor can.
function decodeLmuTemperatures(data: Buffer): DecodedValue[] {
  const lmuNumber = data[0];
  if (lmuNumber < 1 || lmuNumber > LMU_COUNT) return [];
  const values: DecodedValue[] = [];
  const boardTemperatures: ReadonlyArray<readonly [LmuTemperatureSensor, number]> = [
    ["pcb1", signedByte(data[6])],
    ["pcb2", signedByte(data[7])],
  ];
  for (const [sensor, celsius] of boardTemperatures) {
    if (!isPlausibleLmuTemperature(celsius)) continue;
    values.push({ key: lmuTemperatureKey(lmuNumber, sensor), value: celsius });
  }
  if (LMUS_WITHOUT_BATTERY_TEMP.includes(lmuNumber)) return values;
  const batteryTemperature = signedByte(data[5]);
  if (isPlausibleLmuTemperature(batteryTemperature)) {
    values.push({ key: lmuTemperatureKey(lmuNumber, "bat1"), value: batteryTemperature });
  }
  return values;
}

// The BMS frames we decode. 0x660-0x665 cost nothing but an unused RX filter until
// the extended config is flashed.
export const BMS_STREAM_IDS = [
  0x200, 0x201, 0x202, 0x203, 0x205, 0x206, 0x207, 0x300, 0x660, 0x661, 0x662, 0x663, 0x664, 0x665,
];
