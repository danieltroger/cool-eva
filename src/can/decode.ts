// Pure per-frame decoders for the Energica broadcast frames we log. Each decoder
// takes one frame's bytes and returns the (signal key, value) pairs it carries;
// unknown IDs return []. No I/O, no clock reads, no cross-frame state — that's what
// makes them testable by replaying a capture when the bike is out of reach. Two frames
// can't be stateless and neither keeps its state here: 0x410, where a GPS fix spans
// three sub-frames (gps.ts), and 0x102's attitude pair, whose out-of-range warning fires
// once per axis per process rather than at the frame rate (attitude.ts). This file only
// routes to both, and each exports a reset so replaying a second capture starts clean.
//
// The frames below are reverse-engineered from the wire and cross-checked against the
// bike's engineering menu (see obd-garage/CAN_MAP.md). The BMS's own frames are a
// different story — they come from its decrypted config file, so they live in
// decode-bms.ts and this file just hands unmatched IDs over.
//
// A third source joined on 2026-08-02: another rider's `energica_can_mappings.xdbc`,
// which names 0x020, 0x022, 0x104 and most of 0x102's bitfield. It is one owner's
// reverse engineering of a different bike, not a manufacturer document, so nothing
// from it is wired up here without a live capture replayed through the decoder first,
// and where it contradicts something measured on this bike (0x102's blinkers) ours
// wins. Confidence markers below and in obd-garage/CAN_MAP.md say which is which.

