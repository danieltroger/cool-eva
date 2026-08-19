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
//
// ## A note on the frame counts
//
// The counts added on 2026-08-19 (44 262, 44 862, 47 642, …) came from the change-plus-keepalive
// scanner described at the bottom of this file — a row per payload CHANGE plus one every 2 s,
// not a row per frame. The 2026-08-20 pass re-ran the invariants over EVERY raw frame instead,
// deduplicated on (timestamp, id, payload) because several captures in the archive overlap in
// time. That is the same data seen at ~20× the resolution:
//
//     0x605   967 865      0x610   968 629      0x615   941 765
//     0x620   968 618      0x625 1 571 617   (0x625 is higher because it broadcasts parked too)
//
// Where a claim below has been re-measured at full rate it says so and carries the larger n.
// Every invariant re-checked so far came out at the same 100.000 %, which is the reassuring
// part — but the sampling is NOT uniform, and one percentage moved twelvefold because of it.
// A keepalive scanner over-represents frames that are CHANGING, so any statistic about
// transients is inflated: 0x620's "b2 > b0 in 0.4 %" is 0.033 % at full rate (see b0 below).
// Treat a sampled percentage about a steady state as sound and one about an edge as suspect,
// and re-derive before leaning on it.
//
// One thing the recount turned up that is about the ARCHIVE rather than the bike. Every frame
// of all five ids is DLC 8 — the `data.length < 8` guards below have never fired on real data —
// with one apparent exception, and the exception is not a frame:
//
//     capture-20260807-211634-0541697e.log ends
//      (2026-08-07 21:17:38.503667)  can0  625   [8]  6B 01
//
// candump was killed mid-write, so the line says DLC 8 and carries two bytes. Same family as
// the 2060-clock artefact at the bottom of this file: a truncated capture is indistinguishable
// from a truncated frame to anything that parses these logs by counting fields, and it would
// have "shown" that this bus produces short frames. It does not. Any scan of the archive should
// drop a final line whose byte count disagrees with its own DLC.

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
    // b1 and b4-6 are 00, and b3 is a byte-for-byte copy of b2, both in 100.000 % of 967 865
    // frames, so only one of the b2/b3 pair is emitted.
    //
    // ⚠️ b0 is NOT the two-valued byte the 2026-08-19 pass recorded. "0x0F on AC and 0x11 on DC
    // (99.93 %)" is 97.19 % at full rate, and the byte takes TEN values, not two: 0x0F 783 865,
    // 0x11 156 765, 0x02 25 704, 0x0B 1 080, 0x00 196, 0x01 148, 0x0E 53, 0x06 28, 0x03 24,
    // 0x0A 2. Still not read here, and now for a better reason than "15 and 17 are not a bitfield
    // relationship" — a byte with ten values and a 3 % tail is a state or a sequence number, and
    // the two-valued reading was an artefact of a sample that under-represented the transitions.
    // ⚠️ This is the one frame in the group with NO invariant gate, and that is a measurement
    // rather than a preference — worth stating, because four of the five now have one and the
    // asymmetry otherwise looks like an oversight.
    //
    // It has no invariant left to gate on. The all-ones shape is caught by bounds.js (255 fails
    // both `charge_type`'s [0, 2] and `bms_leak_detect_inhibit`'s [0, 1]). The all-zero shape
    // cannot be caught at all: b1 and b4-6 are 00 by definition, b3 = b2 holds trivially, and
    // every remaining byte takes 0 in real traffic — b0 = 0x00 in 196 frames, b2 = 0 in 27 134,
    // b7 = 0 in 811 039. THE BUS ITSELF SENDS A COMPLETELY ZERO 0x605 PAYLOAD 126 TIMES in the
    // archive, so any gate that rejected that shape would be dropping real frames.
    //
    // Which is tolerable here and would not be on 0x620, for a reason worth keeping: this frame's
    // all-zero decode is FAIL-SAFE. charge_type = 0 says "no path live" and
    // bms_leak_detect_inhibit = 0 says "the isolation monitor is running" — both the safe reading
    // of a charge manager that has gone away. 0x620's all-zero decode claims two ceilings, which
    // is a measurement, and that is why it is gated and this is not.
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
    // decode one, so they are left alone and recorded on issue #21 instead. This is also why
    // the gate below reads b4-6 and NOT b1-3: gating on b1-3 would drop the one aborted session
    // in the corpus, which is the most interesting DC data this project has.
    case CHARGE_STATE_CAN_ID: {
      if (data.length < 8) return [];
      // The same frame-invariant gate 0x625 has, and this frame is the one that needs it most.
      // Both keys below are logged RAW and are DELIBERATELY bounded only to [0, 255] in
      // bounds.js — the point of a raw state byte is to catch a state nobody has seen yet, and a
      // bound drawn round today's set would reject exactly that. Which means bounds.js cannot
      // reject anything at all for these two, and this check is the only defence they have.
      //
      // b4-6 are the constant F1 05 01 in 100.000 % of 968 629 frames — every raw frame of this
      // id in the archive, not a sampled subset; see "A note on the frame counts" above. A
      // 24-bit constant is not something a dead sender reproduces: none of all-zero, all-ones or
      // an alternating pattern passes it.
      //
      // ⚠️ The trade-off, which 0x625 already accepts and which deserves stating once. A decoder
      // is pure, so a gate that DROPS is silent by construction: if a firmware update ever moves
      // F1 05 01, these two bytes go quiet rather than loud, and quiet looks exactly like a
      // charge manager that never woke up. That is the right way round — 0x610 b7 is the
      // cleanest AC/DC discriminator on this bus, so a wrong value for it is worse than no
      // value — but it is the first thing to suspect if the state bytes ever vanish.
      if (data[4] !== 0xf1 || data[5] !== 0x05 || data[6] !== 0x01) return [];
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
    // 00 in 100.000 % of 941 765 frames, so three bytes carry everything.
    case CHARGE_TELEMETRY_CAN_ID: {
      if (data.length < 8) return [];
      // The frame invariant, for the same reason 0x625 below checks its own — and this frame is
      // the worst-exposed of the three, because two of its three keys are real MEASUREMENTS
      // rather than flags. An all-ones payload, which is one of the two shapes
      // check-can-decoders.ts calls out as what a dead or disconnected sender produces, decodes
      // to:
      //
      //     charge_manager_pack_v = 255 + 242.5 = 497.5 V
      //     fast_dc_a             = 255 A
      //     charge_manager_soc    = 255 %
      //
      // Only the SOC is caught, by bounds.js's "%" band. The other two passed the wide "V" and
      // "A" unit fallbacks until this change named them (see public/lib/bounds.js), and a named
      // bound is still only the second line of defence: 255 A on the only DC charge current on
      // this bus is the kind of number that sets a chart's autoscale and then a conclusion.
      //
      // b1 = 0x01 and b4-7 = 00 in 100.000 % of 941 765 raw frames — b1 has never held any other
      // value in the whole archive — so requiring them costs nothing and turns both dead-sender
      // shapes back into "no reading". The same silent-drop trade-off applies as for 0x610
      // above.
      if (data[1] !== 0x01 || data[4] !== 0 || data[5] !== 0 || data[6] !== 0 || data[7] !== 0) return [];
      const values: DecodedValue[] = [];
      // b0 = 0 would decode to 242.5 V, which is a believable reading for this pack and sails
      // straight through bounds.js's "V" band — a phantom that is far harder to spot later
      // than an obviously silly number. It has never happened: b0 spans 28…94 over all 941 765
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
    // of 10 057 DC frames. That mutual exclusion is the argument for reading them as a pair, and
    // re-measuring it at full rate lets it be stated without needing the mode at all: across all
    // 968 618 frames the two are NEVER both non-zero. b0 alone in 152 581, b1 alone in 784 508,
    // both zero in 31 529 — no frame at all in the fourth cell.
    //
    // b2 is 1 on AC and 0 on DC (99.98 % of 46 625) — the same fact as b0/b1 in one bit, so it
    // is not logged separately. b4-7 are 00 in 100.000 % of 968 618 frames.
    //
    // ## b3 — still undecoded, and the 2026-08-19 description of it was wrong
    //
    // ⚠️ RETRACTED: "0xFF on AC and moves between 9 and 64 on DC, correlating with current at
    // r = +0.72". Every clause of that is wrong except the first, and the counter-example was
    // sitting in the same change — the DC taper replay case `2C 00 00 51` in
    // check-can-decoders.ts has b3 = 0x51 = 81. Re-measured over every raw 0x620 frame in the
    // archive, 157 423 of them on DC across 11 DC sessions and 807 907 on AC:
    //
    //   • 0xFF on AC: 100.000 % of 807 907 frames — this part holds.
    //   • But 0xFF appears on DC too, in 4 604 frames, so it does not mean "AC". Seven of the
    //     nine DC sessions that contain any put all of them before the first real value;
    //     2026-08-09 17:51 has 40 of its 173 interleaved after that; and the aborted attempt of
    //     2026-08-09 14:42 has 952 of its 1 911 after the last real value as well. It reads as
    //     "no DC figure", which covers both not-yet and never.
    //   • The DC range is 9…82, not 9…64, over 31 distinct values.
    //   • r(b3, fast_dc_a) = −0.333 over 152 612 aligned samples — the OPPOSITE SIGN to the
    //     +0.72 recorded. Per session it runs from −0.97 to +0.78, which is what a pooled r over
    //     a quantity that is not a function of current looks like. Withdrawn, not corrected.
    //   • ❌ b3 = SOC − 18, suggested by the two replay frames (22 at 40 %, 81 at 99 %), is
    //     REFUTED: it holds in 8.14 % of those samples, i.e. by coincidence.
    //
    // 🟡 One lead did come out of the re-measurement, recorded because the next pass should start
    // here rather than at r = +0.72. Read b3 as KILOWATTS — an available POWER — and b0 as that
    // power converted to amps at the present pack voltage and clamped to the 75 A ceiling.
    //
    // Over the 37 754 samples where b3-as-kW would ask for LESS than 75 A, the conversion has to
    // land on a specific number, and it does: `b0 − b3 × 1000 / pack_v` is within ±2 A in 98.4 %
    // of them, against roughly 7 % for agreeing that closely by chance over b0's observed range.
    //
    // ⚠️ Read that as a conditional fit, NOT as a test of the model over the data, because the
    // subset is selected on the model's own predictor. b0 never exceeds 75, so wherever b3-as-kW
    // implies more than 75 A the model degenerates to "b0 = 75" and cannot be wrong; excluding
    // that region excludes precisely where a refutation could come from. The other 80 973 samples
    // are duly consistent and prove nothing — b0 is 75 in 51 % of them and lower in the rest, and
    // "lower" is what a pack-side taper produces too. Both b3 = 30 sessions (2026-08-08 17:44 and
    // 18:02) are entirely in that region: 30 kW is ~102 A at their pack voltage, so they never
    // enter the testable subset at all.
    //
    // 🟡 The ±2 A tolerance is also not a loose allowance — it is about one count of b3. If b3 is
    // integer kilowatts then one count is 1000 / pack_v ≈ 3.3 A, so the implied current cannot be
    // resolved better than roughly ±1.7 A no matter what. That also answers what the residual is
    // NOT: not a fixed offset and not a proportional margin, because it moves with the power band
    // — median +2.35 A at 5-9 kW, −0.95 at 10-14, −0.40 at 15-19, −1.85 at 20-24 — and scatter of
    // that size is exactly the ±1.65 A a 1 kW quantisation produces.
    //
    // What it is remains open, and the SIGN pattern is the reason to say so rather than stop
    // here: one rounding rule has one sign. Floor biases the residual positive in every band,
    // round-to-nearest centres it on zero in every band, and neither flips sign across bands the
    // way these do. A handful of distinct stations with distinct true powers, spread unevenly
    // over the bands (n = 239 in the top row against 30 248 in the bottom), fits better — which
    // is another way of saying the sample is four stations wearing a histogram, and one more
    // reason the corpus is not what settles this byte.
    //
    // The session split lines up with it. Seven of the eleven DC sessions keep b3 under 55 and
    // four park it at 79-81 (96 % of their frames), and in the eight sessions where the window
    // before the first amp is captured, the value b3 holds there predicts which half every time:
    // 50 in all four low ones, 64 in all four high ones.
    //
    // 🟢 Corroboration from a completely different direction: `src/vcu/write-targets.ts` records,
    // from the VCU-parameter side and on eight DC sessions, that "the ceiling is the STATION, not
    // the bike — station identity explains 84 % of the variance". A station-advertised figure
    // arriving in this frame is exactly what that observation predicts, and the two were derived
    // independently.
    //
    // ❌ AND IT IS STILL WRONG. Retracted 2026-08-19 by the test this comment asked for: each
    // session's charger identified from its own GPS track, the coordinates read out of the hub's
    // 0x410 fixes while current flowed. Every 0x620 frame with b0 != 0, b3 != 0xFF and
    // fast_dc_a > 0, grouped by site:
    //
    //     mode  range  n        coordinates          station
    //       81  35-82  73 378   57.10599, 13.03703   320 kW
    //       20  19-20   9 394   56.50180, 12.95666   225 kW
    //       22   9-50  27 583   56.65757, 12.90713   400 kW
    //       20  20-50  21 625   56.28432, 13.33884   300 or 400 kW
    //       23  19-50  10 372   57.71368, 11.89764   NOT IDENTIFIED
    //
    // Not the advertised power, and not a scaling of it: b3 is NOT MONOTONE in station power —
    // the 400 kW site reads 22 while the 320 kW one reads 81 — and the ratios (station kW over
    // modal b3) are 4.0, 11.3 and 18.2. No rounding, quantisation or unit choice reconciles
    // that. The mechanism, the supporting fit and the independent corroboration were all real
    // and all pointed at the wrong answer, which is the lesson worth keeping: three lines of
    // evidence agreeing is not the same as being right, and what settled it was one measurement
    // from outside the dataset.
    //
    // ⚠️ WHERE THE RATINGS COME FROM — the weakest link in the whole refutation, and the only
    // external input it has. The owner identified each charger from its coordinates on
    // 2026-08-19, from memory plus a map: no network name, no site name, no database, no rating
    // plate. One row is already hedged across a 100 kW range and a fifth site could not be
    // identified at all. Everything above is a measurement except this, so re-checking it is
    // where any attempt to overturn the retraction starts.
    //
    // 🔍 OPEN, and the strongest relation in the corpus — it survives the retraction and must not
    // be discarded with it. Per frame,
    //
    //     b3 == ceil(fast_dc_limit_a × pack_v / 1000)
    //
    // i.e. b3 in whole kilowatts of the power the BIKE is asking for, rounded up. Exact-integer
    // match per site: 92.7 % (225 kW), 82.3 % (300/400 kW), 69.8 % (400 kW), 59.5 %
    // (unidentified) — and 0.00 % at the 320 kW site. Allowing ±1 count, which is the same
    // 10 Hz/20 Hz skew across an edge that b0 shows below, those four sites reach 99.98 % over
    // 68 974 frames. NOTE THE OPERATOR — it is ceil, and floor is the easy mistake: floor scores
    // the same frames at 7-40 %, because the residual b3 − b0 × pack_v / 1000 is POSITIVE in
    // three quarters of them (p25 +0.04, p50 +0.38, p75 +0.49).
    //
    // That is not the selection effect an earlier draft dismissed it as. Over the matched frames
    // b3 spans 10…24 while b0 spans 30…75 A — a 2.5× range of the predictor — at pack voltages
    // from 274 to 323 V. A relation that tracks its predictor across that is not a coincidence
    // pinned at one operating point.
    //
    // ❓ And the one site where it fails, fails in the RETRACTED hypothesis's direction — which is
    // why this is filed as an open question and not as a decode. At 57.106 b3 holds at 79-82 while b0 falls
    // to 44 A and the delivered current tapers away underneath it: 2026-08-09 17:31→17:44,
    // fast_dc_a 14 A → 5 A with b3 pinned at 80/81 and b0 flat at 44 across 8 235 frames, median
    // residual +58.6 kW. There b3 cannot be derived from b0 — it behaves like a ceiling that b0
    // tracks WHEN IT BINDS and departs from when a pack-side taper binds first. That is the
    // retracted model with only the "= the station's nameplate rating" clause removed, and this
    // port cannot yet tell an available-power envelope from a readback of the bike's own
    // request. Nothing is emitted for b3.
    case CHARGE_LIMITS_CAN_ID: {
      if (data.length < 8) return [];
      // This frame's invariants, and it is the one whose dead-sender decode is hardest to spot.
      // An all-zero payload decodes to fast_dc_limit_a = 0 and ac_supply_limit_a = 0, and both
      // are LEGITIMATE — every DC frame reads b1 = 0 and every AC frame reads b0 = 0, and 31 529
      // real frames read both as 0 between sessions. So bounds.js cannot help, and the frame
      // reads as "plugged in, both ceilings at zero" rather than as a missing sender.
      //
      // b4-7 = 00 catches all-ones and the alternating pattern. b3 is what separates the all-zero
      // shape, and the argument for it is stronger than "never observed at 0": THIS BYTE ALREADY
      // HAS A "NOTHING TO REPORT" ENCODING AND IT IS 0xFF — 100.000 % of 807 907 AC frames plus
      // the 4 604 DC frames before a handshake completes. A field that spells "no figure" as 0xFF
      // is unlikely to also spell it as 0, and that argument survives the kilowatts reading above
      // turning out to be wrong. The observation that b3 is never 0 across 968 618 frames (lowest
      // 9) is then the confirmation rather than the whole case.
      //
      // The gate is the minimal `=== 0` and NOT the observed {0xFF} ∪ [9, 82], deliberately:
      // baking 9…82 in would harden a range this same change retracts, off eleven sessions at a
      // handful of stations. Values 1-8 and 83-254 pass, and should.
      //
      // ⚠️ Still the weakest of the four gates in this file, because b3 is the one byte here whose
      // MEANING is open. If the kilowatts reading is right and a station ever advertises zero,
      // this frame goes silent at the moment it gets interesting. Judged the better risk than a
      // decoder reporting "no ceiling on either path" for a sender that has stopped talking — but
      // if the limits ever vanish from a live session, look here first.
      //
      // ⚠️ And be clear what it does NOT buy. It removes the ambiguity for the dead-sender payload
      // only. A live reader still sees fast_dc_limit_a = 0 with ac_supply_limit_a = 0 on 31 529
      // real frames, so "both ceilings zero" remains an ordinary state downstream and nothing here
      // makes it mean "charging is impossible".
      //
      // 🟡 One invariant is deliberately NOT used, so that it is visibly a decision. b0 and b1 are
      // never both non-zero across all 968 618 frames — a 100.000 % invariant on the two bytes
      // actually decoded, and unlike b3 its meaning is not open, so `data[0] !== 0 && data[1] !== 0`
      // would catch a byte-shifted frame that slipped past b3 and the zero tail. It is left out
      // because it gates on the DECODE rather than on filler: a firmware that ever granted both
      // paths at once would go silent instead of showing the single most interesting frame this
      // ECU could produce. Gating on bytes we do not read is the safer half of that trade.
      if (data[3] === 0 || data[4] !== 0 || data[5] !== 0 || data[6] !== 0 || data[7] !== 0) return [];
      return [
        // ✅ b0 = the DC current limit in force right now, in amps — the one of the three DC
        // limits on this bus that moves during a session.
        //
        // 🧨 It was put to a direct test, because #79 read the same byte as "not a limit at
        // all — it follows the delivered current", having watched it ramp 0 → 22 → 44 → 66 →
        // 75 → 66 → 44 and read 44 while only 10 A flowed. If that were right, naming it a
        // limit would be this project's `charging`-was-the-high-beam mistake over again.
        //
        // Re-measured at full frame rate over 151 202 aligned (0x620, 0x615) samples in which
        // current is actually flowing, across all 11 DC sessions:
        //
        //     b0 − b2 == 0 (hugging the delivery):     0.005 %      ← an echo lives here
        //     b0 − b2 >= 5 A of headroom:               79.2 %
        //     b0 − b2 median 12 A, p75 28 A, p95 41 A
        //     b2 > b0 (the bound broken):               0.033 %
        //
        // The 2026-08-19 pass had 10 771 of these samples and reported 0.0 / 83.9 / 12 / 28 / 44
        // / 0.4. The conclusion is unchanged and the medians are identical; the two figures that
        // moved are both tail statistics, and they moved in the direction the sampling predicts.
        // A change-plus-keepalive scanner over-represents frames that are CHANGING, and both
        // b2 > b0 (0.4 % → 0.033 %) and the p95 headroom live on edges, so the sample saw an
        // edge roughly twelve times more often than the bus produces one. Worth knowing before
        // quoting any of the remaining sampled percentages in this file.
        //
        // The 44-while-10-A reading is the headroom case, not a contradiction: session 27's
        // median gap is 35 A because the pack was at 99 % and taking almost nothing.
        //
        // 🟡 But headroom is a NEGATIVE, and a negative cannot separate a raw echo from a
        // SCALED one — `b0 ≈ 1.2 × b2` would show exactly the same never-touching. The ratio is
        // what kills that, and the ratio is nothing like constant: b0 ÷ b2 has p5 1.03, median
        // 1.19, p95 7.33 and a maximum of 75.0, and its per-session median runs from 1.03 to
        // 9.20. No scale, no offset, no quantisation of the delivered current produces that.
        //
        // ✅ And two POSITIVE tests, which is what actually makes this a limit rather than
        // merely not-an-echo. A readback of delivery cannot do either of these:
        //
        //   • b0 STEPS WHILE THE DELIVERY IS FLAT. Of the 884 b0 steps in the DC sessions, 396
        //     happen with b2 unchanged to within ±2 A for two seconds either side. 2026-08-04
        //     20:13:29 b0 75 → 64 while b2 held 55 A; 2026-08-08 13:37:47 b0 75 → 66 while b2
        //     held 43-44 A, and back up 66 → 75 two seconds later with b2 still at 43-44.
        //   • b0 LEADS THE FIRST AMP. In all eight DC sessions whose ramp-up is captured, b0
        //     goes 0 → 75 between 13.0 and 19.1 s BEFORE b2 leaves zero — e.g. 2026-08-04
        //     19:58:28.65 against a first amp at 19:58:45.51. This is the same argument that was
        //     already accepted for b1, whose 10 → 13 step preceded the AC setpoint by 120 ms,
        //     and it is much longer than the ~3 s state-machine handshake.
        //
        // Between them: it bounds the delivery with room to spare, it moves when the delivery
        // does not, and it is up before there is any delivery to echo. It is a limit.
        //
        // ⚠️ What it is NOT is a command, and #79 is right about the direction of causation.
        // On 2026-08-04 it dropped 75 → 64 eleven seconds AFTER the delivered current had
        // already fallen to 55.6 A. It reacts to the station.
        //
        // ⚠️ And "in force" must NOT be read as "binding". `b0 − b2 == 0` in 0.005 % is the
        // statistic that kills the echo, and it says in the same breath that the corpus contains
        // essentially no observation of this byte ever CONSTRAINING anything. The defensible
        // claim is "a ceiling the delivery has never violated", not "the constraint doing the
        // limiting" — which was something else the whole time, and there are at least three
        // candidates: a pack-temperature or SOC derate, the rider's own 0x121 setting, and the
        // station's own envelope. A reader who takes "in force" as "binding" will be surprised
        // later.
        //
        // The 50 frames where b2 > b0 are not counter-evidence: 49 of them fall within 1.00 s of
        // a b0 step and the fiftieth is exactly 1.00 s from one, so all are the 10 Hz/20 Hz skew
        // across an edge, none is a sustained violation, and the overshoot never exceeds 12 A.
        //
        // ❓ And whose limit it is stays open — MORE open than it looked, since b3's
        // station-advertised reading, cited here as support, was refuted on 2026-08-19 against
        // four identified chargers (see b3 above). Vehicle-advertised and station-granted look
        // identical from this port, and both would bound delivery and both would move when the
        // station derates.
        // All that is established is that it never exceeds 0x625 b2's configured 75. So the name
        // says which limit (the live one) and not whose.
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
    // 100.000 % of 1 571 617 frames. b0 is left undecoded: it reads 0x6B everywhere until
    // 2026-08-09 17:55 and 0x73 in every capture after, a one-way change that no charge event
    // in the corpus lines up with.
    case CHARGE_CONFIG_CAN_ID: {
      if (data.length < 8) return [];
      // Refuse a frame that does not carry this frame's own invariants. b1 = 0x01 and
      // b3 = 0xFF hold in 100.000 % of 1 571 617 frames, and checking them costs nothing —
      // whereas trusting b4 blindly is actively dangerous, because b4's DC bit is read
      // INVERTED. An all-zero payload has bit 5 clear and would decode to "DC charging";
      // an all-ones payload has bit 2 set and would decode to "AC charging". Those are
      // precisely the two shapes check-can-decoders.ts calls out as what a dead or
      // disconnected sender produces, and because both keys are legitimately 0/1,
      // bounds.js cannot reject either — a false charge claim would reach the log and the
      // dashboard looking like an ordinary flag. This turns both back into "no reading".
      //
      // ⚠️ The gate is on b1/b3 and NOT on a whitelist of b4 values, and that is a tested
      // decision rather than a stylistic one. b4 takes NINE values across the archive, not the
      // three named below — a b4 whitelist drawn from the three would have rejected 129 601 real
      // frames. See the b4 comment for the full list.
      if (data[1] !== 0x01 || data[3] !== 0xff) return [];
      const flags = data[4];
      return [
        // ✅ b2 = the configured maximum DC charge current, 75 A. Static in 100.000 % of
        // 1 571 617 frames — through DC sessions, AC sessions and parked alike — and equal to
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
        // ⚠️ Those three are the COMMON values, not the whole set, and the difference is what
        // decides how this frame is gated. Over all 1 571 617 frames b4 takes nine values:
        //
        //     0x2C 748 103   0x32 542 726   0x12 151 187   0x29  76 724   0x6C  36 564
        //     0x72  15 466   0x2D     495   0x2E     347   0x52       5
        //
        // All nine satisfy both bit rules above, so the decode is unaffected — but a whitelist
        // of {0x12, 0x2C, 0x32} as the frame's sanity check would have thrown away 129 601 real
        // frames, 8.2 % of them. That is why the gate above reads b1/b3, which are genuinely
        // constant, rather than the byte whose meaning we are trying to read. Anyone hardening
        // this frame further will look at the three named values and reach for the whitelist;
        // this is the note saying it was tried and is wrong.
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
