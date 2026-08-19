// The ABS module's broadcast, CAN 0x0A0 `ABS_INFO` at 10 Hz. Wheel speeds, the ABS
// warning lamp, and front brake pressure — which is a quantity nothing else on this bus
// carries, and the reason this frame was worth chasing.
//
// Layout is Energica's own, out of the `FramesDB.ParseABS_INFO` handler in the service
// tool (the 2024 service-tool analysis in obd-garage/, §`0x0A0` `ABS_INFO`):
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
// What the captures prove, and what they do not, are deliberately kept apart below.
//
// ⚠️ The garage lap alone was actively MISLEADING about this frame, which is the main lesson
// here and the reason the road captures are named above. It never exceeded 11.5 km/h and never
// left walking-pace manoeuvring, and every quantitative claim derived from it about the wheel
// speeds — the scale, and the "9 % channel disagreement" — turned out to be an artefact of
// that. A frame is not characterised until it has been seen at the speeds it exists for.

import { type DecodedValue, u16le } from "./frame.ts";

export const ABS_CAN_ID = 0x0a0;

/**
 * Decodes one 0x0A0 frame. Pure: bytes in, values out.
 *
 * Emits nothing for a short frame rather than a partial read — unlike 0x102, no field
 * here has been logged long enough to be worth protecting with its own narrower guard.
 *
 * ⚠️ A wheel count of 0xFFFF is a sentinel and it DOES occur on the road — 10 frames across the
 * two 2026-08-04 captures. It is passed through, arriving as 3686.34 km/h, and that is deliberate
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
  return [
    { key: "wheel_speed_front_kmh", value: u16le(data[0], data[1]) * WHEEL_SPEED_KMH_PER_COUNT },
    { key: "wheel_speed_rear_kmh", value: u16le(data[2], data[3]) * WHEEL_SPEED_KMH_PER_COUNT },
    { key: "abs_warning_lamp", value: (data[4] & 0x0c) >> 2 },
    { key: "front_brake_pressure_bar", value: data[5] },
  ];
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
//  2. ~~**"Front" rests on the name too.**~~ **CLOSED 2026-08-19.** It used to say that
//     0x102's REAR brake bit was never set once in the whole 545 k-frame capture, so that
//     lap could not separate "front brake pressure" from "brake pressure", and that a ride
//     using the rear brake alone was the measurement that would close it. Both halves of
//     that measurement now exist. Across all 14 650 573 frames of 0x102 in the archive the
//     rear bit fires 18 times on its own (median 0.46 s), so the corpus does contain
//     rear-only braking; and the owner rode the other half deliberately, reporting that
//     **pressing the rear pedal alone leaves b5 at 0 bar while the front lever drives it to
//     5**. So b5 is the FRONT circuit by measurement rather than by its name. ✅
//
//     🟡 The weaker half of the old sentence survives: that the rear brake has no pressure
//     channel AT ALL. That is a universal negative and it is not measured — the evidence is
//     that this frame has no `A_R_PRESSURE` field and that Energica's own signal database
//     names none, which is an absence in two documents rather than an observation. Treat
//     it as "none is known", not "none exists". Caveat 1 stands too: the SCALE is still
//     Energica's word.
//
// A_WARN_LAMP: ✅ set in 3564 of 3601 standstill frames (99.0 %) and in 0 of 192 frames above
// 6 km/h, which is the ABS self-test — it needs road speed to clear, and cannot clear on a
// bike that never moved.
//
// ⚠️ It is a TWO-BIT field, not a flag. Energica's mask is 0x0C >> 2, so the range is 0…3, and
// the mask is kept as the vendor wrote it rather than narrowed to the one bit this bike has
// been seen to use — b4 takes exactly two values in the whole lap, 0x00 and 0x04, so bit 2 is
// the only bit of the pair ever observed set. Narrowing it to `? 1 : 0` would throw away
// whatever a second lamp state means the first time this bike produces one, on a signal whose
// entire purpose is to be read when something is wrong. Two consequences are handled elsewhere
// and are worth knowing about here: public/lib/bounds.js names it at [0, 3] so the `diag`
// group's boolean rule cannot reject a 2 or a 3 as a dead sensor, and it carries no deadband,
// because at 1 the logging rule would pass |2 − 0| while failing |1 − 0| and log transitions
// inconsistently.
//
// ⚠️ NOT decoded, and this is the honest reason: b1, b3, b6 and b7 are constant 0x00 across
// all 4087 frames of the GARAGE LAP. That takes `A_FSENS_FAIL`, `A_RSENS_FAIL` and `A_EVENT`
// (all in b4) and the whole of b6 with it. The road captures move two of them, so the note is
// now three items rather than two:
//   • b1 and b3, the wheel-speed high bytes, are NOT dead — the garage lap simply never went
//     fast enough to reach 256 counts (14.4 km/h). They are non-zero in 10 241 and 10 242 of
//     `capture-20260804-035631`'s frames, peaking at 1748 and 1766 counts, so the LE u16 read
//     above is exercised across its real range and not just its low byte. The replay case in
//     scripts/check-can-decoders.ts covers a 1697/1719-count frame for exactly that reason.
//   • `A_F_PRESSURE_VALIDITY` (b6 bit0) reads 0 in EVERY frame — in the garage lap including
//     the 106 where a pressure is being reported, and in 33 623 road frames too. So it cannot
//     be used to gate the pressure — either its polarity is the opposite of its name, or the
//     module never asserts it. Do not add a validity check from the vendor DB without watching
//     that bit move first.
//   • ✅ `A_EVENT` and `A_R_CTRL_ACTIVE` DO fire, and Energica's bit assignment for them is
//     corroborated by the way they fire: b4 0x80 is set in 14 frames of `capture-20260804-035631`
//     and 11 of `capture-20260804-193952`, and b6 0x04 in 14 and 11 of the same two — the same
//     frames, exactly, in both captures. An event flag and a rear-channel-active flag that
//     co-occur to the frame across two rides are what a real ABS intervention looks like, ~1.4 s
//     and ~1.1 s of it. `A_F_CTRL_ACTIVE` (b6 bit1) stayed 0 throughout, so the front is still
//     "0 because nothing happened" vs "somewhere else" — undecided.
//     Left undecoded here only to keep this change to one subject: it needs registry entries,
//     bounds entries and a deadband argument of its own. The evidence is named above so that
//     is a short job, not another investigation.
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
