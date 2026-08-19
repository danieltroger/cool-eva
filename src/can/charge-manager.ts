// The charge manager's broadcast frames — 0x605, 0x610, 0x615, 0x620, 0x625.
//
// This ECU is only on the bus while a charge cable is live, which is why none of it was
// decoded until now: every parked sweep found silence (obd-garage/CHARGE_MANAGER.md §3.5).
// The standing assumption was that it meant DC only. It does not — the whole group
// broadcasts on AC too, and AC is where most of the corpus is, so the AC-vs-DC contrast is
// what identifies these bytes rather than any single session.
//
// ## What this was measured on
//
// 29 charge sessions found by scanning every capture in ~/Documents/cool-eva-archive
// (16 GB, 95 files): 18 AC and 11 DC, 2026-06-14 → 2026-08-09, at several different
// chargers. Ten of the eleven DC sessions are new to this analysis — obd-garage/CAN_MAP.md's
// existing decode of these frames rests on one session (2026-08-04 19:58), so everything
// below is that decode re-tested across all 29 plus what only multiple sessions can show.
// Match rates in the comments are over the whole corpus and are stated per claim.
//
// ## How AC and DC are told apart here
//
// Not by 0x201: the BMS reports Idle (0x10) through most of a DC charge because the DC path
// bypasses it, and — new in this pass — it reports Charge (0x02) through parts of session 27,
// a DC session at 99 % SOC. So "0x201 = 0x02 means AC" is false in both directions.
// Ground truth used throughout is `0x615` b2 > 0 for DC (this frame's own current, below)
// and 0x305 mains current > 0.5 A for AC, both of which are unambiguous.

import { bit, type DecodedValue } from "./frame.ts";

/** 0x605 — vehicle → BMS. Carries the charge type and the leak-detection inhibit. */
export const CHARGE_BMS_COMMAND_CAN_ID = 0x605;
/** 0x610 — the charge manager's state machine. */
export const CHARGE_STATE_CAN_ID = 0x610;
/** 0x615 — the charge manager's own telemetry: voltage, DC current, SOC. */
export const CHARGE_TELEMETRY_CAN_ID = 0x615;
/** 0x620 — the current ceilings, one byte per charge path. */
export const CHARGE_LIMITS_CAN_ID = 0x620;
/** 0x625 — configured maximum plus the charge-active flags. Broadcast even when parked. */
export const CHARGE_CONFIG_CAN_ID = 0x625;

export const CHARGE_MANAGER_CAN_IDS = [
  CHARGE_BMS_COMMAND_CAN_ID,
  CHARGE_STATE_CAN_ID,
  CHARGE_TELEMETRY_CAN_ID,
  CHARGE_LIMITS_CAN_ID,
  CHARGE_CONFIG_CAN_ID,
];

// 0x615 b0 is a voltage with a fixed offset subtracted, 1 V per count. Adding this back is
// what makes it a voltage rather than a raw byte.
//
// The offset is the one number in this file that cannot be pinned exactly, and it is worth
// being precise about why. b0 is an integer, so any offset within ±0.5 V fits every sample
// equally well; what the corpus fixes is the CENTRE of that band. Pooling all 47 638 aligned
// (0x615, 0x200) pairs across all 29 sessions, `pack_v − b0` has median 242.6 with p5 = 241.4
// and p95 = 243.3 — a 1.9 V spread, which is one count of quantisation plus 0x200's own 0.1 V
// resolution. A least-squares fit gives `pack_v = 0.9943 × b0 + 242.79`, i.e. a slope of 1.0
// to within the resolution, so the scale is 1 V/count and only the offset is in question.
// 242.5 puts the residual band symmetrically about zero.
//
// This supersedes CAN_MAP.md's "the exact offset is not pinned — 242 and 245 both fit".
// 245 does not: it would put the median residual at −2.4 V, outside the whole p5…p95 band.
//
// 🟡 Where the offset comes FROM is still a guess, and is left as one. 81 series cells at
// the 3.0 V under-voltage limit is 243.0 V, so "volts above the pack's minimum" would be a
// natural thing for a charge manager to send — but 243.0 fits the data no better than 242.5,
// and one coincidence is not a derivation.
const PACK_VOLTAGE_OFFSET = 242.5;

