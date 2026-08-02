// Pure per-frame decoders for the Energica broadcast frames we log. Each decoder
// takes one frame's bytes and returns the (signal key, value) pairs it carries;
// unknown IDs return []. No I/O, no clock reads, no cross-frame state — that's what
// makes them testable by replaying a capture when the bike is out of reach.
//
// The frames below are reverse-engineered from the wire and cross-checked against the
// bike's engineering menu (see obd-garage/CAN_MAP.md). The BMS's own frames are a
// different story — they come from its decrypted config file, so they live in
// decode-bms.ts and this file just hands unmatched IDs over.

import { BMS_STREAM_IDS, decodeBmsFrame } from "./decode-bms.ts";
import { type DecodedValue, u16le } from "./frame.ts";

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

    default:
      // Everything else is either a BMS frame or one we don't decode.
      return decodeBmsFrame(id, data);
  }
}

// CAN IDs we decode from the broadcast stream — used to set kernel RX filters.
export const STREAM_IDS = [0x025, 0x102, 0x109, 0x10a, 0x305, 0x306, 0x480, ...BMS_STREAM_IDS];
