// The ABS module's broadcast, CAN 0x0A0 `ABS_INFO` at 10 Hz. Wheel speeds, the ABS
// warning lamp, front brake pressure — which is a quantity nothing else on this bus
// carries, and the reason this frame was worth chasing — and six flags.
//
// Layout is Energica's own, out of the `FramesDB.ParseABS_INFO` handler in the service
// tool (the 2024 service-tool analysis in obd-garage/, §`0x0A0` `ABS_INFO`), confirmed
// against this bike's own captures rather than taken on trust:
//
//   b0-1 LE  A_F_SPD_SENS   front wheel speed
//   b2-3 LE  A_R_SPD_SENS   rear wheel speed
//   b4       A_WARN_LAMP    mask 0x0C >>2 · A_FSENS_FAIL 0x10 · A_RSENS_FAIL 0x20 · A_EVENT 0x80
//   b5       A_F_PRESSURE   front brake pressure
//   b6       A_F_PRESSURE_VALIDITY bit0 · A_F_CTRL_ACTIVE bit1 · A_R_CTRL_ACTIVE bit2
//
// 📘 The ABS module is NOT on the bus this app taps — Energica's wiring schematic puts it
// on DTB, our tap is on VDB, and 0x0A0 reaches us only because the VCU gateways it across.
// So these ten signals are the whole interface: the module never answered a diagnostic
// sweep because it could not, and anything it knows that the VCU does not re-broadcast is
// unreachable from here rather than merely undiscovered. A flag never seen set can only be
// confirmed by making the bike assert it, which is why the unobserved ones are on issue #51.
//
// ⚠️ The 2026-08-02 garage lap was actively MISLEADING about this frame — it never exceeded
// 11.5 km/h, and every quantitative claim derived from it about the wheel speeds turned out
// to be an artefact. Flag counts below are over all 565 376 frames of this id in the archive
// (245 files, rescanned 2026-08-20); scales are fitted against GPS over two road captures.
//
// Full working — corpus, fits, refuted hypotheses and match rates — in
// docs/can-decode-findings.md § "0x0A0 — ABS_INFO".

import { type DecodedValue, bit, u16le } from "./frame.ts";

export const ABS_CAN_ID = 0x0a0;

/**
 * Decodes one 0x0A0 frame. Pure: bytes in, values out.
 *
 * Flags read through `bit()` rather than the vendor's masks written literally
 * (`data[4] & 0x10`), which would yield 16 rather than 1 and be rejected downstream as a
 * dead sensor — the exact mistake public/lib/bounds.js gates against after `high_beam`
 * once logged 193. The vendor mask is named beside each so the bit index can still be
 * checked against `ParseABS_INFO` at a glance.
 *
 * ⚠️ A wheel count of 0xFFFF is a sentinel and DOES occur on the road (120 frames archive-
 * wide). It is passed through, arriving as 3686.34 km/h, so bounds.js can show it as the
 * fault it is — deliberately the OPPOSITE call to 0x10B, whose sentinel decodes to a
 * value bounds.js would accept. See the doc; scripts/check-can-decoders.ts pins both.
 */
export function decodeAbsFrame(data: Buffer): DecodedValue[] {
  if (data.length < 6) return [];
  const values: DecodedValue[] = [
    { key: "wheel_speed_front_kmh", value: u16le(data[0], data[1]) * WHEEL_SPEED_KMH_PER_COUNT },
    { key: "wheel_speed_rear_kmh", value: u16le(data[2], data[3]) * WHEEL_SPEED_KMH_PER_COUNT },
    { key: "abs_warning_lamp", value: (data[4] & 0x0c) >> 2 },
    { key: "abs_front_sensor_fault", value: bit(data[4], 4) }, // A_FSENS_FAIL, mask 0x10
    { key: "abs_rear_sensor_fault", value: bit(data[4], 5) }, // A_RSENS_FAIL, mask 0x20
    { key: "abs_event", value: bit(data[4], 7) }, // A_EVENT, mask 0x80
    { key: "front_brake_pressure_bar", value: data[5] },
  ];
  // b6 keeps its own guard so a short frame cannot silence the four signals logged since
  // 2026-08-16 on account of these three — the same arrangement 0x109's throttle and
  // 0x660's offset pair use. Every one of the 565 376 frames on disk is DLC 8, so this has
  // never been the false branch; it is here because b6 read out of CAN padding would report
  // "pressure invalid, no channel active", which reads as a healthy answer, not a short frame.
  if (data.length >= 7) {
    values.push(
      { key: "abs_front_pressure_validity", value: bit(data[6], 0) }, // A_F_PRESSURE_VALIDITY
      { key: "abs_front_control_active", value: bit(data[6], 1) }, // A_F_CTRL_ACTIVE
      { key: "abs_rear_control_active", value: bit(data[6], 2) } // A_R_CTRL_ACTIVE
    );
  }
  return values;
}