/**
 * Decodes one charge-manager frame. Pure: bytes in, values out.
 *
 * Callers route by id; ids this ECU does not own return [].
 */
export function decodeChargeManagerFrame(id: number, data: Buffer): DecodedValue[] {
  switch (id) {
    // 0x605 — what the vehicle tells the BMS about the session in progress.
    //
    // b1 and b4-6 are 00 in all 44 323 frames of the corpus. b0 is 0x0F on AC and 0x11 on DC
    // (99.93 %) but is not read here: 15 and 17 are not a bitfield relationship and naming a
    // two-valued byte would be inventing a meaning for it. b3 is a byte-for-byte copy of b2 —
    // 100.000 % over 44 323 frames — so only one of the pair is emitted.
    case CHARGE_BMS_COMMAND_CAN_ID: {
      if (data.length < 8) return [];
      return [
        // ✅ b2 = which charge path is live: 1 = AC, 2 = DC. 99.975 % of 43 994 frames,
        // conditioned on the instantaneous mode; the residual is the handful of frames
        // inside a mode transition, where the byte is briefly ahead of the current.
        //
        // ⚠️ This is a property of the SESSION, not of current flowing. In the aborted DC
        // attempt of 2026-08-09 14:42 it reads 2 for the whole 155 s while not one amp
        // moves. For "is charge actually flowing", use dc_charging / ac_charging below.
        { key: "charge_type", value: data[2] },
        // ✅ b7 = leak detection inhibited (BMS memory 2122). 1 on DC and 0 on AC in
        // 100.000 % of 43 994 frames — no exceptions in either direction, which is what
        // separates this from every other flag in the group. The BMS's isolation monitor
        // cannot run against a station-driven DC bus, so the vehicle switches it off for
        // exactly the duration of a DC session and leaves it on through every AC one.
        { key: "bms_leak_detect_inhibit", value: data[7] },
      ];
    }

    // 0x610 — the charge manager's state machine. Both bytes below are logged RAW.
    //
    // That is deliberate. The state sequence is legible (b7 steps 0x02 → 0x14 → 0x04 → 0x07 →
    // 0x0D → 0x11 → 0x12 → 0x23 over the ~3 s of a DC handshake) but the individual steps have
    // no established names, and inventing a state table from the order they appear in is
    // exactly the kind of confident guess this project has been burned by. The endpoints ARE
    // known and are what makes the raw byte useful; see the two comments below.
    //
    // b1-3 are 00 in every frame of every completed session. They are non-zero in exactly one
    // place in the whole corpus — the aborted DC attempt of 2026-08-09 14:42, where they read
    // 07 55 03 — so they are very likely a fault code. One aborted session is not enough to
    // decode one, so they are left alone and recorded on issue #21 instead.
    // b4-6 are the constant F1 05 01 in 100.000 % of 44 862 frames.
    case CHARGE_STATE_CAN_ID: {
      if (data.length < 8) return [];
      return [
        // ✅ b0 = status bitfield. 0x19 on AC, 0x5E on DC, with the entry/exit sequence
        // passing through 0x08/0x0A/0x2A/0x4A/0x5A. What is established is the bottom two
        // bits: bit 0 set ⟺ AC, bit 1 set ⟺ DC, in 99.989 % of 44 444 frames. The rest of
        // the byte moves with the handshake and is not named.
        { key: "charge_manager_status", value: data[0] },
        // ✅ b7 = substate, and the single cleanest AC/DC discriminator on this bus:
        // 0x23 while DC current flows and 0x02 while AC current flows, in 100.000 % of
        // 44 444 frames across 29 sessions. Not one frame of either mode reads the other's
        // value. (0x102 b3 bit 0, the fast-DC contactor, is the other clean one and is
        // already decoded — they agree.)
        { key: "charge_manager_state", value: data[7] },
      ];
    }

    // 0x615 — the charge manager's own view of the pack. b1 is the constant 01 and b4-7 are
    // 00 in 100.000 % of 47 642 frames, so three bytes carry everything.
    case CHARGE_TELEMETRY_CAN_ID: {
      if (data.length < 8) return [];
      const values: DecodedValue[] = [];
      // b0 = 0 would decode to 242.5 V, which is a believable reading for this pack and sails
      // straight through bounds.js's "V" band — a phantom that is far harder to spot later
      // than an obviously silly number. It has never happened: b0 spans 28…94 over all 47 632
      // frames of the corpus and is never 0, including through the ~3 s DC handshake before
      // any current flows. So this guard should be dead code, and it is here because the one
      // way to find out that it is not would otherwise be a plausible voltage in the log.
      if (data[0] !== 0) {
        values.push(
          // 🟡 b0 + 242.5 = pack voltage, 1 V/count. See PACK_VOLTAGE_OFFSET above for how the
          // offset was fixed. 98.87 % of 47 613 frames land within 1.5 V of 0x200's pack_v.
          //
          // Logged despite pack_v already existing at 0.1 V from the BMS, because it is a
          // SECOND witness on a different ECU: the two agreeing is what says the charge manager
          // and the BMS are looking at the same pack. It must not be preferred over pack_v for
          // anything numeric — it is coarser and carries an offset that is only good to ±0.5 V.
          //
          // Whether it is pack-side or charger-side voltage is still open and probably
          // unanswerable from this port: a cable drop at 60 A is ~2 V, which is inside the
          // quantisation. Nothing here should assume either.
          { key: "charge_manager_pack_v", value: data[0] + PACK_VOLTAGE_OFFSET }
        );
      }
      values.push(
        // ✅ b2 = DC charge current in amps, 1 A/count. Zero in 100.000 % of the 36 679 AC
        // frames — no leakage at all, which is what makes it a DC-specific measurement rather
        // than a general charge current — and on DC it tracks 0x200's pack current with
        // r = +0.999. Median difference is −0.30 A (the pack draws slightly less than the port
        // delivers, which is the DC-DC converter's share); 75 % of samples agree within 1.0 A
        // and 85 % within 2.0 A, the tail being ramps where a 10 Hz frame and a 20 Hz one
        // disagree about a current that is moving at tens of amps per second.
        //
        // This is the only DC charge current on the bus. 0x305/0x306 do not exist during a DC
        // session at all, and 0x10A b7 reads 0, so every "am I charging" test built on the AC
        // charger's frames silently says no at a fast charger.
        { key: "fast_dc_a", value: data[2] },
        // ✅ b3 = state of charge in %. Equal to 0x200's SOC in 99.372 % of the 42 979 frames
        // from 2026-08-02 20:48 onward.
        //
        // ⚠️ Before that it is NOT equal: it runs 2 % low in the three 2026-06-14 sessions and
        // 4 % low in the two early 2026-08-02 ones, consistently, for every frame. The BMS
        // config was reflashed that evening, which brackets the change, but what the older
        // value was is unidentified — the corpus was searched exhaustively for another byte
        // carrying it and nothing matched (0x10A b2 matches in one session and 53 % overall,
        // i.e. by coincidence). Kept under its own key rather than folded into `soc` for
        // exactly this reason: two SOC estimates that can disagree must stay separable.
        { key: "charge_manager_soc", value: data[3] }
      );
      return values;
    }

    // 0x620 — the current ceilings. One byte per charge path, and each is 0 while the other
    // path is the live one: b0 is 0 in 100.000 % of 36 924 AC frames and b1 is 0 in 100.000 %
    // of 10 057 DC frames. That mutual exclusion is the argument for reading them as a pair.
    //
    // b2 is 1 on AC and 0 on DC (99.98 % of 46 625) — the same fact as b0/b1 in one bit, so it
    // is not logged separately. b3 is left undecoded: it is 0xFF on AC and moves between 9 and
    // 64 on DC, correlating with current at r = +0.72 but not resolving the plateaus (it reads
    // the same 22-23 across everything from 59 to 66 A), so no scaling survives contact with a
    // second session. b4-7 are 00 in every frame.
    case CHARGE_LIMITS_CAN_ID: {
      if (data.length < 8) return [];
      return [
        // ✅ b0 = the DC current limit in force right now, in amps — the one of the three DC
        // limits on this bus that moves during a session.
        //
        // 🧨 It was put to a direct test, because #79 read the same byte as "not a limit at
        // all — it follows the delivered current", having watched it ramp 0 → 22 → 44 → 66 →
        // 75 → 66 → 44 and read 44 while only 10 A flowed. If that were right, naming it a
        // limit would be this project's `charging`-was-the-high-beam mistake over again. It is
        // not right, and the discriminator is headroom: an echo of delivered current has to
        // touch it, and this byte never does. Over 10 771 aligned (0x620, 0x615) samples in
        // all ten DC sessions that carry both:
        //
        //     b0 − b2 == 0 (hugging the delivery):        0.0 %      ← an echo lives here
        //     b0 − b2 >= 5 A of headroom:                83.9 %
        //     b0 − b2 median 12 A, p75 28 A, p95 44 A
        //     b2 > b0 (the bound broken):                 0.4 %
        //
        // The 44-while-10-A reading is the headroom case, not a contradiction: session 27's
        // median gap is 35 A because the pack was at 99 % and taking almost nothing. So b0
        // bounds the delivery with room to spare and never tracks it. It is a limit.
        //
        // ⚠️ What it is NOT is a command, and #79 is right about the direction of causation.
        // On 2026-08-04 it dropped 75 → 64 eleven seconds AFTER the delivered current had
        // already fallen to 55.6 A. It reacts to the station.
        //
        // ❓ And whose limit it is stays open: vehicle-advertised and station-granted look
        // identical from this port, and both would bound delivery and both would move when
        // the station derates. All that is established is that it never exceeds 0x625 b2's
        // configured 75. So the name says which limit (the live one) and not whose.
        //
        // The three DC current limits, which are genuinely three different numbers:
        //   dc_charge_limit_selected_a  0x121 b2   what the RIDER picked (charge-setpoint.ts)
        //   fast_dc_limit_max_a         0x625 b2   the configured ceiling, a static 75
        //   fast_dc_limit_a             0x620 b0   what is in force this second
        { key: "fast_dc_limit_a", value: data[0] },
        // ✅ b1 = the AC current ceiling in amps. NEW — CAN_MAP.md records this byte as
        // "static 00" because the only session it had was a DC one, where it is.
        //
        // It is a ceiling on the AC setpoint: `0x10A` b7 ÷ 7 (the CHG.PWR.REF setpoint, already
        // decoded in decode.ts) never once exceeds it — 100.000 % of 33 357 AC frames. Across
        // the 18 AC sessions it takes exactly three values, 8, 10 and 13 A, and it LEADS: on
        // 2026-08-08 19:40:13.9 it stepped 10 → 13 and the setpoint followed 9.1 → 11.9 A
        // 120 ms later, with the mains current behind that.
        //
        // 🟡 It is not the mains current — b1 == floor(0x305 mains A) in only 12 % of frames,
        // and it sits at 13 through a 6.8 h session drawing 1.4 A. Nor is it the bike's own
        // maximum, which is ~14.3 A. Supply-side (cable or EVSE pilot rating) is the natural
        // reading and 8/10/13 A are all standard ratings, but this bike has only ever been
        // plugged into a handful of outlets, so that is inference, not measurement.
        { key: "ac_supply_limit_a", value: data[1] },
      ];
    }

    // 0x625 — the one frame in this group that is NOT gated on a charge cable. It broadcasts
    // whenever the bike is awake, parked and unplugged included, which is why it was filed for
    // a long time as an unrelated always-on frame. b1 = 01, b3 = 0xFF and b5-7 = 00 in
    // 100.000 % of 44 262 frames. b0 is left undecoded: it reads 0x6B everywhere until
    // 2026-08-09 17:55 and 0x73 in every capture after, a one-way change that no charge event
    // in the corpus lines up with.
    case CHARGE_CONFIG_CAN_ID: {
      if (data.length < 8) return [];
      // Refuse a frame that does not carry this frame's own invariants. b1 = 0x01 and
      // b3 = 0xFF hold in 100.000 % of 44 262 frames, and checking them costs nothing —
      // whereas trusting b4 blindly is actively dangerous, because b4's DC bit is read
      // INVERTED. An all-zero payload has bit 5 clear and would decode to "DC charging";
      // an all-ones payload has bit 2 set and would decode to "AC charging". Those are
      // precisely the two shapes check-can-decoders.ts calls out as what a dead or
      // disconnected sender produces, and because both keys are legitimately 0/1,
      // bounds.js cannot reject either — a false charge claim would reach the log and the
      // dashboard looking like an ordinary flag. This turns both back into "no reading".
      if (data[1] !== 0x01 || data[3] !== 0xff) return [];
      const flags = data[4];
      return [
        // ✅ b2 = the configured maximum DC charge current, 75 A. Static in 100.000 % of
        // 44 262 frames — through DC sessions, AC sessions and parked alike — and equal to
        // `MAX_DC_CHG_CURRENT` read from the VCU's own parameter block. A configuration
        // constant, and the anchor that every other current-like byte here is calibrated
        // against. Logged because it is the ceiling every other DC limit is measured against;
        // if it ever moves, something changed the VCU parameter.
        { key: "fast_dc_limit_max_a", value: data[2] },
        // ✅ b4 = charge-active flags. Two bits are established, each against the mode ground
        // truth described at the top of this file:
        //
        //   bit 5 (0x20) CLEAR ⟺ DC current is flowing — 100.000 % of 43 911 frames
        //   bit 2 (0x04) SET   ⟺ AC current is flowing — 99.995 % of 43 911 frames
        //
        // The byte takes 0x32 parked or idle, 0x12 while DC flows, 0x2C while AC flows. Note
        // the inverted sense of bit 5: it is asserted when NOT DC charging, so a frame that
        // never arrives cannot be mistaken for a DC charge.
        //
        // These are "current is flowing", not "a session exists" — through the 155 s aborted
        // DC attempt of 2026-08-09 14:42 b4 stays 0x32 while 0x605 b2 says DC and 0x610 says
        // the session is established. That is the right split, and it is why both are logged.
        { key: "dc_charging", value: bit(flags, 5) ? 0 : 1 },
        { key: "ac_charging", value: bit(flags, 2) },
      ];
    }

    default:
      return [];
  }
}

