// The ABS module's broadcast, CAN 0x0A0 `ABS_INFO` at 10 Hz. Wheel speeds, the ABS
// warning lamp, front brake pressure — which is a quantity nothing else on this bus
// carries, and the reason this frame was worth chasing — and six flags.
//
// Layout is Energica's own, out of the `FramesDB.ParseABS_INFO` handler in the service
// tool (the 2024 service-tool analysis in obd-garage/, §`0x0A0` `ABS_INFO`). All ten
// signals it names are decoded below:
//
//   b0-1 LE  A_F_SPD_SENS   front wheel speed
//   b2-3 LE  A_R_SPD_SENS   rear wheel speed
//   b4       A_WARN_LAMP    mask 0x0C >>2 · A_FSENS_FAIL 0x10 · A_RSENS_FAIL 0x20 · A_EVENT 0x80
//   b5       A_F_PRESSURE   front brake pressure
//   b6       A_F_PRESSURE_VALIDITY bit0 · A_F_CTRL_ACTIVE bit1 · A_R_CTRL_ACTIVE bit2
//
// That layout is CONFIRMED against this bike's own 2026-08-02 garage lap (4087 frames of
// 0x0A0 in `~/Documents/cool-eva-archive/ride-2026-08-02.log`), re-derived rather than taken
// on trust, and re-checked on 2026-08-16 against two ROAD captures in
// `~/Documents/cool-eva-archive/ride-captures3/` — `capture-20260804-035631-c8fe853f.log`
// (16 188 frames, to 98 km/h) and `capture-20260804-193952-4b4cdd2b.log` (17 435 frames).
// The six flags were added on 2026-08-19 against those three plus two more from that day,
// `capture-20260819-172725-178e8719.log` (8373) and `buttons-2026-08-19.log` (2840).
//
// ⚠️ 2026-08-20: the flag counts are now taken over **every** capture in the archive rather than
// those five — 245 files, **565 376 frames** of this ID, which is the number every count below is
// out of. That is 12× the old corpus and it changed three of the conclusions, including one that
// said a flag had never been seen when it had. The five-capture figures are kept where they are
// still the right ones (the GPS calibration below is a fit against two specific rides, not a
// census), and the flags section says explicitly where the wider scan overturned it.
// What the captures prove, and what they do not, are deliberately kept apart below.
//
// ⚠️ The garage lap alone was actively MISLEADING about this frame, which is the main lesson
// here and the reason the road captures are named above. It never exceeded 11.5 km/h and never
// left walking-pace manoeuvring, and every quantitative claim derived from it about the wheel
// speeds — the scale, and the "9 % channel disagreement" — turned out to be an artefact of
// that. A frame is not characterised until it has been seen at the speeds it exists for.
//
// ## Why this frame is all there will ever be from the ABS
//
// 📘 Read off Energica's own wiring schematic (recorded 2026-08-19, from the topology and not
// from this bus — nothing in the captures could show it): **the ABS module is not on the bus
// this app taps.** The schematic puts it on the **DTB** bus; our tap is on **VDB**, and 0x0A0
// reaches us only because the VCU gateways it across. That single fact explains two things
// that otherwise look like our bugs:
//
//   • **The ABS never answered any diagnostic sweep.** A KWP/UDS request addressed from VDB
//     cannot reach an ECU that only listens on DTB, so the silence was the topology and not a
//     wrong address or a missed timing window. Energica's own tool carries no ABS live-data
//     catalogue either, which is the corroborating half: there was never anything to sweep for.
//   • **These ten signals are the whole interface.** Anything the ABS module knows that the
//     VCU does not choose to re-broadcast is not merely undiscovered, it is unreachable from
//     here. So "there is no rear brake pressure on this bus" is structural, not a gap in the
//     search — see the `A_F_PRESSURE` note further down.
//
// Consequence for everything below: a flag that has never been seen set cannot be confirmed by
// asking the module. It can only be confirmed by making the bike assert it. That is why the
// unobserved four are filed on issue #51 as on-bike experiments rather than left undecoded.

import { type DecodedValue, bit, u16le } from "./frame.ts";

export const ABS_CAN_ID = 0x0a0;

