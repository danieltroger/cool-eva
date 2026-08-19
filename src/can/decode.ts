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

import { ABS_CAN_ID, decodeAbsFrame } from "./abs.ts";
import { decodeAttitudeFrame } from "./attitude.ts";
import { CHARGE_SETPOINT_CAN_ID, decodeChargeSetpointFrame } from "./charge-setpoint.ts";
import { CONSUMPTION_CAN_ID, decodeConsumptionFrame } from "./consumption.ts";
import { BMS_STREAM_IDS, decodeBmsFrame } from "./decode-bms.ts";
import {
  DRIVE_TORQUE_CAN_ID,
  REDUNDANT_SPEED_CAN_ID,
  THROTTLE_SENSOR_CAN_ID,
  decodeDriveTorqueFrame,
  decodeRedundantSpeedFrame,
  decodeThrottleSensorFrame,
} from "./drive.ts";
import { type DecodedValue, bit, bitFieldLe, i16le, u16le } from "./frame.ts";
import { decodeGpsCanFrame, GPS_CAN_ID } from "./gps.ts";
import { PSU_CAN_ID, decodePsuFrame } from "./psu.ts";
import { VCU_FLAGS_CAN_ID, decodeVcuFlagsFrame } from "./vcu-flags.ts";

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

    // Seven frames added 2026-08-16, from Energica's own signal database (0x0A0, 0x02C, 0x100,
    // 0x10B, 0x501) and from the bus alone (0x125, 0x127). Every one of them was replayed against the
    // 2026-08-02 garage lap before being wired up, and each decoder carries its own evidence:
    // what the capture proves, which scalings are the manufacturer's word rather than a
    // measurement, and what is deliberately left undecoded. None of them is a one-liner's worth
    // of argument, which is why they are modules and this is only the routing.
    case ABS_CAN_ID:
      return decodeAbsFrame(data);

    case DRIVE_TORQUE_CAN_ID:
      return decodeDriveTorqueFrame(data);

    case THROTTLE_SENSOR_CAN_ID:
      return decodeThrottleSensorFrame(data);

    case REDUNDANT_SPEED_CAN_ID:
      return decodeRedundantSpeedFrame(data);

    case CONSUMPTION_CAN_ID:
      return decodeConsumptionFrame(data);

    case PSU_CAN_ID:
      return decodePsuFrame(data);

    // The rider's own charge-current limit off the dash. An EVENT, not a stream — see
    // charge-setpoint.ts, which is mostly about what that costs.
    case CHARGE_SETPOINT_CAN_ID:
      return decodeChargeSetpointFrame(data);

    case VCU_FLAGS_CAN_ID:
      return decodeVcuFlagsFrame(data);

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
    //
    // ⚠️ The bit layout is right; the NUMBER is the bike's, and the bike's is optimistic.
    // Against GPS over two 2026-08-04 road captures, `speed_can_kmh` reads +3.5 % and the
    // odometer accumulates +3.4 % — about +3.4 km/h at an indicated 100. `speed_can_kmh` is
    // exactly `motor_rpm_can` / 42.0, so it is geared driveline speed and not a wheel
    // measurement, whatever the dashboard labels it. Full working in src/can/abs.ts; do not
    // re-derive it against 0x104 itself, which is how the ABS scale went wrong.
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
    // (The b0 pair is real, and 2026-08-19 settled which of the two is which; it is
    // written down on handlebarButtons() below, along with why it stays undecoded.)
    //
    // 🚨 b2 bits 0 and 1 were `charging` and `charge_port_unlocked` until 2026-08-16.
    // THEY ARE THE BEAM LAMPS. Both names came off the .xdbc — a rider's file, not a
    // manufacturer database — and both were wrong. Do not restore them. The measurement,
    // over all 1 103 000 frames of 0x102 in the 14 candump captures:
    //
    //   b2 bit 0 vs b0 bit 6 (high beam):  1 103 000 / 1 103 000 agree, 0 disagreements
    //   b2 bit 1 vs b0 bit 7 (low beam):   1 103 000 / 1 103 000 agree, 0 disagreements
    //
    // Not an artefact of both being nearly constant, because the cross-pairs fall apart:
    // b2 bit 0 against b0 bit 7 agrees only 49.35 % of the time. And `charging` reads 0
    // through every real charge in the corpus — four AC sessions including 48 minutes at
    // 14 A, plus the DC session — while the bit it does track is the flash-to-pass.
    //
    // Energica's own VCU digital list, recovered from the service-tool executable, names
    // both families and separates them exactly the way this frame does:
    //
    //   V_HIGH_BEAM_SW, V_LOW_BEAM_SW, V_L_TURN_SW, V_R_TURN_SW …   ← the switches
    //   V_HIGH_BEAM,    V_LOW_BEAM,    V_LEFT_TURN, V_RIGHT_TURN …  ← the outputs
    //
    // So byte 0 is the switch byte and byte 2 the output byte, which is the same split
    // this file already worked out for the indicators from the wire alone — b0 bits 3/4
    // are 0.2 s presses while b2 bits 2/3 flash at 1.4 Hz. 🟡 For the beams that split is
    // not directly observable here: a beam switch and its lamp only differ when the bulb
    // is out, which is exactly why it is worth logging both.
    //
    // b2 now accounts for exactly, with no bit claimed twice: 0/1 beam lamps (measured
    // here, 2026-08-16), 2/3 blinkers (measured), 4 horn (measured), 5/6 brake
    // (measured), 7 moving (.xdbc).
    //
    // Everything in b1 comes from the .xdbc and matched a parked bike on 2026-08-02
    // (`80 10 02 44 99 FF D8 FF`): key_on 1, energized / go / go_request /
    // ignition_button / throttle_on 0, stand_up 0 (it is on the sidestand), moving 0,
    // low beam on. The garage lap that afternoon then caught energized, go_request, go,
    // stand_up, ignition_button, throttle_on and moving all toggling with the rider's
    // actions, so those are confirmed against real transitions rather than one parked
    // sample. ✅ key_on stayed 1 throughout both, so it rests on the parked sample alone
    // — a key-off capture is what would confirm it.
    //
    // b0's low bits and b3 are decoded below, both added 2026-08-16 — see the
    // comments on `handlebarButtons` and `contactorAndCruise` further down this case.
    case 0x102: {
      if (data.length < 3) return [];
      const handlebar = data[0];
      const vehicleState = data[1];
      const lampsAndState = data[2];
      const values: DecodedValue[] = [
        { key: "high_beam", value: handlebar & 0x40 ? 1 : 0 },
        // `brake` is front OR rear, and stays exactly that. It has logged since June,
        // grafana/dashboards/ride-summary.json selects it by name, and nothing is gained
        // by breaking either for a value the two keys below can be OR-ed back into.
        { key: "brake", value: lampsAndState & 0x60 ? 1 : 0 },
        // …and the two halves separately, added 2026-08-19 for the dashboard's buttons
        // section. They are NOT redundant with each other and must not be folded back
        // together: measured over all 14 650 573 frames of 0x102 in the archive, the
        // front bit accounts for 491 applications (median 2.24 s, longest 47.2 s) and
        // the rear 18 (median 0.46 s, longest 43.5 s) — and 1 899 frames carry both at
        // once, so neither implies the other in either direction.
        //
        // That 18 also closes a question abs.ts had to leave open. It records that the
        // rear bit "was never set once in the whole 545 k-frame capture", so that lap
        // could not tell `front_brake_pressure_bar` (0x0A0 b5) apart from a plain brake
        // pressure. The wider corpus has the rear bit firing on its own, and the owner
        // confirmed the other half on the bike on 2026-08-19: pressing the rear pedal
        // alone leaves 0x0A0 b5 at 0 bar while the front lever drives it to 5. So the
        // ABS pressure channel really is the FRONT circuit. 🟡 No rear equivalent is
        // KNOWN — neither this frame nor Energica's signal database names one — but that
        // is an absence in two documents, not a measurement, so `rear_brake` is the only
        // rear-brake signal there is to have rather than provably the only one there is.
        { key: "front_brake", value: bit(lampsAndState, 5) },
        { key: "rear_brake", value: bit(lampsAndState, 6) },
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
        // The beam OUTPUTS, as against `high_beam` above, which is b0's switch. Kept as
        // separate keys rather than folded into one: identical in every frame recorded
        // so far, and the day they differ is the day a bulb has failed.
        { key: "high_beam_lamp", value: bit(lampsAndState, 0) },
        { key: "low_beam_lamp", value: bit(lampsAndState, 1) },
        { key: "moving", value: bit(lampsAndState, 7) },
      ];
      values.push(...handlebarButtons(handlebar));
      // b3 needs its own guard: every b0-2 signal above has been logged since June and
      // a short frame must not be able to silence them on account of the new fields.
      if (data.length >= 4) {
        values.push(...contactorAndCruise(data[3]));
      }
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

    // 0x400 — the dashboard broadcasting its own digital inputs. Byte 2 is a button
    // bitfield; every other byte is either constant or a slow mode flag.
    //
    // Measured over 1 099 357 frames across 14 candump captures (2026-08-02 and
    // 2026-08-04; `~/Documents/cool-eva-archive`, see CAPTURES.md): b0 is `0x02` and
    // b1 is `0x01` in every single frame, b3/b4/b6/b7 are `0x00` in every single
    // frame, b5 only ever holds `0x00` or `0x80`, and b2 only ever holds `0x00`,
    // `0x02` or `0x04`. So the whole frame carries four static bytes, one slow flag
    // and this one button byte. ✅
    //
    // ⚠️ The bit NAMES are Energica's, not ours: they come from a free-frame IO table
    // inside the service-tool executable (obd-garage/HEATED_GRIPS.md §3.0), and that
    // table describes every model the tool serves rather than this one. A name off a
    // table is not a measurement — the `charging` key on 0x102 b2 bit 0 came off a
    // third-party table the same way and is really the high beam (src/vcu/service-gate.ts
    // spells that out; re-confirmed here, it moves on the same timestamps as high_beam in
    // every capture where either moves, and does not move at all in the four captures
    // containing a real charge). So each bit below carries what the captures show
    // about it, separately, and the ones the captures cannot speak to say so.
    case 0x400: {
      if (data.length < 3) return [];
      const buttons = data[2];
      return [
        // bit 0, `BUTTON [SET|BACK] (LeftBack)`. ❓ NEVER seen set — not in one frame
        // of the 1.1 M. Decoded on the vendor table's word alone, so the first press
        // is also the first evidence that the bit exists. If it stays 0 while the
        // button visibly works, the name or the bit is wrong.
        { key: "btn_set_back", value: bit(buttons, 0) },
        // bit 1, cruise ON/OFF (right pod, front). ✅ CONFIRMED by what it causes:
        // pressed exactly twice in the corpus (2026-08-04 18:04:42.270 for 0.877 s at
        // 88 km/h, and 19:45:47.924 for 0.920 s at 39 km/h) and BOTH times 0x102 b3
        // bit 1 — the cruise-armed state, see contactorAndCruise() — came up 0.53 s
        // later and stayed up for the next 51 s / 82 s. A bit that only ever moves
        // while riding and whose every press arms cruise control is the cruise button.
        //
        // ⚠️ …which also kills the plan HEATED_GRIPS.md §9 recommends it for. That
        // section calls a short press inert because the owner's manual says activation
        // needs a 3-second hold. It does not: both presses were under one second and
        // both armed cruise. This is NOT a side-effect-free button.
        { key: "btn_cruise_enable", value: bit(buttons, 1) },
        // bit 2, cruise SET SPEED. ✅ CONFIRMED by context: pressed exactly once in
        // the corpus, 2026-08-04 18:04:45.055 for 1.794 s — 2.8 s after cruise was
        // armed, at a steady 87.6 km/h, after which speed held 89-91 km/h for the
        // remaining 45 s of the arming. That is what setting a cruise speed looks
        // like, and there is no other press anywhere in 1.1 M frames to compete.
        { key: "btn_cruise_set", value: bit(buttons, 2) },
        // bit 3, `BUTTON [HEATED.GRP] (RightBack)`. ❓ Never set, which is EXPECTED
        // rather than evidence: this bike has no heated grips, and the wiring diagram
        // says the dashboard derives this bit by sensing +12 V on `Monitor_Heated
        // Knobs` (J8 pin 5), a wire that currently goes nowhere. Decoded anyway
        // because it is the readout for HEATED_GRIPS.md §7.0 — jumper J109a pin 1 to
        // pin 3 and this is the signal that says whether the idea works.
        { key: "btn_heated_grip", value: bit(buttons, 3) },
      ];
    }

    default:
      // Everything else is either a BMS frame or one we don't decode.
      return decodeBmsFrame(id, data);
  }
}