// ## Frames in this group that are deliberately NOT decoded
//
// Recorded here so the next pass does not re-derive the same negatives. All of this is on
// issue #21 as well.
//
// ❌ 0x600 — b0-3 are the constant 01 01 06 11 (99.998 % of 900 309 frames). b4-5 LE is a
//    free-running 10 ms tick that wraps every 655 s; it is genuinely decoded and genuinely
//    useless to log, since a wrapping counter with no epoch is noise in a time series.
//
//    b6-7 LE sits in 2367-2816 with no correlation to voltage, current, SOC or time in any of
//    the 29 sessions. One attractive reading was tested and REFUTED, which is worth recording
//    because it is exactly the shape of a wrong decode that gets believed: psu_12v_mv ÷ b6-7
//    has a median of 4.93 across both a DC and a 6.8 h AC session, so "×5 mV/count, the 12 V
//    rail" looks compelling — 2530 → 12.65 V, 2750 → 13.75 V is the right rest-to-charging
//    span. But r(b6-7, psu_12v_mv) = −0.023 on DC and −0.003 on AC over 255 843 aligned
//    samples. The ratio is stable only because BOTH quantities happen to sit in narrow bands;
//    they are not the same measurement. It stays unknown.
//
// ❌ 0x630 — DLC 3, and a poll rather than a measurement. b0 takes only the values
//    {0xA1, 0xA2, 0xA3, 0xA5, 0xA9}, which are precisely Energica's own `MotorbikeECU` node
//    ids (BMSuControl 0xA1, Logo 0xA2, CNode 0xA3, DCDC 0xA5, VCUControl 0xA9) — that much is
//    new here and worth having, because it says 0x630 is addressed per-ECU. What b1/b2 mean
//    for each node is not established; the A1 entry's third byte is 0x1B on AC and 0x07 on DC,
//    which is a real difference with no interpretation behind it.
//
// ❌ 0x631 — b4's bit 0 alternates on every frame at 20 Hz, which CAN_MAP.md recorded as
//    "b4 twitches 50 ↔ 51". It is an alternating toggle and NOT a multiplex selector: split
//    the frames on it and the two halves are byte-identical in every other position, in all
//    three DC sessions checked (b0 = 04, b1 = 00, b2 = 11, b3 = 23, b5 = 00, b6 = 05,
//    b7 = 02 in both). On AC the toggle does not happen at all — b4 is 0x00 in 12 280 of
//    12 280 frames of the 6.8 h overnight session — so it is DC-only. b4 & 0xFE is 0x32 on DC
//    and 0x00 on AC.
//
//    b3 is a mirror of 0x610 b7: equal in 99.860 % of 326 075 frames. Not decoded, precisely
//    because it is a duplicate — a second key for the same quantity whose 0.14 % of
//    disagreements would read as a bug rather than as the frame skew it is.
//    b0 is 3 on AC and 4 on DC, and b2 is 0 on AC and 0x11 on DC; neither is decoded, as
//    0x610 already carries that distinction with a better-evidenced byte.
//
// ❌ 0x635 — b0-2 are the constant DC DD 24 (100.000 % of 44 694 frames). b3-5 read FF FF FF
//    on AC and resolve to F2 3D 0E about 2.7 s into a DC handshake.
//
//    CAN_MAP.md's standing guess, "station / session / transaction identifier … needs a second
//    session at a different charger to test", is now REFUTED: F2 3D 0E is byte-identical in
//    all eleven DC sessions, across three days and several different chargers. Whatever it is, it
//    is a constant the vehicle learns at handshake, not anything about the station.
//
// ❌ 0x645 — all eight bytes are 00 in 100.000 % of 7 713 frames, so only its presence carries
//    anything, and that presence is a clean DC-session flag: it appears in all 11 DC sessions
//    and in none of the 18 AC ones. Note it tracks the SESSION, not the current — it is there
//    for all 155 s of the aborted DC attempt of 2026-08-09 14:42, during which not one amp
//    flowed. Nothing is emitted for it because a decoder that returns a value for an all-zero
//    frame would be logging "this id exists", which STREAM_IDS already says.
//
//    ⚠️ An earlier draft of this file claimed session 24 was a DC session with no 0x645 at
//    all, and drew the conclusion that presence implied DC but absence implied nothing. That
//    was an artefact of the analysis scanner, not of the bike, and it is recorded here because
//    the failure mode generalises to anything reading these captures. The Pi's clock jumps to
//    2060 when it boots without a fix (the archive has capture-20600808-*.log to prove it).
//    The scanner emitted a row per payload CHANGE plus a keepalive every 2 s, and one
//    2060-dated line pushed its "last emitted" mark into the far future — after which every
//    real frame looked negatively aged, the keepalive never fired again, and any id with a
//    CONSTANT payload silently stopped being recorded. 0x645 is the most constant frame on the
//    bus, so it vanished first. Re-grepping the raw capture put 28 009 frames of 0x645 against
//    27 987 of 0x615 in exactly that window, in lockstep.