import { decodeAttitudeFrame } from "./attitude.ts";
import { BMS_STREAM_IDS, decodeBmsFrame } from "./decode-bms.ts";
import { type DecodedValue, bit, bitFieldLe, i16le, u16le } from "./frame.ts";
import { decodeGpsCanFrame, GPS_CAN_ID } from "./gps.ts";

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

    // 0x020 — inverter temperatures, four s16 LE ÷10 °C (10 Hz).
    // Captured 2026-08-02 parked: `10 01 10 01 10 01 10 01` → 27.2 °C on all four,
    // against OBD ambient 28 °C on a cold bike. The three IGBT fields moved together
    // (26.9…28.0 °C over 40 s) while the gate field held 27.2 °C throughout, which is
    // what separates the fourth channel from the first three. A garage lap later the
    // same day put load on them: the IGBT channel rose 27.5 → 38.1 °C while the gate
    // rose 27.4 → 30.0 °C, so the two are decidedly different measurements and the
    // IGBT one is the most responsive thermal signal on the bike. min/inst/max still
    // never separated from each other, so their order among themselves is a guess. 🟡
    //
    // The .xdbc calls all four unsigned; they are read signed anyway. Every real
    // temperature from 0…3276.7 °C decodes identically either way, so signed cannot
    // regress anything, and a below-zero reading is right instead of wrapping to
    // ~6553 °C — which the 0.5 °C deadband would happily log all winter, wrecking the
    // axis of any panel these share with the s16 motor temperature from 0x022.
    case 0x020: {
      if (data.length < 8) return [];
      return [
        { key: "inverter_igbt_min_c", value: i16le(data[0], data[1]) / 10 },
        { key: "inverter_igbt_c", value: i16le(data[2], data[3]) / 10 },
        { key: "inverter_igbt_max_c", value: i16le(data[4], data[5]) / 10 },
        { key: "inverter_gate_c", value: i16le(data[6], data[7]) / 10 },
      ];
    }

    // 0x022 — motor temperature: b4-5 LE s16 ÷10 °C (10 Hz). Captured 2026-08-02:
    // `00 00 00 00 13 01 00 00` → 27.5 °C, against OBD PID 05 reading 27 °C in the
    // same minute. ✅
    //
    // Those two numbers agreeing at rest made it look like PID 05 was this same sensor
    // at coarser resolution. The garage lap that afternoon showed it is not: under load
    // PID 05 rose 27 → 30 °C in step with 0x020's inverter gate channel, while this one
    // moved 27.9 → 28.5 °C. They are separate sensors that happen to sit at ambient on
    // a cold bike, which is why this gets its own key.
    //
    // The other six bytes read all-zero across the whole capture. The .xdbc splits
    // them into u16 pairs but assigns no meaning, so they stay undecoded rather than
    // invented.
    case 0x022: {
      if (data.length < 6) return [];
      return [{ key: "motor_temp_c", value: i16le(data[4], data[5]) / 10 }];
    }

    // 0x104 — odometer / speed / rpm, LE and not byte-aligned (100 Hz).
    //
    // The odometer is the solid part: `8D 99 02 00 …` → 170381 × 0.1 = 17038.1 km. ✅
    // It gets its own key rather than overwriting the BLE hub's `odometer_km`, because
    // the bike publishes three odometer-ish numbers and they do not all agree. Read
    // within the same minute on 2026-08-02, parked: CAN 17038.1 km · BLE `odometer_km`
    // 17038 km · OBD PID 31 `dist_since_clear_km` 17042 km. So CAN and BLE agree to
    // within their resolution and PID 31 sits 4 km above both — which is what you'd
    // expect, since PID 31 counts distance since the last DTC clear rather than
    // lifetime distance, and evidently started from a non-zero odometer. Keeping them
    // as separate signals means a ride can settle it; merging them would just make one
    // value flap between writers.
    //
    // Speed and rpm read 0 for the whole parked capture, so the offsets below started
    // as the .xdbc's word alone. A garage lap on 2026-08-02 (545k frames, full bus,
    // OBD polling in the same file) settled them against ground truth: ✅
    //
    //   5F 00 32 00 → speed 95  → 9.5 km/h  (OBD PID 0D: 10)   rpm 400 (PID 0C: 411)
    //   67 00 36 00 → speed 103 → 10.3 km/h (OBD PID 0D: 10)   rpm 432 (PID 0C: 427)
    //
    // Both track their PIDs to within ~1-2 % across the lap, which fixes speed as a u13
    // at bit 32 and rpm as a u15 at bit 45. rpm's start bit in particular is pinned to
    // the bit: 44 would decode 800/864 and 46 would decode 200/216 against a PID reading
    // 411/427, so only 45 reproduces it. The reverse bit is real as well: b7 = 0x80 on
    // 1122 frames, with 0x40 on another 406 belonging to the tachometer field at bits
    // 60-62. So the .xdbc's own C fragment (`data[4] | (data[5] << 7)` — a shift of 7,
    // not 8) is the thing that doesn't reconcile, not the normalised layout used here.
    //
    // The lap only reached ~10 km/h / ~430 rpm, so the top of both fields was never
    // exercised — but that residual announces itself instead of hiding. 200 km/h needs
    // 11 of speed's 13 bits and 11 000 rpm needs 14 of rpm's 15, so bits 43/44 and 59
    // can never be set by the quantity itself. If something else lives there the value
    // is impossible rather than plausible: speed jumps by 204.8 or 409.6 km/h, rpm by
    // 16 384. Seeing either is the signal that the field is narrower than assumed.
    case 0x104: {
      if (data.length < 8) return [];
      return [
        { key: "odometer_can_km", value: data.readUInt32LE(0) / 10 },
        { key: "speed_can_kmh", value: bitFieldLe(data, 32, 13) / 10 },
        { key: "motor_rpm_can", value: bitFieldLe(data, 45, 15) },
        { key: "reverse_gear", value: bitFieldLe(data, 63, 1) },
      ];
    }

    // 0x109 — throttle plus the inverter's current limits, four u16 LE (100 Hz).
    //  • b0-1 ÷10 = throttle % (0 idle … 100). 🟡
    //  • b4-5 read 1200 parked → 120.0 A, exactly the `allowed_regen_a` the BMS
    //    publishes in 0x202 at the same moment. That agreement is what pins the ÷10
    //    scale for all three fields. ✅ The .xdbc marks regen as flowing the other way
    //    and so gives it a negative scale; it is logged positive here to match
    //    `allowed_regen_a`, the signal it was validated against — one physical
    //    quantity under two keys with opposite signs plots as mirror images and makes
    //    a difference-of-the-two check read 240 instead of 0.
    //  • b2-3 read 100 → 10.0 A while the BMS was allowing 386.7 A of discharge, so
    //    this is the inverter's currently permitted output rather than the pack
    //    ceiling. Only ever seen at rest, so unverified against ground truth. 🟡
    //  • b6-7 is the .xdbc's unidentified "Current other" — 153.8 A parked under that
    //    scaling, matching nothing else on the bus. Logged so a ride can identify it. ❓
    case 0x109: {
      if (data.length < 2) return [];
      // Throttle keeps its original 2-byte guard: it has been logged since June and a
      // short frame must not be able to silence it on account of the new fields.
      const values: DecodedValue[] = [{ key: "throttle_pct", value: u16le(data[0], data[1]) / 10 }];
      if (data.length >= 8) {
        values.push(
          { key: "current_max_out_a", value: u16le(data[2], data[3]) / 10 },
          { key: "current_max_regen_a", value: u16le(data[4], data[5]) / 10 },
          { key: "current_other_a", value: u16le(data[6], data[7]) / 10 }
        );
      }
      return values;
    }

    // 0x102 — body/lights, vehicle state and the attitude angles (100 Hz).
    //
    // b0 bit6 (0x40) = high beam (bit7 0x80 = low beam). b2 mixes lamps and state: 0x04
    // L blinker, 0x08 R blinker, 0x10 horn, 0x20 front brake, 0x40 rear brake. Those
    // five were found by working the switches on this bike and diffing the log. ✅
    //
    // ⚠️ The blinkers are a known conflict with the .xdbc, which puts L/R at b0 bits
    // 3/4 and calls b2 bits 2/3 unknown. Both can be true — b0 the handlebar switch,
    // b2 the lamp output — but only ours was measured here, so ours stands and the
    // .xdbc is not allowed to overwrite it. Do not "fix" this from the third-party file.
    //
    // What settles it is that b2 now accounts for exactly, with no bit claimed twice:
    // 0/1 charge (.xdbc), 2/3 blinkers (measured here), 4 horn (measured), 5/6 brake
    // (measured), 7 moving (.xdbc). Two independent reverse-engineering efforts
    // interlocking across one byte with no gaps and no collisions is good evidence the
    // .xdbc's b2 assignments really do belong to this frame — and it refutes its own
    // claim that bits 2/3 are unknown, since there is nowhere else for them to go.
    //
    // Everything in b1 plus the three b2 state bits comes from the .xdbc and matched a
    // parked bike on 2026-08-02 (`80 10 02 44 99 FF D8 FF`): key_on 1, energized / go /
    // go_request / ignition_button / throttle_on 0, stand_up 0 (it is on the sidestand),
    // charging 0, moving 0, charge_port_unlocked 1. The garage lap that afternoon then
    // caught energized, go_request, go, stand_up, ignition_button, throttle_on and
    // moving all toggling with the rider's actions, so those are confirmed against real
    // transitions rather than one parked sample. ✅ key_on stayed 1 throughout both, so
    // it rests on the parked sample alone — a key-off capture is what would confirm it.
    //
    // ⚠️ charge_port_unlocked is the exception and keeps the 🟡: the only capture of it
    // is `charging` 0 / this bit 1, and the .xdbc says it reads 1 whenever the bike is
    // NOT charging — which is also exactly what bit 0 inverted looks like. Nothing seen
    // so far separates "port lock sensor" from "complement of `charging`", so do not
    // treat it as an actuator state (e.g. whether the port is safe to open) until it
    // has been watched across a plug-in. If it drops to 0 the instant `charging` goes
    // to 1, it is the complement and the key should be renamed.
    //
    // b3 read a constant 0x44 and stays undecoded — the .xdbc only guesses at it.
    case 0x102: {
      if (data.length < 3) return [];
      const handlebar = data[0];
      const vehicleState = data[1];
      const lampsAndState = data[2];
      const values: DecodedValue[] = [
        { key: "high_beam", value: handlebar & 0x40 ? 1 : 0 },
        { key: "brake", value: lampsAndState & 0x60 ? 1 : 0 },
        { key: "blinker_left", value: lampsAndState & 0x04 ? 1 : 0 },
        { key: "blinker_right", value: lampsAndState & 0x08 ? 1 : 0 },
        { key: "horn", value: lampsAndState & 0x10 ? 1 : 0 },
        { key: "energized", value: bit(vehicleState, 1) },
        { key: "go_request", value: bit(vehicleState, 2) },
        { key: "go", value: bit(vehicleState, 3) },
        { key: "key_on", value: bit(vehicleState, 4) },
        { key: "stand_up", value: bit(vehicleState, 5) },
        { key: "ignition_button", value: bit(vehicleState, 6) },
        { key: "throttle_on", value: bit(vehicleState, 7) },
        { key: "charging", value: bit(lampsAndState, 0) },
        { key: "charge_port_unlocked", value: bit(lampsAndState, 1) },
        { key: "moving", value: bit(lampsAndState, 7) },
      ];
      // b4-5 / b6-7 LE s16 — the attitude sensor's roll and pitch, in units of 0.1°.
      // NOT the two accelerations the .xdbc calls them: Energica's own bank-2
      // `AttitudeSensor_Phi` reads the same bytes on the side stand, and the values sit
      // on an arctangent lattice that a scaled count cannot produce. attitude.ts has the
      // full argument, the sign conventions, what is still only inferred, and the
      // warning for a count outside the ±180.0° an atan2 can reach. It applies
      // its own length guard, so a short frame still yields the light and brake bits,
      // which are the confirmed ones.
      values.push(...decodeAttitudeFrame(data));
      return values;
    }

    // 0x410 — the Connectivity Hub's own message stream, mirrored onto CAN with the
    // same framing it uses over BLE (b0 = message type, b1 = sub-index). Carries the
    // GPS multiplex at ~1.8 Hz unsolicited, which is the whole reason position no
    // longer depends on the Bluetooth link. Decoded in gps.ts because a fix spans
    // three sub-frames. ✅ framing and rate confirmed on the bus; the payload is
    // all-zero in the garage, so the coordinates themselves are still BLE-verified
    // only. (The old note that b4 here is a high-beam switch was reading one byte of
    // this multiplex; 0x102 is the real lights frame and already supersedes it.)
    case GPS_CAN_ID:
      return decodeGpsCanFrame(data);

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

// CAN IDs we decode from the broadcast stream — used to set the kernel RX filters, so
// an ID missing here never reaches decodeFrame at all, however good its decoder is.
// 0x120/0x121 are deliberately absent: the .xdbc lists them as charge-current
// setpoints, but neither appeared in 40 s of live capture (parked, unplugged), so
// there is nothing yet to decode. See obd-garage/CAN_MAP.md.
const VEHICLE_STREAM_IDS = [0x020, 0x022, 0x025, 0x102, 0x104, 0x109, 0x10a, 0x305, 0x306, GPS_CAN_ID, 0x480];
export const STREAM_IDS = [...VEHICLE_STREAM_IDS, ...BMS_STREAM_IDS];