// 0x102 byte 0's low bits — the left pod's momentary buttons, as VCU discretes.
//
// Added 2026-08-16. These four are the ones Energica's free-frame table names
// `Left/Right/Enter Mode Switch` and `RST Switch`. Bits 3 and 4 are the indicator
// switches and are still left undecoded on purpose — see below, which now also records
// which of the two is which, settled 2026-08-19.
//
// Of the other two: bit 6 is `high_beam`, read in the case above (set in 137 of the
// 1 103 000 frames — it is a flash-to-pass, which is what the dashboard's own gesture
// counts). Bit 7 is the LOW BEAM SWITCH, set in 50.64 % of frames — settled on
// 2026-08-16 by the byte-2 work above, since it agrees with b2 bit 1 in all 1 103 000
// frames and Energica's own list pairs `V_LOW_BEAM_SW` with `V_LOW_BEAM`. It gets no
// key of its own: `low_beam_lamp` already carries the same information and a third
// beam key earns nothing. Named here so the next person does not re-derive it.
//
// Evidence is 1 103 000 frames of 0x102 across the same 14 captures as 0x400. What
// makes these more than "the bit moves" is that the six low bits split cleanly into
// two behaviours, and the split is the one the owner's manual predicts:
//
//   bit  presses  median  pressed above 3 km/h
//   0     76      0.140 s     0 / 76     ← menu: the manual says the menu is locked
//   1    141      0.120 s     4 / 141      out above 3 km/h, so it can only be
//   2     40      0.131 s     0 / 40       operated stationary, and it is
//   3     41      0.210 s    41 / 41     ← indicators: only ever used while riding
//   4     24      0.180 s    23 / 24
//   5     63      0.181 s    63 / 63
//
// Nothing about "a bit toggles" forces that pattern; it is what a speed-locked menu
// and a set of turn signals actually look like, from opposite ends of the same byte.
function handlebarButtons(handlebar: number): DecodedValue[] {
  return [
    // bits 0 and 1 — the MODE pair. ✅ CONFIRMED as menu buttons (76 of 76 presses at
    // a standstill for bit 0, 137 of 141 for bit 1, both transient at ~0.13 s).
    // 🟡 WHICH IS WHICH IS NOT CONFIRMED. Both do the same thing to the same menu, so
    // no recorded ride can separate ◀ from ▶; the left/right split here is Energica's
    // table's word and nothing else. If they turn out swapped, swap these two keys —
    // no other claim in this file depends on the order.
    { key: "btn_mode_left", value: bit(handlebar, 0) },
    // ⚠️ bit 1 has two behaviours bit 0 does not, and neither is explained. Two
    // presses at 88 km/h on 2026-08-04 (18:04:44.975 and 18:04:46.005, 0.81 s each)
    // straddle the cruise SET SPEED press on 0x400, and it was held HIGH for 191
    // seconds on 2026-08-04 21:00:31 while the bike was AC charging. A momentary menu
    // button should do neither. Treat bit 1 as the less trustworthy of the pair.
    { key: "btn_mode_right", value: bit(handlebar, 1) },
    // bit 2 — MODE ENTER. ✅ The cleanest of the three: 40 presses, all 0.08-0.29 s,
    // every one below 3 km/h, no outliers at all.
    { key: "btn_mode_enter", value: bit(handlebar, 2) },
    // bits 3 and 4 are the turn-indicator SWITCHES, and are still not decoded here —
    // but which side is which is no longer an open question, so it is written down.
    //
    // 🚨 BIT 3 IS RIGHT AND BIT 4 IS LEFT, the opposite of the .xdbc's order, which
    // puts them left-then-right. Measured 2026-08-19 over all 14 650 573 frames of
    // 0x102 in the 248 captures in ~/Documents/cool-eva-archive, by taking every rising
    // edge of each switch and asking which blinker lamp (b2 bits 2/3) was dark in the
    // 3 s before it and lit in the 3 s after:
    //
    //   b0 bit 3, 464 presses → started the RIGHT lamp 437×, the left lamp 5×
    //   b0 bit 4, 361 presses → started the LEFT  lamp 328×, the right lamp 2×
    //
    // The remaining 53 started nothing: 47 changed no lamp at all and 6 stopped one,
    // which is what a cancelled thought and a re-press look like. Two consecutive
    // frames, 10 ms apart on 2026-08-02 at 21:05:47, make the same point with no
    // statistics at all:
    //
    //   .339152  88 BE 82 04 FA FF 34 00   ← b0 bit3 down, b2 has no blinker bit
    //   .349109  88 BE 8A 04 FA FF 28 00   ← next frame, b2 bit3 (RIGHT lamp) lit
    //
    // Do not "fix" this from the third-party file. The case comment at 0x102 above says
    // the same thing about the blinker bytes, for the same reason, and that file was
    // already caught calling the high beam `charging`.
    //
    // They stay undecoded because nothing reads them: the dashboard's buttons section
    // was given the LAMPS (`blinker_left` / `blinker_right`, b2 bits 2/3) on 2026-08-19,
    // since what a rider means by "is my indicator on" is the lamp and not the thumb.
    // Two more keys would put four tiles on screen for two indicators. If something ever
    // wants the switches — telling a failed bulb from a missed press is the obvious one
    // — they are `bit(handlebar, 3)` for right and `bit(handlebar, 4)` for left, and the
    // measurement above is the evidence.
    //
    // bit 5 — the indicator-cancel press (push the turn switch in). ✅ CONFIRMED, and
    // this is the strongest identification of the seven: all 63 presses happened with
    // an indicator lamp actually flashing, 63 out of 63, and in 28 of them the lamp
    // stopped within 3 s. Indicators were running for a few hundred seconds out of
    // hours of capture, so 63/63 is not a coincidence. The 41 + 24 = 65 indicator
    // switch presses on bits 3/4 against 63 cancels is the same story counted twice.
    { key: "btn_indicator_cancel", value: bit(handlebar, 5) },
  ];
}

