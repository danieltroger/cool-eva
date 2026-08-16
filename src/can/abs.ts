// The ABS module's broadcast, CAN 0x0A0 `ABS_INFO` at 10 Hz. Wheel speeds, the ABS
// warning lamp, and front brake pressure — which is a quantity nothing else on this bus
// carries, and the reason this frame was worth chasing.
//
// Layout is Energica's own, out of the `FramesDB.ParseABS_INFO` handler in the service
// tool (obd-garage/EMSUITE_2024.md §`0x0A0` `ABS_INFO`):
//
//   b0-1 LE  A_F_SPD_SENS   front wheel speed
//   b2-3 LE  A_R_SPD_SENS   rear wheel speed
//   b4       A_WARN_LAMP    mask 0x0C >>2 · A_FSENS_FAIL 0x10 · A_RSENS_FAIL 0x20 · A_EVENT 0x80
//   b5       A_F_PRESSURE   front brake pressure
//   b6       A_F_PRESSURE_VALIDITY bit0 · A_F_CTRL_ACTIVE bit1 · A_R_CTRL_ACTIVE bit2
//
// That layout is CONFIRMED against this bike's own 2026-08-02 garage lap (4087 frames of
// 0x0A0 in `~/Documents/cool-eva-archive/ride-2026-08-02.log`), re-derived here on
// 2026-08-16 rather than taken on trust. What the capture proves, and what it does not,
// are deliberately kept apart below — because the scalings are the part it cannot check.

import { type DecodedValue, u16le } from "./frame.ts";

export const ABS_CAN_ID = 0x0a0;

/**
 * Decodes one 0x0A0 frame. Pure: bytes in, values out.
 *
 * Emits nothing for a short frame rather than a partial read — unlike 0x102, no field
 * here has been logged long enough to be worth protecting with its own narrower guard.
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

// Energica's `em_telemetry_scaling.csv` gives `A_F_SPD_SENS` / `A_R_SPD_SENS` the equation
// `f(x)=x*0.05625` and the unit km/h — one of only four non-identity equations in the whole
// dictionary. 0.05625 = 3.6/64, i.e. a count is 1/64 m/s, which is a sane way for an ABS
// ECU to encode a wheel.
//
// ⚠️ 2026-08-16: the constant is the manufacturer's, and this bike's own capture does NOT
// reproduce it. Fitting through the origin against the confirmed 0x104 `speed_can_kmh` over
// all 4087 paired frames gives 0.05393 km/h per count on the front and 0.05862 on the rear —
// so at 0.05625 the front reads ~4.3 % HIGH and the rear ~4.0 % LOW against the dash. Worse,
// the two channels disagree with each OTHER by ~9 % (median front/rear raw ratio 1.090, n=363),
// which no single constant can fix: at most one of them can be calibrated km/h. A front tyre
// that is ~5 % smaller in rolling circumference than the rear explains most of that, which is
// what you would expect of an ECU broadcasting per-wheel counts against one nominal constant.
//
// Note also that 0x104's speed is NOT independent ground truth: r(speed, motor rpm) = 0.999975
// over the same lap, so it is the driveline's number, geared. There is no calibrated speed on
// this bus to check either wheel against.
//
// So: treat these as km/h to within a few percent — good enough for a ride overlay, for
// spotting a locked or spinning wheel, and for front-vs-rear comparison — and NOT as a
// calibrated speedometer. A GPS run at a steady speed is what would settle the constant, and
// `gps_speed_kmh` is already logged, so a single motorway stretch would do it.
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
//  2. **"Front" rests on the name too.** 0x102's REAR brake bit was never set once in the
//     whole 545 k-frame capture, so this lap cannot separate "front brake pressure" from
//     "brake pressure". Energica calls it `A_F_PRESSURE` and there is no `A_R_PRESSURE` in
//     the frame at all, which is the argument — a ride that uses the rear brake alone is the
//     measurement that would close it.
//
// A_WARN_LAMP: ✅ set in 3564 of 3601 standstill frames (99.0 %) and in 0 of 192 frames above
// 6 km/h, which is the ABS self-test — it needs road speed to clear, and cannot clear on a
// bike that never moved. b4 takes exactly two values in the whole lap, 0x00 and 0x04, so bit 2
// is the only bit of the 0x0C mask ever seen set; the mask is Energica's and is kept as-is.
//
// ⚠️ NOT decoded, and this is the honest reason: b1, b3, b6 and b7 are constant 0x00 across
// all 4087 frames. That takes `A_FSENS_FAIL`, `A_RSENS_FAIL` and `A_EVENT` (all in b4) and
// the whole of b6 with it. Two consequences worth writing down rather than rediscovering:
//   • `A_F_PRESSURE_VALIDITY` (b6 bit0) reads 0 in EVERY frame, including the 106 where a
//     pressure is being reported. So it cannot be used to gate the pressure — either its
//     polarity is the opposite of its name, or the module never asserts it. Do not add a
//     validity check from the vendor DB without watching that bit move first.
//   • `A_F_CTRL_ACTIVE` / `A_R_CTRL_ACTIVE` would be the genuinely interesting pair for a
//     ride overlay — ABS actually modulating — but no intervention happened on this lap, so
//     "the bits are 0 because nothing happened" and "the bits are somewhere else" are
//     indistinguishable here. Left undecoded until a capture contains a real ABS event.
