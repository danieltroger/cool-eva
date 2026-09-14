// 0x102 `VCU_DIGITALS` — the VCU discretes on bytes 0 and 3. Pure: one byte in, values
// out. Three files decode this frame and the split is NOT on byte boundaries: decode.ts
// keeps b0 bit 6 (`high_beam`), b1 and b2; this file has b0's other seven bits and all of
// b3; attitude.ts has b4-7. b3's length guard stays at decode.ts's call site, with the
// comment that argues for it. The name is Energica's own for the block (the 2024
// service-tool analysis in `obd-garage/`, §`0x102`, 34 signals).

import { type DecodedValue, bit } from "./frame.ts";

// 0x102 byte 0's low bits — the left pod's momentary buttons, as VCU discretes.
//
// Added 2026-08-16. These four are the ones Energica's free-frame table names
// `Left/Right/Enter Mode Switch` and `RST Switch`. Bits 3 and 4 are the indicator
// switches, decoded since 2026-09-14; which of the two is which was settled 2026-08-19.
//
// Of the other two: bit 6 is `high_beam`, read in decode.ts's 0x102 case (a flash-to-pass, which
// is what the dashboard's own gesture counts). Bit 7 is `V_LOW_BEAM_SW`, the LOW BEAM
// SWITCH, and it is decoded below.
//
// ⚠️ It carried no key until 2026-09-14; the reversal, and why a switch agreeing with its
// lamp in all 15 006 856 frames is the BASELINE rather than a reason to drop one, is in
// docs/can-decode-findings.md §"Byte 0's switches".

// What makes these more than "the bit moves" is that the six low bits split cleanly into
// two behaviours, and the split is the one the owner's manual predicts — bits 0-2 are
// pressed at a standstill (0/76, 4/141 and 0/40 above 3 km/h, where the manual says the
// menu is locked out) while bits 3-5 are pressed only while riding (41/41, 23/24, 63/63).
// Nothing about "a bit toggles" forces that pattern; it is what a speed-locked menu and a
// set of turn signals actually look like, from opposite ends of the same byte. Press
// counts and durations: docs/can-decode-findings.md § "Byte 0's low bits".
export function handlebarSwitches(handlebar: number): DecodedValue[] {
  return [
    // bits 0 and 1 — the MODE pair. ✅ CONFIRMED as menu buttons (76 of 76 presses at
    // a standstill for bit 0, 137 of 141 for bit 1, both transient at ~0.13 s).
    //
    // ✅ LEFT-vs-RIGHT CONFIRMED 2026-08-19, by INSTRUCTED PRESS rather than ride context:
    // no recorded ride can separate ◀ from ▶, because both do the same thing to the same
    // menu, so it had to be staged. Each block of eight presses was fenced by a counted
    // number of indicator-cancel clicks — the best-identified bit on the byte — so the
    // capture times and labels its own blocks with no synchronised clock or narration.
    // 8/8 each, never outside its block. ⚠️ The anchor is the rider's own ◀/▶ naming of
    // the pod, so a pair of mislabelled CAPS would still read as confirmed; nothing else
    // in this file depends on the order. Detail: docs/can-decode-findings.md § "bits 0 and 1".
    { key: "btn_mode_left", value: bit(handlebar, 0) },
    // bit 1 has two behaviours bit 0 does not, both measured 2026-08-19. The old advice —
    // "treat bit 1 as the less trustworthy of the pair" — was a reasonable reading of an
    // unexplained hold and is WITHDRAWN: the first is a second FUNCTION, not a fault.
    //
    // 1. 🟡 Two 0.81 s holds at 88 km/h are ▶ ADJUSTING THE CRUISE SET SPEED, not menu
    //    presses: they land between arming cruise and the SET press, at a speed where the
    //    menu is unreachable (stationary-only, >3 km/h exits it), and the owner confirms
    //    it. One arming event, so this is the best explanation rather than settled.
    // 2. Held 191.2 s while AC charging, with nothing else on the bars moving and six
    //    ordinary presses 0.1 s after release — an object resting on the button. The
    //    measurement shows an object, not which object.
    //
    // ⚠️ So a multi-minute HOLD is a state this bit really reaches: code that counts
    // presses or assumes momentary must not treat a long assertion as impossible.

    // ⚠️ Both of those are SINGLE captures. Do NOT concatenate the archive's overlapping
    // captures before measuring: two candump instances recorded the same seconds, so a
    // merged file interleaves duplicate frames and turns one hold into hundreds of 10 ms
    // toggles. That artefact was produced and discarded while measuring this.
    // Timings and the full sequence: docs/can-decode-findings.md § "bits 0 and 1".
    { key: "btn_mode_right", value: bit(handlebar, 1) },
    // bit 2 — MODE ENTER. ✅ The cleanest of the three, and the only decoded handlebar
    // bit in the CAPTURE archive with no long press anywhere: 160 presses, 0.010-0.290 s,
    // median 0.140 s. That is what qualified it to carry the fan's 1200 ms hold gesture.
    // ⚠️ "No long press anywhere" is that corpus only — the ride log has four at or past
    // 1200 ms. docs/handlebar-gestures.md §"Long ENTER presses in the ride log".
    //
    // 🚨 "Every one below 3 km/h" was true of 40 presses and is FALSE of 160 — five were
    // made at 47-118 km/h. Corrected 2026-09-08; docs/can-decode-findings.md § "bit 2"
    // has the frames, and docs/handlebar-gestures.md what it does and does not change.
    { key: "btn_mode_enter", value: bit(handlebar, 2) },
    // bits 3 and 4 — the turn-indicator SWITCHES, `V_R_TURN_SW` and `V_L_TURN_SW`.
    //
    // 🚨 BIT 3 IS RIGHT AND BIT 4 IS LEFT, the OPPOSITE of the .xdbc's order. Measured
    // 2026-08-19 over the whole archive by asking which blinker lamp each rising edge
    // started: bit 3 started the right lamp 437× against the left 5×, bit 4 the left 328×
    // against the right 2×. ✅ Energica's own table now agrees, naming bit 3 `V_R_TURN_SW`
    // — a second witness against the third-party file, which was already caught calling
    // the high beam `charging`. Do not "fix" the order from it.
    //
    // They are in `controls` and not `buttons`, so the BUTTONS section keeps two tiles for
    // two indicators rather than four; what a rider means by "is my indicator on" is still
    // the lamp. The switches answer the other question — a failed bulb against a missed
    // press. 10 039 / 6 673 frames and 464 / 361 rising edges archive-wide.
    { key: "blinker_switch_right", value: bit(handlebar, 3) },
    { key: "blinker_switch_left", value: bit(handlebar, 4) },
    // bit 7 — `V_LOW_BEAM_SW`, argued in this function's header. Here rather than with the
    // beam lamps because this byte is the SWITCH byte; `low_beam_lamp` is b2's output.
    { key: "low_beam_switch", value: bit(handlebar, 7) },

    // bit 5 — the indicator-cancel press (push the turn switch in). ✅ CONFIRMED, and
    // this is the strongest identification of the seven: all 63 presses happened with
    // an indicator lamp actually flashing, 63 out of 63, and in 28 of them the lamp
    // stopped within 3 s. Indicators were running for a few hundred seconds out of
    // hours of capture, so 63/63 is not a coincidence. The 41 + 24 = 65 indicator
    // switch presses on bits 3/4 against 63 cancels is the same story counted twice.
    { key: "btn_indicator_cancel", value: bit(handlebar, 5) },
  ];
}

