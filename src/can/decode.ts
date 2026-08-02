// Pure per-frame decoders for the Energica broadcast frames we log. Each decoder
// takes one frame's bytes and returns the (signal key, value) pairs it carries;
// unknown IDs return []. No I/O, no clock reads, no cross-frame state — that's what
// makes them testable by replaying a capture when the bike is out of reach.
//
// The frames below are reverse-engineered from the wire and cross-checked against the
// bike's engineering menu (see obd-garage/CAN_MAP.md). The BMS's own frames are a
// different story — they come from its decrypted config file, so they live in
// decode-bms.ts and this file just hands unmatched IDs over.
//
// A third source joined on 2026-08-02: another Energica rider's
// `energica_can_mappings.xdbc`, which named 0x020, 0x022, 0x104, 0x120/0x121 and most
// of 0x102's bitfield. It is one owner's reverse engineering of a different bike, not a
// manufacturer document, so nothing from it was wired up without replaying a live
// capture through the decoder first — and where it contradicted something we had
// confirmed on this bike (0x102's blinkers), ours won. See the note on that case.
import { BMS_STREAM_IDS, decodeBmsFrame } from "./decode-bms.ts";
import { type DecodedValue, bit, bitsLe, i16le, u16le } from "./frame.ts";

export type { DecodedValue };