// 0x102 byte 3 — the fast-charge contactor monitor and the cruise-control state.
//
// Added 2026-08-16. This byte was written off as "a constant 0x44" when 0x102 was
// first decoded, which is true of a parked bike and false of a charging one: across
// the 14 captures it takes five values — 0x44 (88.4 %), 0x45 (9.4 %), 0x46 (1.2 %),
// 0x04 (1.0 %) and 0x06 (0.02 %). Bit 2 is set in all five and is never once clear in
// 1 103 000 frames, so it is left undecoded rather than logged as a constant 1. Bit 6
// moves constantly and is not understood; bits 3, 4, 5 and 7 are never set.
function contactorAndCruise(byte3: number): DecodedValue[] {
  return [
    // bit 0 — `V_FASTDC_MON_SW`, the DC fast-charge contactor state monitor, and the
    // analog wire `A020_FCHG_MON` it corresponds to. ✅ CONFIRMED, and it is the
    // best-evidenced bit in this change:
    //
    //   • Set in EXACTLY ONE interval in the whole corpus — 2026-08-04 19:58:45.489 →
    //     20:16:03.587, 1038.1 s, which is 103 790 of the 1 103 000 frames. Zero
    //     everywhere else: all riding, all parking, all key-off.
    //   • That interval is a DC fast charge, from the pack's own frames: 0x200 shows
    //     current going from −0.1 A to +63.2 A within 4.6 s of the rise, and SOC
    //     climbing 30 % → 42 % over the window. No 0x305/0x306 appear at all, which is
    //     right — a DC charger bypasses the onboard AC charger that sends them.
    //   • It leads the charge: it rises 190 ms before `charger_enabled` (0x300 byte 0)
    //     and ~470 ms before the first positive pack amp. A contactor monitor should
    //     lead, because the contactor closes before anything can flow through it.
    //   • It reads 0 through every AC charge in the corpus — four separate sessions,
    //     one of them 48 minutes at 14 A mains. So it discriminates DC from AC rather
    //     than just meaning "plugged in", which is the whole reason to want it.
    { key: "fast_dc_contactor", value: bit(byte3, 0) },
    // bit 1 — cruise control armed. 🟡 Not in any vendor table; inferred here, and
    // inferred from exactly two events, which is why it keeps the 🟡. Both are clean:
    // it came up 0.525 s and 0.546 s after the only two presses of `btn_cruise_enable`
    // on 0x400, held for 51.4 s and 82.3 s, and never moved otherwise. It is logged
    // because it is the evidence for those two buttons — with this on the dashboard
    // the owner can press cruise ON/OFF and watch the state follow, which is the check
    // that would otherwise need a laptop and candump.
    { key: "cruise_active", value: bit(byte3, 1) },
  ];
}