// 0x102 byte 3 — all eight bits. Named `contactorAndCruise` while it decoded two of them;
// renamed 2026-09-14 when the rest of the byte arrived and the contactor and the cruise state
// became the two least representative members of it.
//
// Added 2026-08-16. This byte was written off as "a constant 0x44" when 0x102 was
// first decoded, which is true of a parked bike and false of a charging one: across
// the 14 captures it takes five values — 0x44 (88.4 %), 0x45 (9.4 %), 0x46 (1.2 %),
// 0x04 (1.0 %) and 0x06 (0.02 %).
//
// 🚨 "Bit 2 is set in all five and never once clear in 1 103 000 frames" was true of that
// sample and is FALSE of the archive: `V_DSB_CTRL` is clear in 279 of 15 006 856 frames.
// Corrected 2026-09-14; docs/charge-manager.md caught the same thing first and said 278,
// which this supersedes (that pass predates seven of the archive's candump logs). Every
// bit of this byte is now decoded, each with what the corpus does and does not show.

// 🚨 "bits 3, 4, 5 and 7 are never set" USED TO BE THE WHOLE OF THIS SENTENCE AND IT WAS
// MISLEADING. It is a measurement over the 2026-08 capture archive, a corpus in which the
// bike never fell over, never went into winter storage and never had ABS switched off —
// so for bits 4, 5 and 7 it is an absence of the occasion rather than evidence the bits
// are dead. Energica's own table names all four: bit 3 `V_IMD_DISABLE`, bit 4
// `V_WINTER_STORAGE`, bit 5 `V_LIEDOWN_DETECTED`, bit 7 `V_ABSOFF` (the 2024 service-tool
// analysis in `obd-garage/`, §`0x102` `VCU_DIGITALS`). Bit 5 is decoded below.
export function vehicleFlagsByte3(byte3: number): DecodedValue[] {
  return [
    // bit 0 — `V_FASTDC_MON_SW`, the DC fast-charge contactor state monitor, and the
    // analog wire `A020_FCHG_MON` it corresponds to. ✅ CONFIRMED, and it is the
    // best-evidenced bit in this change:
    //
    //   • Set in exactly one interval of the 14-CAPTURE corpus — 1038.1 s on 2026-08-04,
    //     103 790 of those 1 103 000 frames. ⚠️ Archive-wide it is 1 512 726 frames with 11
    //     rising edges, so "exactly one" is that sample and not the bike's history.
    //   • That interval is a DC fast charge, from the pack's own frames: −0.1 A to +63.2 A
    //     within 4.6 s of the rise, SOC 30 % → 42 %, and no 0x305/0x306 at all.
    //   • It LEADS the charge — 190 ms before `charger_enabled`, ~470 ms before the first
    //     positive pack amp — which is what a contactor monitor should do.
    //   • It reads 0 through every AC charge in the corpus, so it discriminates DC from AC
    //     rather than just meaning "plugged in", which is the whole reason to want it.
    { key: "fast_dc_contactor", value: bit(byte3, 0) },
    // bit 1 — cruise control armed. ✅ CONFIRMED 2026-09-14 over the whole archive: all 35
    // rising edges of this bit fall 0.513-0.574 s after a `btn_cruise_enable` press on
    // 0x400, 35 of 35, median 0.538 s, and there is no unexplained onset in 15 006 856
    // frames. The two events this rested on before reproduce inside that to the
    // millisecond. It was 🟡 "inferred from exactly two events" until then.
    //
    // 🚨 The table DOES name it, and the name disagrees with the measurement:
    // `V_CHGSW_CTRL`. "Not in any vendor table" was false. The key keeps our name — a
    // controller does not wait half a second for a handlebar button 35 times running, and
    // where a table contradicts something measured on this bike, ours wins. 🟡 Corroborating
    // only: it is set in 0 of 275 879 frames where `fast_dc_contactor` is also set, which
    // rules out a DC charge switch and says nothing about AC. docs/can-decode-findings.md.
    { key: "cruise_active", value: bit(byte3, 1) },
    // bit 2 — `V_DSB_CTRL`. 🟡 Named, and characterised rather than understood: clear in
    // 279 of 15 006 856 frames, in exactly two contiguous windows (2026-08-02, 153 frames /
    // 1.52 s and 2026-08-09, 126 / 1.25 s). In both, bytes 0-2 are all `00` — every lamp,
    // switch and state bit dark — and in the second `fast_dc_contactor` rises 0.919 s after
    // it clears, the bit returning 0.330 s later. A transient at a vehicle transition.
    { key: "dsb_control", value: bit(byte3, 2) },
    // bits 3, 4 and 7 — `V_IMD_DISABLE`, `V_WINTER_STORAGE`, `V_ABSOFF`. 🟡 All three read 0
    // in every one of the 15 006 856 archive frames. ⚠️ That is an absence of the OCCASION,
    // not evidence the bits are dead: this bike has not been in winter storage, has had no
    // insulation-monitor event and has never had ABS switched off in the corpus. Decoded
    // ahead of the occasion, the way vcu-flags.ts decodes eleven never-fired VCU errors.
    //
    // `vcu_abs_off` carries the prefix the other two do not because every other `abs_*` key
    // comes from 0x0A0, the ABS module; this is the VCU's bit.
    { key: "imd_disable", value: bit(byte3, 3) },
    { key: "winter_storage", value: bit(byte3, 4) },
    { key: "vcu_abs_off", value: bit(byte3, 7) },
    // bit 5 — `V_LIEDOWN_DETECTED`, the VCU's own fall flag. ✅ CONFIRMED against this bike
    // 2026-09-14, from the Pi's own candump of the boot it happened on: exactly one
    // transition in the 60 s around the fall, 0.669 s after the roll peak and 0.551 s
    // BEFORE the VCU cut the drive.
    //
    // ⚠️ It LEADS the shutdown, which is what makes it a detector rather than a
    // consequence — the argument `fast_dc_contactor` above rests on — and it is not a
    // threshold on the attitude pair, since at the peak 681 ms earlier and 104° over it
    // still read 0. ⚠️ A 0 therefore means "the VCU has not flagged a lie-down", NOT
    // "upright", and this is not a fall sensor for anything safety-bearing: one event
    // identifies it. Timings and counts: docs/can-decode-findings.md §5.
    { key: "lie_down_detected", value: bit(byte3, 5) },
    // bit 6 — `V_MAG_GOOD`. 🟡 The name is the table's and "MAG" is not obviously magnet,
    // magnitude or magneto, so nothing is guessed here. What is MEASURED is that it drops
    // briefly and almost only at speed: set in 14 607 648 of 15 006 856 frames with 47 020
    // rising edges, mean speed 87.7 km/h while clear against 18.1 km/h while set, and
    // 398 202 of the 399 208 clear frames above 5 km/h. Against 0x102's own `moving` bit it
    // is clear in 172 of 11 237 945 stopped frames and 399 036 of 3 768 911 moving ones.
    // Clear runs are short — 9 719 of one frame, 6 942 of two.
    //
    // ⚠️ The most expensive key in this change by two orders of magnitude: 94 137 rows over
    // 41.7 h of frame-time, ~2 258 rows/h, against ~60 rows/h for the other eight 0x102 bits
    // together — and, because it is usually the only signal moving in its tick, it rarely
    // coalesces, so it also costs ~2.5 extra WebSocket patches a second while riding (free with
    // no phone attached: ws.ts early-returns on zero clients). A deadband cannot reduce either
    // — |1 − 0| > 1 is false — and the 47 020 edges are the whole reason to want it.
    { key: "mag_good", value: bit(byte3, 6) },
  ];
}