/**
 * Decodes one 0x0A0 frame. Pure: bytes in, values out.
 *
 * The six flags read through `bit()` rather than the vendor's masks written literally
 * (`data[4] & 0x10`), which would yield 16 rather than 1. That is not a hypothetical
 * slip: it is the exact mistake public/lib/bounds.js gates the boolean groups against
 * after `high_beam` once logged 193, and a flag arriving as 16 would be rejected as a
 * dead sensor rather than shown. The vendor mask is named in the comment beside each so
 * the bit index can still be checked against `ParseABS_INFO` at a glance.
 *
 * ⚠️ A wheel count of 0xFFFF is a sentinel and it DOES occur on the road — 10 frames across the
 * two 2026-08-04 captures, and **120 across the whole archive**. It is passed through, arriving
 * as 3686.34 km/h, and that is deliberate
 * rather than an oversight: public/lib/bounds.js gates both wheel speeds to [0, 300], so it shows
 * as a fault, which is what the repo wants a dead sensor to look like.
 *
 * Note this resolves the same situation the OPPOSITE way to 0x10B, which drops its saturated
 * 65000 in the decoder — and the difference is the point rather than an inconsistency to tidy
 * away. 0x10B's sentinel decodes to 65 kWh/100 km, which bounds.js would ACCEPT, so nothing
 * downstream could ever catch it and the decoder is the only place it can be stopped. 3686 km/h
 * cannot be mistaken for a reading by anything. Dropping it here would be strictly worse: the
 * frame would go silent exactly when a wheel sensor has failed, which is the moment the signal
 * exists for. The replay cases in scripts/check-can-decoders.ts pin both behaviours.
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
  // b6 keeps its own guard so that the four signals logged since 2026-08-16 cannot be
  // silenced by a short frame on account of these three — the same arrangement 0x109's
  // throttle and 0x660's offset pair already use. Every one of the 565 376 frames on disk
  // is DLC 8, so this branch has never yet been the false one; it is here because a
  // truncated frame decoding b6 out of CAN padding would report "pressure invalid, no
  // channel active", which reads as a healthy answer rather than as a missing byte.
  if (data.length >= 7) {
    values.push(
      { key: "abs_front_pressure_validity", value: bit(data[6], 0) }, // A_F_PRESSURE_VALIDITY
      { key: "abs_front_control_active", value: bit(data[6], 1) }, // A_F_CTRL_ACTIVE
      { key: "abs_rear_control_active", value: bit(data[6], 2) } // A_R_CTRL_ACTIVE
    );
  }
  return values;
}

// Energica's own telemetry-scaling table gives `A_F_SPD_SENS` / `A_R_SPD_SENS` the equation
// `f(x)=x*0.05625` and the unit km/h — one of only four non-identity equations in the whole
// dictionary. 0.05625 = 3.6/64, i.e. a count is 1/64 m/s, which is a sane way for an ABS
// ECU to encode a wheel.
//
// ✅ 2026-08-16: CONFIRMED against GPS, and the constant stays exactly as Energica wrote it.
//
// This replaces an earlier note here that called 0.05625 wrong by ~4 % and said the two wheel
// channels disagreed with each other by ~9 %. Both were artefacts — of the reference, and of
// the ride — and the working is kept below so nobody re-derives them from the same data.
//
// **What was wrong: the reference.** That fit used 0x104 `speed_can_kmh`, which is not ground
// truth. `speed_can_kmh` is exactly `motor_rpm_can / 42.0` (through-origin fit 42.0012 rpm per
// km/h over 198 990 forward-gear frames above 20 km/h, residual sd 1.66 rpm, |max| 4 rpm — i.e.
// the two fields are one quantity, and the residual is just their quantisation). It is the
// driveline's number, geared, and it over-reads (see the dash note at the bottom). Calibrating
// wheel counts against it baked that over-read straight into the answer.
//
// **The reference used instead** is `gps_speed_kmh` off this same bus — 0x410, hub message type
// 0x1A, so one capture file carries both signals and the pairing needs no clock alignment
// beyond the candump timestamps. Two independent checks say it can be trusted:
//   • against speed derived from the hub's own lat/lon track, over 241 straight (heading change
//     < 2°), steady spans above 40 km/h: reported − track = −0.27 km/h mean. Worth doing because
//     the field is whole km/h, and whether it ROUNDS or TRUNCATES is worth −0.5 km/h, which at
//     95 km/h is −0.53 % — the same size as the effect being measured. It rounds: chord-summing
//     a noisy track inflates the track by roughly +0.15 km/h at these speeds, putting the true
//     bias near −0.12, against −0.5 for a truncating field. Residual uncertainty is ~0.15 km/h,
//     so read the fits below as carrying an extra +0.0/+0.2 % systematic on top of their CIs.
//     Nothing here turns on it — a truncating field would raise BOTH fits by 0.53 % and leave
//     the front/rear ratio, which is what refutes the circumference model, untouched.
//   • the bike's own odometer advanced 10.4 km over a window in which the GPS track measured
//     10.055 km — +3.43 %, matching the speed over-read below, from a completely separate
//     accumulator.
//
// **Method.** Steady-state only, because GPS speed lags and wheel speed does not, so a transient
// fits a slope that is neither. A sample is kept only if, over a ±3 s window (≥ 8 GPS fixes at
// the hub's ~1.8 Hz): GPS speed spans ≤ 2 km/h, both wheel counts drift < 6 counts/s (≈ 0.34
// km/h/s), heading moves < 4°, and speed ≥ 40 km/h. Fits are through the origin, per wheel,
// against the mean of the ~10 ABS frames within ±0.5 s of each fix.
//
// **Sample budget**, both captures together: 7514 GPS sub-frame cycles reconstructed, 5 dropped
// as incomplete; 591 rejected for `gps_fix` = 0 (the ride starts indoors) and 12 for < 4
// satellites, leaving 6911 valid fixes; 4975 of those had enough ABS frames alongside them; 274
// survived the steady-state filter, falling into 15 contiguous stretches. 10 ABS frames carrying
// the 0xFFFF sentinel on a wheel count were dropped. The two GPS defects known from rides.db —
// the 9-bit 256 rollover and course ≥ 360 — are gated for explicitly and did NOT occur in either
// of these captures: 0 of each.
//
// **Result.** Each stretch is one independent observation (samples inside one are autocorrelated,
// so pooling them raw would overstate n by ~18×):
//
//     front  0.05685 km/h per count   95 % CI [0.05675, 0.05696]   +1.07 % vs 0.05625
//     rear   0.05657 km/h per count   95 % CI [0.05650, 0.05664]   +0.56 % vs 0.05625
//
// Both wheels land within ~1 % of the manufacturer's constant, and the two captures — different
// boots, different roads, one 22 min and one 47 min — agree to the fourth decimal (front 0.05685
// vs 0.05686, rear 0.05653 vs 0.05659). Moving any filter threshold moves the front fit only
// between +0.93 % and +1.32 %: speed floor 25→70 km/h, window ±2→±5 s, heading gate 2°→off,
// drift gate 2→12 counts/s. It is a measurement, not a choice of filter.
//
// ⚠️ So why keep 0.05625 rather than ship the fitted pair? Because 0.05625 = 3.6/64 is a WIRE
// ENCODING — one count is 1/64 m/s — not a calibration, and the ~1 % residual is not in the
// encoding. It is this bike's tyres against the circumferences the ABS ECU has stored: a fitted
// scale > nominal means the tyre is rolling slightly LARGER than the ECU assumes, which is what
// tyre wear, pressure and temperature do, at about this size. Both captures are from the SAME
// DAY, so they establish that the measurement repeats — not that 1.07 % survives a new front
// tyre. Baking a one-day tyre state into a frame decoder makes it silently drift with the
// tyres, and drops the property that makes this frame useful at all: front and rear counts are
// directly comparable to each other, which is exactly what an ABS module needs and exactly what
// per-wheel curve-fits would break. This repo already declined the same trade for 0x125's
// ~109 counts per km/h (src/can/drive.ts) and the reasoning is the same one.
//
// If you want GPS-true speed from these counts, multiply front by 1.0107 and rear by 1.0056 —
// and re-measure after a tyre change, because that is what those numbers are about.
//
// ⚠️ The 9 % channel disagreement was STEERING GEOMETRY, not the channels. The garage-lap figure
// reproduces exactly (median front/rear = 1.0900, n = 363), but it is a property of that lap and
// not of this frame: over the road captures the same ratio is 0.9955 and 0.9967, and — the part
// that settles it — inside the SAME 100-200 count band the garage lap gives 1.092 while the road
// captures give 1.000 and 1.006. Same wheel speed, different ratio, so it cannot be the sensors.
// A garage lap is walking-pace U-turns, and in a turn the front wheel traces the longer arc:
// front path = √(R² + L²) with L = 1465 mm of wheelbase, so 1.090 against the road baseline of
// 0.995 needs R = 3.3 m. That is a bike being turned around in a garage, measured to the metre.
//
// ❌ REFUTED, and worth recording because it is the obvious hypothesis: that the ECU broadcasts
// raw per-wheel pulse rates against one nominal circumference, so the true scale would be
// `0.05625 × C_wheel / C_nom` from the VCU's `SPEED_ODO_FRONTWHEEL_C` = 1852 and
// `SPEED_ODO_REARWHEEL_C` = 1983 (see src/vcu/param-table.ts). It predicts the ratio BACKWARDS.
// A smaller front wheel spins faster, so that model needs front/rear scales in the ratio
// 1852/1983 = 0.9339. Measured is 1.0061 — that one is the ratio of the POOLED through-origin
// fits over all 274 samples (0.05690 / 0.05656), not of the per-stretch means published above,
// which give 1.0049; the two differ because a stretch at 97 km/h and one at 48 km/h carry equal
// weight in the second and not the first. Either reading is above 1 where the model needs 0.934,
// so it is backwards by 7.6-7.7 % whichever is used. Given its best possible C_nom (1904 mm,
// fitted) it is three times worse than doing nothing — RMS error against GPS over the 274 steady
// samples, km/h:
//
//     model                                     front RMS  front bias   rear RMS  rear bias
//     0.05625 single constant (what ships)          0.975      −0.814      0.567     −0.392
//     GPS-fitted per wheel                          0.410      +0.045      0.377     +0.020
//     circumference-derived, best-fit C_nom         2.989      −2.832      2.775     +2.689
//     0x104-fitted (0.05393 / 0.05862, withdrawn)   4.040      −3.860      2.824     +2.738
//
// The physical reason it fails is the same reason the constant is fine: the ABS ECU has ALREADY
// applied each wheel's circumference before it broadcasts. It has to — comparing front against
// rear is what the module is for, and channels 7 % apart at a steady cruise would make every
// motorway kilometre look like a locked wheel. The measured 0.6 % is what "already applied"
// looks like, and it widens with speed (0.998 at ~31 km/h, 0.993 at ~98 km/h), which is tyre
// growth and load transfer rather than anything a constant could fix.
//
// So: these ARE km/h, good to about 1 % against GPS across 40-100 km/h, which is better than the
// previous note claimed and now measured rather than assumed. Still not a certified speedometer,
// and still not a reason to trust them below ~25 km/h, where the garage lap shows what
// manoeuvring does to them.
const WHEEL_SPEED_KMH_PER_COUNT = 0.05625;

// ✅ CONFIRMED as the front brake, by the switch, over the 2026-08-02 lap:
//   • b5 is EXACTLY 0 — mean 0.000, max 0 — in all 3948 frames where 0x102 b2 bit5 (front
//     brake) is clear. Not "near zero": no frame has a single count in it.
//   • With that bit set (n=139) it means 2.60 and peaks at 17, and 33 of those 139 read 0 —
//     the lever closing its switch before line pressure builds, which is what a real brake
//     does and what a coincidence would not.
// Over the whole lap b5 takes 15 distinct values, 0…17, in single-count steps.
//
// ⚠️ Two caveats the capture cannot lift, and they matter for anything that displays this:
//
//  1. **The unit is Energica's word, not a measurement.** Their dictionary calls
//     `A_F_PRESSURE` a pressure in bar with an identity equation, so 1 count = 1 bar, and
//     0…17 bar over a slow garage lap is the right order of magnitude for a front brake.
//     But nothing on this bus carries a second pressure to check it against, so if the true
//     scale is some other constant every number here is wrong by that factor while still
//     looking entirely plausible. The KEY says `_bar` because that is the manufacturer's
//     stated unit; it is not a measured one.
//  2. ~~**"Front" rests on the name too.**~~ **CLOSED 2026-08-19.** ✅ It used to say that
//     0x102's REAR brake bit was never set once in the whole 545 k-frame garage lap, so that
//     lap could not separate "front brake pressure" from "brake pressure", and that a ride
//     using the rear brake alone was the measurement that would close it. Three separate
//     readings now close it, and they were arrived at independently:
//       • The corpus DOES contain rear-only braking: across all 14 650 573 frames of 0x102 in
//         the archive the rear bit fires 18 times on its own, median 0.46 s.
//       • The owner rode the other half deliberately and reported that pressing the rear pedal
//         alone leaves b5 at 0 bar while the front lever drives it to 5.
//       • That report reproduces off the captures, cross-tabulating b5 against 0x102 b2 in the
//         two 2026-08-19 files: rear pedal alone (`buttons-2026-08-19.log`, b2 0x40 set and
//         0x20 clear) gives **b5 = 0 in all 434 frames**, not one count in any of them; front
//         lever alone (`capture-20260819-172725-178e8719.log`, b2 0x20 set) gives 0…8 bar over
//         110 frames, 35 of which read 0 — the lever closing its switch before line pressure
//         builds, the same shape the garage lap showed. (The peak is 8 rather than the
//         reported 5; the owner was watching a screen rather than counting frames, and 0 vs
//         non-zero is the part that carries the argument either way.)
//     So b5 is the FRONT circuit by measurement rather than by its name. The 434-frame zero is
//     the load-bearing half: a combined brake pressure that Energica merely named
//     `A_F_PRESSURE` could not sit at exactly 0 through 434 frames of rear braking.
//
//     🟡 The weaker half of the old sentence survives: that the rear brake has no pressure
//     channel AT ALL. That is a universal negative and it is not measured — the evidence is
//     that this frame has no `A_R_PRESSURE` field and that Energica's own signal database
//     names none, which is an absence in two documents rather than an observation. Treat
//     it as "none is known", not "none exists". What the DTB note at the top of this file
//     adds is a bound on how much better that can ever get FROM HERE: anything the ABS knows
//     and the VCU does not re-broadcast is unreachable from our bus, so "none is known" will
//     not be improved by more searching on VDB, only by the schematic or a DTB tap. Caveat 1
//     stands too: the SCALE is still Energica's word.
//
// A_WARN_LAMP: ✅ set in 3564 of 3601 standstill frames (99.0 %) and in 0 of 192 frames above
// 6 km/h, which is the ABS self-test — it needs road speed to clear, and cannot clear on a
// bike that never moved.
//
// ⚠️ It is a TWO-BIT field, not a flag. Energica's mask is 0x0C >> 2, so the range is 0…3, and
// the mask is kept as the vendor wrote it rather than narrowed to the one bit this bike has
// been seen to use — b4 takes exactly two values in the whole lap, 0x00 and 0x04, so bit 2 is
// the only bit of the PAIR ever observed set. (The wider corpus adds a third b4 value, 0x80,
// but that is `A_EVENT` rather than a lamp state; the two lamp bits are still only ever 0 or 1
// between them. See the flags section below.) Narrowing it to `? 1 : 0` would throw away
// whatever a second lamp state means the first time this bike produces one, on a signal whose
// entire purpose is to be read when something is wrong. Two consequences are handled elsewhere
// and are worth knowing about here: public/lib/bounds.js names it at [0, 3] so the `diag`
// group's boolean rule cannot reject a 2 or a 3 as a dead sensor, and it carries no deadband,
// because at 1 the logging rule would pass |2 − 0| while failing |1 − 0| and log transitions
// inconsistently.
//
// b1 and b3, the wheel-speed high bytes, are NOT dead — the garage lap simply never went fast
// enough to reach 256 counts (14.4 km/h). They are non-zero in 10 241 and 10 242 of
// `capture-20260804-035631`'s frames, peaking at 1748 and 1766 counts, so the LE u16 read above
// is exercised across its real range and not just its low byte. The replay case in
// scripts/check-can-decoders.ts covers a 1697/1719-count frame for exactly that reason.
//
// b7 is 0x00 in all 565 376 frames and Energica's handler names nothing in it. Nothing to decode.
//
// ---------------------------------------------------------------------------------------
// ## The six flags, and exactly how much each one is worth
//
// Added 2026-08-19, completing the ten signals `ParseABS_INFO` names. Three of them have been
// watched firing; three never have. That split is the whole content of this section, and it is
// kept explicit because "reads 0" means something completely different in the two cases.
//
// ⚠️ **Rewritten 2026-08-20 against a corpus 12× larger, and it overturned three claims that
// stood here.** The five captures above were the five that had been LOOKED at, not the five that
// exist. Re-scanning every `*.log` and `*.txt` in `~/Documents/cool-eva-archive/` — 245 files,
// **565 376 frames of 0x0A0** — finds interventions in **15 distinct captures**, not two. What
// changed:
//
//   • `abs_front_control_active` **HAS fired** — 27 frames, three captures. It was recorded here
//     as never observed, and issue #51 item 14 asked for a deliberate front-brake ABS stop to
//     produce one. That stop is not needed; the archive already had it.
//   • **b6 takes four values, not two:** 0x00, 0x02, 0x04, 0x06.
//   • `abs_event` and `abs_rear_control_active` are **not** the same 25 frames. A_EVENT fires with
//     the FRONT channel too. The true invariant is stronger and simpler: A_EVENT is set in exactly
//     the frames where b6 ≠ 0, 162 of 162, both directions.
//
// The whole-archive census of the two flag bytes, which every claim below is a reading of:
//
//     b4    b6    frames   what it is
//     0x00  0x00  421 162  quiet
//     0x04  0x00  144 052  A_WARN_LAMP — the standstill self-test
//     0x80  0x04      135  A_EVENT + rear channel
//     0x80  0x02       14  A_EVENT + FRONT channel
//     0x80  0x06       13  A_EVENT + both channels
//
// (plus one truncated final line in `capture-20260808-223321`, where the capture was cut
// mid-write. b4 is never 0x84 and b6 never carries bit0 — see the two subsections below.)
//
// ### ✅ `abs_event` (b4 0x80), `abs_rear_control_active` (b6 0x04), `abs_front_control_active`
// ### (b6 0x02) — all three observed, and coherent
//
// **162 A_EVENT frames in 61 bursts across 15 captures**, 148 carrying the rear channel, 27 the
// front, 13 both at once. Bursts are 1-17 frames, median 2, i.e. 0.1-1.6 s. Three independently
// named bits in two different bytes that never contradict each other across 15 rides are not a
// coincidence, and that is the strongest evidence these positions are right.
//
//   • **The lamp bits are clear in all 162** (b4 is 0x80, never 0x84), so an intervention is not
//     a fault and does not light the warning lamp. Anything alerting on these must not treat
//     them as a fault condition.
//   • Speeds run **6.1 to 80.7 km/h**, median 36.1 — ordinary riding, not one unusual moment.
//   • **The rear pedal was never used at a single one.** 0 of 162, across all 15 captures. That
//     generalises what two rides had shown and is now about as solid as a negative gets here.
//   • ⚠️ **"No brake was applied in any of them" does NOT survive the wider corpus.** It was true
//     of the 25 frames from 2026-08-04, and reading a cause out of it was the mistake. Across all
//     162, the FRONT brake switch is on in **35**, with real line pressure — 1 to 21 bar — in the
//     same 35. Both front-channel captures are ordinary front-braked stops.
//
// ### 🟡→ What causes them: NOT what this file used to say
//
// This section used to carry a 🟡 reading that the interventions were rear-wheel slip under
// regen, "which is what an e-motorcycle's rear wheel does on a closed throttle". That was an
// inference from the missing brake signal in 25 frames. Against 162 frames with throttle,
// torque and brake aligned to each one, it is **wrong about the majority case**, and the shape of
// the answer is a genuine split rather than a single cause:
//
//   • **The throttle is OPEN at most of them.** `throttle_on` is set in **117 of 162**; above
//     15 km/h the inverter's own torque feedback (0x02C, the cleaner discriminator — it measures
//     what the motor is doing rather than what the rider asked for) is **positive in 90 of 142**,
//     negative in 44, near zero in 8. So a closed throttle is the minority condition, not the
//     rule.
//   • **But that majority is a base-rate artefact, and correcting for it flips the emphasis.**
//     This bike is ridden at positive torque 81 % of the time above 15 km/h. Per unit of riding,
//     interventions are ~3× MORE likely under regen and ~29× more likely with the front brake on.
//     ⚠️ **Every row below is restricted to frames with both wheels above 15 km/h**, which is why
//     the front brake shows 32 here against the 35 quoted above over all 162 — three of the 35 are
//     below that floor. The four band rows sum to 344 222, the whole >15 km/h baseline:
//
//         band                 baseline frames   events   per 10 000 frames
//         drive  (T > +1 Nm)           277 512       90                3.24
//         coast  (|T| ≤ 1 Nm)           25 288        8                3.16
//         regen  (T < −1 Nm)            41 422       44               10.62
//         front brake applied            3 366       32               95.07
//         front brake not applied      340 856      110                3.23
//
//   • ❌ **Traction control is REFUTED as the explanation for the throttle-open population.** Two
//     independent measurements say so, and the second is the decisive one.
//
//     **(a) The bike never cuts torque at them.** If these were interventions on drive slip, the
//     demanded torque would be cut. Measured with one method applied identically to event and
//     non-event frames — mean `drive_torque_cmd_nm` over the 0.5 s before against its extreme
//     over −0.05…+0.35 s — **0 of 90** drive-band interventions above 15 km/h show a cut the
//     throttle does not explain. The full accounting, because the filter discards cases and that
//     matters: of those 90, **83** had enough neighbouring 0x02C frames to test and **7** did not.
//     Of the 83, **24 did** move >5 Nm toward zero — and every one of the 24 had the rider closing
//     the throttle at the same moment, monotonically so, from −32.4 Nm with −15.8 % throttle down
//     to −5.1 Nm with −2.4 %. That is a hand coming off the throttle, not a controller cutting it.
//     The 7 untestable ones were checked by inspection and none shows a cut either: the minimum
//     commanded torque in the window is at or above the frame's own value in 6 of them, and the
//     7th moves 3.4 Nm, below threshold. So the result is 0 of 83 tested and 0 of 7 by hand, not
//     a subset that quietly dropped its inconvenient cases. Two further checks agree:
//     `drive_torque_cmd_nm − drive_torque_feedback_nm` sits at its ordinary +0.10 Nm through them,
//     so the inverter is not clipping the demand, and 0x109's `current_max_out_a` does not dip.
//
//     **(b) The bike has a traction-control event flag, it fires often, and it is not set at
//     these.** 0x109 b6 bit7 is `V_TC_EVENT` in Energica's own `ParseVCU_DRIVEBYWIRE`, and it is
//     confirmed by behaviour rather than by its name — median throttle 77.2 % and torque
//     +137.6 Nm when set against 15.6 % and +11.9 Nm when clear, and within the ≥60 % throttle
//     band alone it still separates +146.2 Nm from +109.9 Nm, so it is not a throttle comparator.
//     (This is the field the repo used to log as `current_other_a`; see src/can/decode.ts.)
//     Cross-tabulated against every A_EVENT frame:
//
//         V_TC_EVENT   set at    4 of 162 interventions   (baseline rate 0.302 %)
//         V_eABS_EVENT set at   10 of 162 interventions   (baseline rate 0.004 %)
//         neither      set at  148 of 162
//
//     and in the drive band specifically, **94 of the 100 throttle-open interventions have
//     neither flag**. Conversely `V_TC_EVENT` fires 1326 times in these captures, of which 4
//     coincide with an ABS intervention. So traction control on this bike is a real, frequent,
//     separately-broadcast event that looks nothing like these — it happens at three-quarters
//     throttle and near peak torque, where the interventions happen at about 15 %. The bike's own
//     answer to "was that traction control?" is no.
//
//     🟡 `V_eABS_EVENT` is the interesting residue: only 26 frames in the whole set, but 10 of
//     them land on an A_EVENT, which against a 0.004 % baseline is an enrichment of ~1600×. So
//     the VCU's eABS event and the ABS module's intervention ARE strongly associated — the sample
//     is just far too small to build on, and it does not cover the throttle-open majority either.
//   • ✅ **The braking/regen population is the one with real lockup signatures.** The three largest
//     wheel divergences in the whole corpus — rear 15.81, 9.62 and 8.49 km/h BELOW the front — are
//     all closed-throttle, front-brake-applied frames, and all are sustained across consecutive
//     frames rather than single samples. The clearest is 2026-08-09 18:55:56 in
//     `capture-20260809-181842`: entered at 77 km/h, throttle shut, regen −41.7 Nm, front brake
//     rising through 12-16 bar and peaking at 21, rear collapses 68.2 → 48.4 km/h and both
//     channels flag. It is the one event in the corpus that looks like the textbook picture.
//   • ❓ **So what the throttle-open events are is UNRESOLVED**, and it is left that way rather
//     than filled in. Refuting traction control does not identify a replacement. Road-surface
//     transients (a bump unloading a wheel), slip too brief for a 10 Hz broadcast to resolve, and
//     wheel-speed sampling artefacts all remain live and this corpus cannot separate them.
//
// ### 🟡 The wheel-speed divergence does NOT corroborate the throttle, and the disagreement is
// ### the honest finding
//
// The obvious cross-check on all of the above — rear faster than front means drive slip, rear
// slower means braking slip — **does not agree with the throttle reading, and is not allowed to
// be quietly dropped for it.** The reason the old note's version of this looked convincing is
// that it had no matched baseline. Against one (non-event frames in the same torque band and the
// same 10 km/h speed bin, 344 222 of them), the rear wheel already reads FASTER than the front
// during ordinary drive, and by more as speed rises: median rear − front is +0.06 km/h in the
// 10s, +0.23 in the 30s, +0.39 in the 50s, +0.73 in the 80s. Against that, the throttle-open
// events sit only just above their own baseline (+0.39 against +0.23 in the 30s, +0.56 against
// +0.28 in the 40s), and 0 of the 12 above 50 km/h fall outside the baseline's 1st-99th
// percentile at all.
//
// Worse for the slip reading: the LARGEST throttle-open divergences point the **wrong way** —
// −4.56, −3.99, −3.38, −2.59, −2.47 km/h, i.e. the rear SLOWER while the motor is driving it —
// and 8 of them are one-sample spikes with both neighbouring frames back inside ±0.6 km/h. A rear
// wheel carrying +19.7 Nm cannot shed 4.56 km/h in 100 ms and take it back in the next 100 ms;
// whatever those are, they are not a wheel accelerating away under power. In the regen band the
// picture is the opposite and consistent: the baseline median is ≈ −0.06, and 80 % of the events
// in the 40s bin fall outside p1-p99.
//
// ⚠️ **Why that is not two standards for one shape**, since a one-sample excursion IS read as a
// real lockup in the braking case (the 16:53:18 replay frame in scripts/check-can-decoders.ts,
// where the front wheel reads 6.13 km/h for exactly one frame and 20.48 the next). The asymmetry
// is physical, not a convenience:
//   • **Under brake, both directions are available.** A caliper can put far more retarding torque
//     into a wheel than the tyre can hold, so a lockup is near-instant; and when the modulator
//     releases, the road — still passing at 20 km/h — spins a wheel of a few tenths of a kg·m²
//     back up in well under 100 ms. A 14 km/h drop and full recovery inside two frames is what
//     that looks like sampled at 10 Hz.
//   • **Under power, one direction is missing.** Shedding 4.56 km/h in 100 ms needs roughly 28 Nm
//     of retarding torque at the wheel, and it has to overcome the +19.7 Nm the motor is pushing
//     the other way — about 48 Nm net, with no brake applied and the tyre gripping. Nothing on
//     the bike supplies that. A wheel LOSING speed under drive torque is the part that does not
//     add up, and it is why those spikes are discounted while the braking one is not.
// The test that separates them is the sign against the applied torque, not the duration. A
// one-frame excursion is credible in the direction the available forces can produce and not in
// the other.
//
// So: throttle/torque and wheel divergence **agree for the braking population and disagree for
// the throttle-open one**, and no winner is picked here. What would settle it is named on issue
// #51 rather than guessed at.
//
// ### ⚠️ `abs_front_sensor_fault` (0x10), `abs_rear_sensor_fault` (0x20) — never observed set,
// ### and that is the expected reading
//
// 0 in all 565 376 frames. On a bike with no wheel-sensor fault, that is what a correct decode
// looks like: there was nothing to report. It is NOT evidence the positions are wrong, and it is
// NOT evidence they are right — it is no evidence either way, which is precisely why they are
// decoded now rather than after the fact. A flag that only matters when it fires is worth having
// decoded BEFORE it fires; the alternative is discovering the first real wheel-sensor failure by
// finding it absent from the log. Same reasoning, and the same corpus-wide zero, as the eleven
// never-seen flags in src/can/vcu-flags.ts.
//
// The positions are Energica's word alone. Treat either reading 1 as a lead to check against the
// mode-03 stored list, the dash's own ABS lamp and `abs_warning_lamp` here — not as a confirmed
// fault. Confirming them needs a real sensor fault, or a sensor unplugged deliberately. Filed on
// issue #51.
//
// 🔎 The two `*SENS_FAIL` bits have exact counterparts in this repo's own DTC table, which is
// what makes them cheap to confirm the day the bike produces one: component 61 is
// `P0500` front wheel speed sensor failure (`dtc_0061_0`), `P2158` rear (`dtc_0061_1`), `C0065`
// both (`dtc_0061_2`) and `P2162` coherency (`dtc_0061_3`), all already logged as 1/0 signals by
// src/diagnostics/record.ts. So `abs_front_sensor_fault` reading 1 in the same window the bike
// stores P0500 confirms b4 0x10 outright, from two independent paths, with no extra
// instrumentation — the ride log already carries both sides of that comparison.
//
// ### ❓ `abs_front_pressure_validity` (b6 bit0) — decoded as a flag, polarity UNESTABLISHED
//
// 0 in all 565 376 frames — including **13 635 frames archive-wide where b5 is reporting a
// non-zero pressure**, which is the load-bearing part and is now two orders of magnitude better
// evidenced than the 181 frames this note used to rest on. So the bit is 0 while the pressure
// demonstrably works, and there are two readings that cannot be told apart from this side:
//
//   • the name is literal, 1 means valid, and this module simply never asserts it; or
//   • the polarity is inverted from the name — 1 would mean INVALID — and 0 is the healthy state
//     we have been watching all along.
//
// The name argues for the first; the fact that the pressure reading plainly works while the bit
// sits at 0 argues for the second. Nothing here settles it, so nothing here pretends to. The key
// is `abs_front_pressure_validity` rather than `..._valid` for that reason: the vendor's noun
// claims a subject, not a truth value.
//
// ⚠️ **`front_brake_pressure_bar` is therefore NOT gated on this bit, and must not be.** Under
// the second reading, gating would blank a working pressure display in every frame — the signal
// would simply never appear, and it would look like a decoder bug rather than a policy. Under
// the first, gating would blank it too, since the bit is never 1. Both readings make gating
// wrong today; only watching the bit move can make it right. Do not add a validity check from
// the vendor DB before then.
//
// ---------------------------------------------------------------------------------------
// The dash over-reads, and by how much — recorded here because it is what the wheel-speed
// calibration above was originally, and wrongly, measured against.
//
// Over the same 274 steady samples, 0x104 `speed_can_kmh` reads +3.6 % and +3.5 % above GPS in
// the two captures (per-stretch mean gps/speed_can 0.9653 ± 0.0013 and 0.9658 ± 0.0018, 2 SE) —
// about +3.4 km/h at an indicated 100. The bike's odometer agrees from a separate accumulator:
// +3.43 % over a 10 km window. So the whole VCU speed/odometer chain runs ~3.5 % fast.
//
// That is real but it is FOUR TIMES SMALLER than the "10-20 km/h over" this bike's owner and the
// Energica community report, which at 100 km/h would be 10-20 %. Two honest caveats before
// anyone changes a sprocket over it: this measures the CAN signal, not the glass — nothing in
// these captures says the dash renders `speed_can_kmh` unmodified, and a display is free to add
// its own margin on top — and 3.5 % is comfortably inside UNECE R39, which forbids under-reading
// and allows roughly +10 % +4 km/h, so a speedometer reading high is the design working.
//
// ❓ Where the 3.5 % lives is NOT settled. `speed_can_kmh` = `motor_rpm_can` / 42.0 exactly, and
// 42.0 rpm/km/h implies a total reduction of 4.997 against `SPEED_ODO_REARWHEEL_C` = 1983 mm (or
// 4.667 against the front's 1852). Neither reconciles with `SPEED_ODO_FINALGEAR` = 4140 and
// `SPEED_ODO_PRIMARYGEAR` = 18268 under any obvious scaling — 18268/4140 = 4.4126, and no
// power-of-ten reading of the pair lands on 4.997 — so the parameters' units are unknown and the
// chain is not decomposed here rather than fudged into agreeing. What can be said without them:
// the error is a single multiplicative 3.5 %, and the only rider-accessible terms in that chain
// are the `SPEED_ODO_*` parameters.
