// The charge manager — CAN 0x600, 0x605, 0x610, 0x615, 0x620, 0x625.
//
// This ECU is only on the bus while a charge cable is live, which is why none of it was decoded
// until 2026-08-19: every parked sweep found silence. It is NOT DC-only — the whole group
// broadcasts on AC too, and AC is where most of the corpus is, so the AC-vs-DC contrast is what
// identifies these bytes. 0x625 is the exception and broadcasts whenever the bike is awake.
//
// ⚠️ Three of these frames are the VCU talking TO the charge manager, not the CM reporting.
// Energica's factory DBC names signals `V_*` when the VCU transmits and `CM_*` when the charge
// manager does, which settles the direction of the whole group:
//
//     0x600 CM_WD       CM → bus     0x615 V_CM_CHG      VCU → CM   ← a REQUEST, not a reading
//     0x605 V_CM_COM    VCU → CM     0x620 CM_EVSE_FDB   CM → VCU
//     0x610 CM_V_COM    CM → VCU     0x625 VCU_CM_LIMIT  VCU → CM
//
// **`docs/charge-manager.md` is where this subsystem's findings live** — the factory
// cross-check, every match rate, every refuted hypothesis, the reasoning behind each gate, and
// the four frames in this group that are decoded nowhere (0x630/0x631/0x635/0x645). Read it
// before changing anything here. The comments below are the one sentence per byte that a reader
// at that line needs; two of them contradict a factory name and say so.
//
// Every figure quoted here is over 29 charge sessions (18 AC, 11 DC, 2026-06-14 → 2026-08-09) in
// ~/Documents/cool-eva-archive, counted at full frame rate over every raw frame, deduplicated on
// (timestamp, id, payload). ⚠️ Percentages written before 2026-08-20 came from a scanner that
// emitted a row per payload CHANGE plus a keepalive, which over-represents edges; several moved
// when they were recounted. Re-derive rather than quote if a number is load-bearing.

import { bit, i16le, u16le, type DecodedValue } from "./frame.ts";

/** 0x605 `V_CM_COM` — VCU → CM: charge mode, inlet lock, and the IMD disable command. */
export const CHARGE_BMS_COMMAND_CAN_ID = 0x605;
/** 0x610 `CM_V_COM` — CM → VCU: the state machine and the fault code. */
export const CHARGE_STATE_CAN_ID = 0x610;
/** 0x615 `V_CM_CHG` — VCU → CM: the DC request (target volts, target amps, reported SOC). */
export const CHARGE_TELEMETRY_CAN_ID = 0x615;
/** 0x620 `CM_EVSE_FDB` — CM → VCU: what the station currently offers. */
export const CHARGE_LIMITS_CAN_ID = 0x620;
/** 0x625 `VCU_CM_LIMIT` — VCU → CM: the vehicle's own configured limits. Broadcast when parked. */
export const CHARGE_CONFIG_CAN_ID = 0x625;

export const CHARGE_MANAGER_CAN_IDS = [
  CHARGE_BMS_COMMAND_CAN_ID,
  CHARGE_STATE_CAN_ID,
  CHARGE_TELEMETRY_CAN_ID,
  CHARGE_LIMITS_CAN_ID,
  CHARGE_CONFIG_CAN_ID,
];

// 0x610 b4-6 is `TMS_Version`, and 0xF1 is the only byte of it shared with the one other bike
// this has been read on (ours F1 05 01, theirs F1 04 60). Gating on all three decoded the ECU on
// exactly one motorcycle; gating on b4 alone still rejects every dead-sender shape
// check-can-decoders.ts sweeps with, on any bike. See docs/charge-manager.md §0x610.
const CHARGE_MANAGER_FAMILY_BYTE = 0xf1;

/**
 * Decodes one charge-manager frame. Pure: bytes in, values out.
 *
 * Callers route by id; ids this ECU does not own return [].
 */