export function decodeFrame(id: number, data: Buffer): DecodedValue[] {
  switch (id) {
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

    // 0x020 — inverter temperatures, four u16 LE ÷10 °C (10 Hz).
    // Verified on the bike 2026-08-02: `0D 01 0D 01 0D 01 0D 01` → 26.9 °C on all
    // four, with OBD ambient reading 28 °C on a cold bike. The three IGBT fields were
    // identical in every frame of the capture; whether min/max ever separate from the
    // instantaneous reading needs load to say, hence 🟡 rather than ✅.
    //
    // The .xdbc calls these UNsigned. At the ~27 °C we verified, signed and unsigned
    // are the same bytes, so the capture cannot tell them apart. If a winter log ever
    // shows ~6500 °C here, that is a below-zero reading wrapping — they are s16 like
    // 0x022's motor temp, and this is the line to change.
    case 0x020: {
      if (data.length < 8) return [];
      return [
        { key: "igbt_temp_min", value: u16le(data[0], data[1]) / 10 },
        { key: "igbt_temp", value: u16le(data[2], data[3]) / 10 },
        { key: "igbt_temp_max", value: u16le(data[4], data[5]) / 10 },
        { key: "gate_temp", value: u16le(data[6], data[7]) / 10 },
      ];
    }

    // 0x022 — motor temperature: b4-5 LE s16 ÷10 °C (10 Hz). Verified 2026-08-02:
    // `00 00 00 00 11 01 00 00` → 27.3 °C, against OBD PID 05 reading 27 °C in the
    // same minute — two independent paths to the same number, at ten times the
    // resolution of the PID. ✅
    //
    // The other six bytes were all-zero across the whole capture. The .xdbc guesses at
    // them (u16 pairs it names V01/V23) but assigns no meaning, so they stay undecoded
    // rather than invented.
    case 0x022: {
      if (data.length < 6) return [];
      return [{ key: "motor_temp", value: i16le(data[4], data[5]) / 10 }];
    }

    // 0x104 — odometer / speed / RPM, little-endian and not byte-aligned (100 Hz).
    // The odometer is the one that's nailed down: `8D 99 02 00 …` → 170381 × 0.1 =
    // 17038.1 km against the Connectivity Hub's own BLE odometer of 17038 km, read
    // minutes apart. So ×0.1 km is right for this model. ✅
    // Speed and RPM read 0 on a parked bike, which is consistent but proves nothing
    // about their scale — only a ride can. 🟡
    //
    // These get their own keys instead of feeding speed_kmh / motor_rpm / odometer_km,
    // which come from the OBD poller and the BLE hub. One signal with two writers turns
    // any disagreement into a value that flaps on every frame instead of an obvious
    // decode error — and here the comparison is the point: this frame is 100 Hz where
    // the OBD poll is 2 Hz and whole-km/h, so the pair is worth watching.
    case 0x104: {
      if (data.length < 8) return [];
      return [
        { key: "odometer_can_km", value: data.readUInt32LE(0) / 10 },
        { key: "speed_can_kmh", value: bitsLe(data, 32, 13) / 10 },
        { key: "motor_rpm_can", value: bitsLe(data, 45, 15) },
        { key: "reverse_gear", value: bitsLe(data, 63, 1) },
      ];
    }

    // 0x109 — throttle plus the inverter's current limits, four u16 LE (100 Hz).
    //  • b0-1 ÷10 = throttle % (0 idle … 100). 🟡
    //  • b4-5 ÷10 read 120.0 A parked — exactly the allowed_regen_a the BMS publishes
    //    in 0x202, which is what pins the ÷10 scale. Signed negative here because the
    //    .xdbc marks the direction that way (regen flows opposite to drive); compare
    //    its magnitude, not its sign, against allowed_regen_a. ✅
    //  • b2-3 ÷10 read 10.0 A at the same moment the BMS was allowing 400 A of
    //    discharge, so this is the inverter's *currently* permitted output rather than
    //    the pack ceiling. Only ever seen at rest, so the scale is unconfirmed. 🟡
    //  • b6-7 is the .xdbc's unidentified "Current other" — 153.8 A parked under its
    //    scaling, matching nothing else on the bus. Logged so a ride can identify it. ❓
    case 0x109: {
      if (data.length < 2) return [];
      const values: DecodedValue[] = [{ key: "throttle_pct", value: u16le(data[0], data[1]) / 10 }];
      // Throttle stays behind its original 2-byte guard: it has been logged since June,
      // and the three fields added from the .xdbc must not be able to silence it.
      if (data.length >= 8) {
        values.push({ key: "current_max_out_a", value: u16le(data[2], data[3]) / 10 });
        values.push({ key: "current_max_regen_a", value: u16le(data[4], data[5]) / -10 });
        values.push({ key: "current_other_a", value: u16le(data[6], data[7]) / 10 });
      }
      return values;
    }

    // 0x120 / 0x121 — charge-current setpoint, u8 amps at b2, per the .xdbc, which
    // gives both frames the identical signal. NEITHER APPEARED in the 2026-08-02
    // capture (bike parked, not plugged in), so this is unverified on our bike: the
    // only time these IDs have been seen here at all is as a diagnostic
    // request/response pair during the 2026-07-26 ECU sweep. Recheck while charging,
    // and expect the value to line up with charge_limit_a from 0x10A b7 ÷7.
    //
    // Deliberately two keys for what the .xdbc calls one signal: a shared key would be
    // the only one in the codebase with two writers, so if the two frames ever
    // disagreed the value would flap every frame instead of showing an obvious fault.
    case 0x120: {
      if (data.length < 3) return [];
      return [{ key: "charge_setpoint_120_a", value: data[2] }];
    }

    case 0x121: {
      if (data.length < 3) return [];
      return [{ key: "charge_setpoint_121_a", value: data[2] }];
    }

    // 0x102 — vehicle state, lights and the accelerometers (100 Hz).
    //
    // ⚠️ THE BLINKERS ARE A KNOWN CONFLICT, AND OUR DECODE WINS. We found L/R blinker
    // at b2 0x04/0x08 by toggling them on the bike and diffing the log; the .xdbc puts
    // them at b0 bits 3/4 and calls b2 bits 2/3 "Unk4/Unk5". Both can be true — b0
    // would be the handlebar switch and b2 the lamp output — but only ours was measured
    // here, so it stands. The two files agree on horn and both brakes, which is a good
    // sign for the rest of b2. Do not "fix" this from the third-party file.
    //
    // Everything in b1 and the two b2 state bits below comes from the .xdbc and matched
    // a parked bike on 2026-08-02 (`80 10 02 44 …`): key_on 1, energized/go 0,
    // sidestand_up 0 (it's on the stand), charging 0, charge_port_unlocked 1 — the
    // .xdbc notes that one reads 1 whenever the bike is NOT charging. Self-consistent
    // at one operating point; a key-off / go / charging capture would confirm it. 🟡
    case 0x102: {
      if (data.length < 3) return [];
      const handlebar = data[0];
      const driveState = data[1];
      const lights = data[2];
      const values: DecodedValue[] = [
        { key: "high_beam", value: bit(handlebar, 6) },
        { key: "brake", value: lights & 0x60 ? 1 : 0 },
        { key: "blinker_left", value: bit(lights, 2) },
        { key: "blinker_right", value: bit(lights, 3) },
        { key: "horn", value: bit(lights, 4) },
        { key: "energized", value: bit(driveState, 1) },
        { key: "go_request", value: bit(driveState, 2) },
        { key: "go_active", value: bit(driveState, 3) },
        { key: "key_on", value: bit(driveState, 4) },
        { key: "sidestand_up", value: bit(driveState, 5) },
        { key: "ignition_button", value: bit(driveState, 6) },
        { key: "throttle_on", value: bit(driveState, 7) },
        { key: "charging", value: bit(lights, 0) },
        { key: "charge_port_unlocked", value: bit(lights, 1) },
        { key: "moving", value: bit(lights, 7) },
      ];

      // b4-5 / b6-7 LE s16 — lateral and frontal acceleration. UNITS UNKNOWN, so the
      // raw counts are logged as-is: the .xdbc says "g" but gives no scale, and we have
      // nothing to calibrate against. Two separate parked captures read roughly
      // -141…-125 lateral and -52…-40 frontal, which is the right shape for a bike
      // leaning on its sidestand, but that is a plausibility check, not a calibration.
      // Guarded rather than folded into the length check above so a short frame still
      // yields the light/brake bits, which are the ones we've actually confirmed.
      if (data.length >= 8) {
        values.push({ key: "accel_lateral_raw", value: i16le(data[4], data[5]) });
        values.push({ key: "accel_frontal_raw", value: i16le(data[6], data[7]) });
      }
      return values;
    }

    // 0x480 — E-LOCK / keyless status (10 Hz, present key-on/parked). b2-5 LE
    // uint32 = ID of the key fob currently present; it matches slot 1 of the 3
    // fobs paired in the E-LOCK ECU (b0 = 05, b6 = 01 constant). 🟡
    case 0x480: {
      if (data.length < 6) return [];
      return [{ key: "key_fob_id", value: data.readUInt32LE(2) }];
    }

    default:
      // Everything else is either a BMS frame or one we don't decode.
      return decodeBmsFrame(id, data);
  }
}

// CAN IDs we decode from the broadcast stream — used to set kernel RX filters, so an
// ID missing from here never reaches decodeFrame at all, however good its decoder is.
const VEHICLE_STREAM_IDS = [0x020, 0x022, 0x025, 0x102, 0x104, 0x109, 0x10a, 0x120, 0x121, 0x305, 0x306, 0x480];
export const STREAM_IDS = [...VEHICLE_STREAM_IDS, ...BMS_STREAM_IDS];