// Energica's `f(x)=x*0.05625` km/h per count — 3.6/64, i.e. a count is 1/64 m/s, a WIRE
// ENCODING rather than a calibration.
//
// ✅ Confirmed against GPS 2026-08-16 over 274 steady-state samples in 15 stretches: front
// fits 0.05685 (+1.07 %), rear 0.05657 (+0.56 %). The residual is this bike's tyres against
// the circumferences the ABS ECU has already applied, not an error in the constant, so the
// fitted pair is deliberately NOT shipped — it would drift with the tyres and break the one
// property that makes this frame useful, that front and rear are directly comparable. For
// GPS-true speed multiply front by 1.0107 and rear by 1.0056, and re-measure after a tyre change.
//
// ❌ Two hypotheses refuted here rather than left to be re-derived: a 4 % scale error and a
// 9 % channel disagreement (both artefacts of the garage lap — the road ratio is 0.995), and
// raw pulse rates against one nominal circumference (predicts the front/rear ratio backwards,
// 0.934 against a measured 1.006). Working, sample budget and RMS table in the doc.
const WHEEL_SPEED_KMH_PER_COUNT = 0.05625;

// b5 `A_F_PRESSURE` — ✅ the FRONT circuit BY MEASUREMENT, not by its name: pressing the rear
// pedal alone holds b5 at 0 bar through all 434 frames of it, while the front lever drives it
// to 8. ⚠️ The SCALE is still Energica's word (identity equation, 1 count = 1 bar) and nothing
// on this bus carries a second pressure to check it against. 🟡 That the rear has no pressure
// channel at all is an absence in two documents, not a measurement — "none is known".
//
// b4 `A_WARN_LAMP` — ⚠️ a TWO-BIT field (0…3), not a flag, and the vendor's mask is kept
// unnarrowed: bounds.js names it [0, 3] so the `diag` boolean rule cannot reject a 2 or a 3,
// and it carries no deadband, which at 1 would log |2 − 0| while dropping |1 − 0|.
//
// b1/b3 are NOT dead — the garage lap just never reached 256 counts (14.4 km/h); they peak at
// 1748/1766 on the road. b7 is 0x00 in all 565 376 frames and the vendor names nothing in it.
//
// Evidence for all three in docs/can-decode-findings.md § "0x0A0 — ABS_INFO".

// The six flags. Three have been watched firing, three never have, and "reads 0" means
// something completely different in the two cases. Census, per-band rates and the
// traction-control cross-tabulation: docs/can-decode-findings.md § "The six flags".
//
// ✅ `abs_event` (b4 0x80), `abs_rear_control_active` (b6 0x04) and `abs_front_control_active`
// (b6 0x02): 162 frames in 61 bursts across 15 captures, and A_EVENT is set in exactly the
// frames where b6 ≠ 0, 162 of 162 both directions. The lamp bits are clear in all 162, so an
// intervention is NOT a fault — do not alert on these as one.
//
// ❌ What causes them is NOT traction control, for the throttle-open majority. The bike never
// cuts torque at them (0 of 83 testable), and its own `V_TC_EVENT` — which fires 1326 times
// at 77 % throttle and +138 Nm — is set at only 4 of the 162. ❓ What they ARE is unresolved
// and deliberately left so. Only the braking/regen population has confirmed lockup signatures.

// ⚠️ A one-sample wheel-speed excursion is read as real under brake and discounted under drive
// torque. That asymmetry is physical, not two standards: a caliper can lock a wheel and the
// road can spin it back inside 100 ms, whereas shedding 4.56 km/h against +19.7 Nm of drive
// torque needs ~48 Nm net that nothing on the bike supplies. The test is the sign against the
// applied torque, not the duration.

// ⚠️ `abs_front_sensor_fault` (0x10) and `abs_rear_sensor_fault` (0x20) are 0 in all 565 376
// frames: no evidence either way, which is precisely why they are decoded BEFORE they fire.
// Their positions are Energica's word alone. 🔎 A reading of 1 in the same window the bike
// stores P0500/P2158 would confirm them outright — the ride log already carries both sides.

// ❓ `abs_front_pressure_validity` (b6 bit0) is 0 in every frame, including 13 635 where the
// pressure demonstrably works, so "1 = valid, never asserted" and "polarity inverted" are both
// live. ⚠️ `front_brake_pressure_bar` is therefore NOT gated on it and must not be: both
// readings make gating wrong today. Do not add a validity check from the vendor DB.

// ⚠️ The dash over-reads by ~3.5 % (0x104 against GPS, corroborated by the odometer at
// +3.43 % from a separate accumulator) — recorded because it is what the wheel-speed scale
// above was originally, and wrongly, measured against. Do not calibrate anything here against
// 0x104. Four times smaller than the "10-20 km/h over" commonly reported, and inside UNECE
// R39. ❓ Where the 3.5 % lives is not settled; see the doc.