export function decodeChargeManagerFrame(id: number, data: Buffer): DecodedValue[] {
  switch (id) {
    // 0x605 `V_CM_COM` — what the VCU tells the charge manager about the session in progress.
    //
    // b3 copies b2 and b4-6 are 00, both in 100.000 % of 967 865 frames, so only b2 is emitted.
    // b0 is four factory fields (ready / lock control / lock set / a 2-bit mode) and is left
    // undecoded because b2 is a whole-byte echo of the mode: (b0 >> 3) & 3 equals b2 in 99.822 %,
    // and no frame has the two naming DIFFERENT modes. b1 is `V_EV_ERROR`, 0 in every frame.
    //
    // ⚠️ The only frame in the group with no invariant gate, and that is measured rather than
    // preferred: the bus itself sends a completely zero 0x605 payload 126 times in the archive,
    // so any gate catching that shape would drop real frames. Tolerable here because the
    // all-zero decode is FAIL-SAFE — "no path live", "isolation monitor running" — and because
    // bounds.js catches all-ones. 0x620's all-zero decode claims two ceilings, which is why that
    // one is gated and this is not.
    case CHARGE_BMS_COMMAND_CAN_ID: {
      if (data.length < 8) return [];
      return [
        // ✅ b2 = which charge path the session is on: 1 = AC, 2 = DC. 99.991 % of the 151 200
        // frames where DC current flows read 2.
        //
        // ⚠️ A property of the SESSION, not of current flowing. In the aborted DC attempt of
        // 2026-08-09 14:42 it reads 2 for the whole 155 s while not one amp moves. For "is
        // charge actually flowing", use dc_charging / ac_charging below.
        { key: "charge_type", value: data[2] },
        // ✅ b7 = `V_IMD_DISABLE`: the VCU commanding the insulation monitor off, which is the
        // factory name almost verbatim. Direction nuance — this is the vehicle COMMANDING, not
        // the BMS reporting (BMS memory 2122). 1 while 0x645 says a DC session exists in
        // 99.933 % of 156 931 frames; 0 while it does not in 100.000 % of 810 934. The monitor
        // cannot run against a station-driven DC bus, so the vehicle switches it off for exactly
        // the duration of a DC session.
        //
        // ❌ The DBC also places this at 0x102 bit 27. Not on this bike: that bit is clear in all
        // 15 716 143 frames of 0x102. `fast_dc_contactor` (0x102 b3 bit 0) is the bit that
        // actually tracks it, at 99.39 %.
        { key: "bms_leak_detect_inhibit", value: data[7] },
      ];
    }

    // 0x610 `CM_V_COM` — the charge manager's state machine. Both keys below are logged RAW and
    // are deliberately bounded only to [0, 255] in bounds.js, because the point of a raw state
    // byte is to catch a state nobody has seen yet. That leaves bounds.js unable to reject
    // anything for them, so the gate below is the only defence they have.
    case CHARGE_STATE_CAN_ID: {
      if (data.length < 8) return [];
      // ⚠️ A gate that DROPS is silent by construction: if a firmware update ever moves b4, these
      // bytes go quiet rather than loud, and quiet looks exactly like a charge manager that never
      // woke up. That is the right way round — b7 is the cleanest AC/DC discriminator on this
      // bus, so a wrong value is worse than no value — but suspect this first if they vanish.
      //
      // Deliberately NOT gated on b1-3: that would drop the aborted DC session of 2026-08-09
      // 14:42, the most interesting DC data this project has, and those bytes are now decoded.
      if (data[4] !== CHARGE_MANAGER_FAMILY_BYTE) return [];
      const errorSource = data[1];
      const errorCode = i16le(data[2], data[3]);
      return [
        // ✅ b0 = status. Four factory fields packed into one byte — a 2-bit `CM_CHGMODE_REQ`
        // (1 = AC, 2 = DC), relay request, inlet present, inlet locked, and a 2-bit `WAIT_AUTH`
        // that only the DC path ever sets. Logged whole rather than split: the raw byte survives
        // a bit-position error and the split fields do not, and docs/charge-manager.md carries
        // the layout to read it with. 0x19 on AC, 0x5E on DC.
        { key: "charge_manager_status", value: data[0] },
        // ✅ b7 = substate, and the cleanest AC/DC discriminator on this bus: 0x23 while DC
        // current flows (99.974 % of 151 096 frames) and 0x02 while AC mains flows (99.999 % of
        // 784 599). Not in the DBC either, so the intermediate steps of the ~3 s DC handshake
        // still have no names and are still not invented here.
        { key: "charge_manager_state", value: data[7] },
        // ✅ b1 `CM_ERROR_SRC` and b2-3 `CM_ERROR_CODE` (signed 16, LE). Zero in 968 129 of
        // 968 629 frames; non-zero in three episodes, with two sources (7, 8) and two codes
        // (853, 1101). Decoded on the DBC's word — the 2026-08-19 note guessed "very likely a
        // fault code" and left them alone for want of a second observation, and a factory name is
        // what closes that. Logged raw because two values are not a table.
        //
        // 🟡 This contradicts src/can/vcu-flags.ts, which says the CM's own error telemetry "is
        // not broadcast anywhere". It is, here, at 10 Hz — and `vcu_err_charge_manager` stayed 0
        // through all three episodes.
        { key: "charge_manager_error_src", value: errorSource },
        { key: "charge_manager_error_code", value: errorCode },
      ];
    }

    // 0x615 `V_CM_CHG` — the DC charge REQUEST the VCU sends. Not measurements: the DBC names
    // these `V_CMDC_TARGET_V`, `V_CMDC_TARGET_I` and `V_CMDC_SOC`, and the corpus agrees.
    // b4-7 are 00 in 100.000 % of 941 765 frames.
    case CHARGE_TELEMETRY_CAN_ID: {
      if (data.length < 8) return [];
      // The frame invariant, and this frame is the worst-exposed of the group: an all-ones
      // payload decodes to a 511 V target, 255 A and 255 %, of which only the SOC is caught by
      // bounds.js. b1 = 0x01 and b4-7 = 00 in 100.000 % of 941 765 frames.
      //
      // ⚠️ b1 is the target's HIGH BYTE, so unlike 0x620's gate this one reads a byte we decode —
      // a deliberate exception. What it excludes is physically unreachable: it accepts targets in
      // 256…511 V, and an 81-series pack charges neither below its 243 V floor nor above 340 V of
      // full cells. Observed span is 284…350.
      if (data[1] !== 0x01 || data[4] !== 0 || data[5] !== 0 || data[6] !== 0 || data[7] !== 0) return [];
      const values: DecodedValue[] = [];
      // ⚠️ This guard's original reason is gone. It was written when b0 was read as a voltage with
      // a 242.5 V offset, where b0 = 0 decoded to exactly that offset — the constant showing
      // through as a plausible pack voltage. Under the 16-bit reading b0 = 0 is a 256 V target,
      // no more special than 257. Kept because 256 V is still round, still inside bounds.js, and
      // still has never happened: b0 spans 28…94 over all 941 765 frames and is never 0,
      // including through the DC handshake before any current flows.
      if (data[0] !== 0) {
        values.push(
          // ✅ b0-1 = `V_CMDC_TARGET_V`, one 16-bit LE value in volts, 284…350 V observed.
          //
          // ⚠️ RENAMED from `charge_manager_pack_v`, and the VALUE CHANGED: it was b0 + 242.5 and
          // is now 256 + b0, i.e. 13.5 V higher. Old rows are correct readings of the same byte
          // under the old model and must not share a series with new ones. 🟡 The target tracks
          // 0x200's pack voltage at slope 1.0 with a median gap of +13.40 V (p5 12.70, p95 14.60)
          // in every mode including AC and idle — which is inference from our numbers, not
          // something the DBC states, but it is why the old offset fitted so well.
          { key: "fast_dc_target_v", value: u16le(data[0], data[1]) }
        );
      }
      values.push(
        // ✅ b2 = `V_CMDC_TARGET_I`, the DC current the vehicle ASKS FOR, 1 A/count. Zero in
        // 100.000 % of the 783 310 AC frames, so it is DC-specific rather than a general charge
        // current, and this is still the only DC-side current on this bus.
        //
        // ⚠️ RENAMED from `fast_dc_a`, which read as a delivery measurement. The number is
        // unchanged. Against 0x200's pack current r = +0.9951 with the pack drawing a median
        // 0.30 A LESS — a request the station follows just short of — and it LEADS the first amp
        // in all 8 captured ramps by +0.03 to +2.40 s, which a readback cannot do.
        //
        // 🔍 The value is computed, not chosen: where the station's power binds it is
        // min(73, round(0x620 b3 kW × 1000 / ~348 V)), an upper bound violated in 0.562 % of
        // 151 125 frames. ⚠️ And it has never once read 74 or 75, though the configured maximum
        // is 75 — start at that 2 A gap if you are asking why DC caps low.
        { key: "fast_dc_target_a", value: data[2] },
        // ✅ b3 = `V_CMDC_SOC`, the SOC the VCU reports OUTWARD to the station for its ramp
        // planning — free to disagree with the BMS's own, and it does. Equal to 0x200's SOC in
        // 99.008 % of the 847 644 frames from 2026-08-02 20:48 onward; before that it runs 2-4 %
        // low, consistently, for every frame of five sessions. Kept under its own key rather than
        // folded into `soc` for exactly that reason.
        { key: "charge_manager_soc", value: data[3] }
      );
      return values;
    }

    // 0x620 `CM_EVSE_FDB` — EVSE feedback: what the station currently offers, relayed by the
    // charge manager. The frame name is what closes 2026-08-19's open question of WHOSE limit b0
    // is; it is the station's. b4-7 are 00 in 100.000 % of 968 618 frames, and b0/b1 are never
    // both non-zero across all of them (b0 alone 152 581, b1 alone 784 508, both zero 31 529).
    //
    // ❌ b2 bit 0 is `CM_EVSE_CHG_ENABLED` and is NOT the "station says go" it sounds like: it is
    // set in 0.000 % of the 151 118 frames with DC current flowing, and it equals (b1 != 0) in
    // 968 618 of 968 618 frames — the AC ceiling's presence restated as a bit. Nothing emitted.
    //
    // 🟡 b3 is `CM_DC_MAX_PWR` — the power presently available to this outlet, in whole kW.
    // Delivered power never exceeds it (0.000 % of 151 005 frames, within 2.3 % at the tightest
    // point), which also bounds the unit the DBC omits at ≥ 0.98 kW/count. It is NOT the
    // station's nameplate rating (refuted against four chargers identified from their own GPS
    // tracks), and b0 is derived from IT rather than the reverse — 572 s of `4B 00 00 1E` hold b3
    // at 30 while pack voltage climbs 21 V. Nothing emitted: the unit is bounded, not pinned.
    case CHARGE_LIMITS_CAN_ID: {
      if (data.length < 8) return [];
      // The hardest dead sender in the group to spot: an all-zero payload decodes to two ceilings
      // of 0 A, and both are LEGITIMATE (every DC frame reads b1 = 0, every AC frame b0 = 0, and
      // 31 529 real frames read both as 0 between sessions), so bounds.js cannot help.
      //
      // b4-7 catches all-ones and the alternation; b3 separates all-zero, and the argument is
      // stronger than "never observed at 0": this byte already spells "no figure" as 0xFF, in
      // 100.000 % of AC frames. The gate is the minimal `=== 0` and NOT the observed range, so
      // values 1-8 and 83-254 pass, and should.
      //
      // ⚠️ The weakest gate here, because b3's meaning is the one still open: if a station ever
      // advertises zero available power this frame goes silent exactly when it gets interesting.
      // Judged the better risk than reporting "no ceiling on either path" for a dead sender.
      if (data[3] === 0 || data[4] !== 0 || data[5] !== 0 || data[6] !== 0 || data[7] !== 0) return [];
      return [
        // ✅ b0 = `CM_DC_MAX_CURR`, the DC current limit in force right now, in amps — the one of
        // the three DC limits on this bus that moves during a session. #79 read it as an echo of
        // the delivered current; that was put on trial over 151 202 aligned samples and it is a
        // limit: median 12 A of headroom, it steps while the delivery is flat (396 of 884 steps),
        // and it leads the first amp by 13-19 s.
        //
        // ⚠️ "In force" is not "binding" and not "commanding". It reacts to the station — on
        // 2026-08-04 it dropped 75 → 64 eleven seconds AFTER the current had already fallen —
        // and b0 − b2 == 0 in only 0.005 %, so the corpus has essentially no observation of it
        // ever constraining anything.
        //
        // The three DC current limits are genuinely three different numbers:
        //   dc_charge_limit_selected_a  0x121 b2   what the RIDER picked (charge-setpoint.ts)
        //   fast_dc_limit_max_a         0x625 b2   the configured ceiling, a static 75
        //   fast_dc_limit_a             0x620 b0   what is in force this second
        { key: "fast_dc_limit_a", value: data[0] },
        // ✅ b1 = `CM_AC_MAX_CURR`, the AC current ceiling in amps — supply-side, which the
        // factory name confirms. Takes 8, 10 and 13 A here, all standard cable/pilot ratings.
        // `0x10A` b7 ÷ 7 (the CHG.PWR.REF setpoint) never once exceeds it, 100.000 % of the
        // 784 508 frames where it is non-zero, and it LEADS: on 2026-08-08 19:40:13.9 it stepped
        // 10 → 13 and the setpoint followed 120 ms later.
        //
        // 🟡 Not the mains current (it matches floor(0x305 mains A) in 12 % of frames and sits at
        // 13 through a 6.8 h session drawing 1.4 A) and not the bike's own ~14.3 A maximum.
        { key: "ac_supply_limit_a", value: data[1] },
      ];
    }

    // 0x625 `VCU_CM_LIMIT` — the vehicle's own configured limits, and the one frame in this group
    // that is NOT gated on a charge cable: it broadcasts at 10 Hz whenever the bike is awake,
    // parked and unplugged included. b5-7 are 00 in 100.000 % of 1 571 614 frames. b3 is
    // `V_CMDC_P_LIMIT`, a constant 0xFF; 🟡 reading that as "no power limit set" is inference from
    // the value, not from the DBC, so it is gated on rather than emitted.
    case CHARGE_CONFIG_CAN_ID: {
      if (data.length < 8) return [];
      // Trusting b4 blindly is actively dangerous because its DC bit is read INVERTED: an
      // all-zero payload has bit 5 clear and would decode to "DC charging", and an all-ones
      // payload has bit 2 set and would decode to "AC charging". Both keys are legitimately 0/1,
      // so bounds.js can reject neither. b1 = 0x01 and b3 = 0xFF in 100.000 % of 1 571 614 frames.
      //
      // ⚠️ The gate is b1/b3 and NOT a whitelist of b4 values, which is tested rather than
      // stylistic: b4 takes NINE values across the archive, not the three named below, and a
      // whitelist drawn from those three would have rejected 129 601 real frames.
      if (data[1] !== 0x01 || data[3] !== 0xff) return [];
      const flags = data[4];
      return [
        // ✅ b0-1 = `V_CM_V_LIMIT`, 16-bit LE volts — the same shape as 0x615's target, with b1
        // the high byte. NEW: b0 was on the undecoded list as "0x6B, then 0x73 after 2026-08-09,
        // lining up with nothing". As a 16-bit value that is 363 V → 371 V, it sits 13 V above the
        // largest target ever sent and 26 V above the largest pack voltage ever measured, and the
        // change lands 91 s INTO a DC session, flickering between the two values for 15.5 s
        // before settling. Logged for the same reason as b2: to notice the day it moves again.
        { key: "fast_dc_limit_max_v", value: u16le(data[0], data[1]) },
        // ✅ b2 = `V_CMDC_I_LIMIT`, the configured maximum DC charge current: 75 A, static in
        // 100.000 % of 1 571 614 frames through DC, AC and parked alike, and equal to
        // `MAX_DC_CHG_CURRENT` read from the VCU's own parameter block. The anchor every other
        // current-like byte here is calibrated against.
        { key: "fast_dc_limit_max_a", value: data[2] },
        // ✅ b4 = charge-active flags, and NOT in the DBC at all — these two are ours. bit 5 CLEAR
        // ⟺ DC current flowing (99.713 % of 151 621 frames); bit 2 SET ⟺ AC current flowing
        // (99.356 % of 381 060 frames with mains above 2 A). Note the inverted sense of bit 5: it
        // is asserted when NOT DC charging, so a frame that never arrives cannot be mistaken for
        // a DC charge. The byte takes 0x32 parked or idle, 0x12 on DC, 0x2C on AC.
        //
        // These say current is FLOWING, not that a session exists — through the 155 s aborted DC
        // attempt of 2026-08-09 14:42, b4 stays 0x32 while 0x605 and 0x610 both say the session
        // is established. That split is why both these and `charge_type` are logged.
        { key: "dc_charging", value: bit(flags, 5) ? 0 : 1 },
        { key: "ac_charging", value: bit(flags, 2) },
      ];
    }

    default:
      return [];
  }
}