// CAN IDs we decode from the broadcast stream — used to set the kernel RX filters, so
// an ID missing here never reaches decodeFrame at all, however good its decoder is.
// 0x121 joined on 2026-08-19 and is the one entry here that is NOT periodic. It fires when
// the rider moves the charge-current dial and never otherwise, so it costs nothing to
// filter in — 298 frames of it in the entire 16 GB archive, of which 18 are the DC limit
// changes charge-setpoint.ts decodes and the rest is other dash traffic. It also cannot be
// found by watching for a while, which is why it sat unfiltered for so long: the note this
// replaces said "neither appeared in 40 s of live capture (parked, unplugged), so there is
// nothing yet to decode", and that was true and permanently unfixable by looking harder.
// You have to be changing the current while capturing. 0x120, its truncated request twin,
// stays out — it carries no ceiling, and it is the id this project transmits the RTC sync on.
//
// ⚠️ This list is the single easiest thing in the project to get silently wrong, because a
// missing entry has no symptom: the decoder is fine, the tests pass, and the signal simply
// never appears. It has already happened once — 0x400 was being dropped here while a decoder
// waited for it. `scripts/check-can-decoders.ts` now closes that hole from the other side: it
// probes decodeFrame across the whole 11-bit ID space and fails the build if any ID that
// answers is missing from STREAM_IDS. Add a decoder without adding it here and `npm test`
// says so.
//
// The seven IDs behind named constants were added 2026-08-16; the constants come from the same
// modules as their decoders so the two cannot drift apart by a typo.
//
// 0x400 joined on 2026-08-16 and is the one entry here that costs something. It is
// the highest-frame-rate ID on this bus and it carries almost no information: its
// payload changed six times in 1 099 357 frames. Worse, the rate is padding — every
// one of the 77 355 sub-7 ms gaps measured in one capture repeated the previous
// frame's eight bytes EXACTLY, with no exceptions, and the frame count per second
// swings between 0.8× and 1.2× of 0x102's steady 100 Hz depending on what the
// dashboard is doing (80 Hz through the DC charge, ~120 Hz while riding). So this
// buys ~100 RX wakeups a second on a Pi Zero for a button byte, plus four record()
// calls per frame. It is worth it only because the buttons cannot be read any other
// way, and log-on-change means an unpressed button still writes exactly one row per
// boot.
//
// 🚨 If that ever does show up on the Pi, the obvious lever — skip a frame whose
// payload is identical to the last one seen for that id — is a trap, so it is written
// down here rather than discovered the expensive way. record() is what refreshes
// liveState[key].ts and lastSeenMonotonic, and it is deliberately outside the deadband
// branch for exactly that reason (see signals.ts). Skip the repeats and a button that
// nobody is pressing stops being refreshed: the dashboard greys its tile out as stale
// and ageMs() reports it as missing, on a bike where "this signal stopped arriving" is
// a real diagnosis we do not want to fake.
const VEHICLE_STREAM_IDS = [
  0x020,
  0x022,
  0x025,
  DRIVE_TORQUE_CAN_ID,
  ABS_CAN_ID,
  VCU_FLAGS_CAN_ID,
  0x102,
  0x104,
  0x109,
  0x10a,
  CONSUMPTION_CAN_ID,
  CHARGE_SETPOINT_CAN_ID,
  REDUNDANT_SPEED_CAN_ID,
  THROTTLE_SENSOR_CAN_ID,
  0x305,
  0x306,
  0x400,
  GPS_CAN_ID,
  0x480,
  PSU_CAN_ID,
];
export const STREAM_IDS = [...VEHICLE_STREAM_IDS, ...BMS_STREAM_IDS];
