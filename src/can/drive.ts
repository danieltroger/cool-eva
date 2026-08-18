// Three drive-path frames that each carry the same quantity twice — CAN 0x02C, 0x127 and
// 0x125. They are together because the pairing is the point: in every one of them the second
// channel is what makes the first believable, and the DIFFERENCE between the two is the
// signal worth watching.
//
//   0x02C `DRIVE_TORQUE`  50 Hz  torque commanded vs torque delivered
//   0x127                  4 Hz  the two channels of the throttle position sensor
//   0x125                 55 Hz  two redundant road-speed channels
//
// All three re-derived from this bike's own 2026-08-02 garage lap on 2026-08-16
// (`~/Documents/cool-eva-archive/ride-2026-08-02.log`). Layouts for 0x02C come from
// Energica's `FramesDB` (the 2024 service-tool analysis in obd-garage/); 0x125 and 0x127
// are not in it at all and are settled by the capture alone.

import { type DecodedValue, i16le, u16le } from "./frame.ts";

export const DRIVE_TORQUE_CAN_ID = 0x02c;
export const THROTTLE_SENSOR_CAN_ID = 0x127;
export const REDUNDANT_SPEED_CAN_ID = 0x125;

/** Decodes one 0x02C frame — the inverter's torque command and its feedback, in Nm. */
export function decodeDriveTorqueFrame(data: Buffer): DecodedValue[] {
  if (data.length < 4) return [];
  return [
    { key: "drive_torque_cmd_nm", value: i16le(data[0], data[1]) / 10 },
    { key: "drive_torque_feedback_nm", value: i16le(data[2], data[3]) / 10 },
  ];
}

/** Decodes one 0x127 frame — the throttle position sensor's two channels, in ADC counts. */
export function decodeThrottleSensorFrame(data: Buffer): DecodedValue[] {
  if (data.length < 4) return [];
  return [
    { key: "throttle_sensor_a_raw", value: u16le(data[0], data[1]) },
    { key: "throttle_sensor_b_raw", value: u16le(data[2], data[3]) },
  ];
}

/** Decodes one 0x125 frame — two redundant road-speed channels, in raw counts. */
export function decodeRedundantSpeedFrame(data: Buffer): DecodedValue[] {
  if (data.length < 4) return [];
  return [
    { key: "speed_redundant_a_raw", value: u16le(data[0], data[1]) },
    { key: "speed_redundant_b_raw", value: u16le(data[2], data[3]) },
  ];
}

// ---------------------------------------------------------------------------------------
// 0x02C `DRIVE_TORQUE` — b0-1 LE s16 `D_TRQ_CMD`, b2-3 LE s16 `D_TRQ_FEED`, both × 0.1 Nm.
//
// ✅ The pair identification is what makes this safe: r(command, feedback) = +0.9916 over all
// 20 429 frames of the lap. Two 16-bit fields that track each other that closely, in a frame
// Energica calls DRIVE_TORQUE, are a demand and its response. Supporting evidence from the same
// capture: r(command, 0x109 throttle) = +0.848 and r(feedback, 0x200 pack current) = −0.63, the
// sign being the discharge convention. Negative values are regen — the lap spent 284 frames
// below −2.0 Nm.
//
// ✅ The 0.1 Nm scale has THREE independent sources, which is unusual here and worth stating:
//  1. Energica states it outright. Their own telemetry-scaling table carries
//     `94 D_TRQ_CMD int16_t f(x)=x*0.1 Nm` and `95 D_TRQ_FEED int16_t f(x)=x*0.1 Nm` — an
//     explicit unit column, not an inference. (`FramesDB` itself carries no scalings at all;
//     the two files have to be read together. See the 2024 service-tool analysis in
//     obd-garage/, §6.0.)
//  2. The factory Optionals write `MAP1_TORQUE` = 2000 and 2150 for this platform's published
//     200 Nm and 215 Nm peaks — 0.1 Nm per count from a completely separate document.
//  3. The capture rules out the neighbouring scales on physics alone. Peak feedback was 482
//     counts. At ×1 that is 482 Nm, more than twice the motor's rated peak; and comparing
//     mechanical power (torque × 0x104 motor rpm) against electrical pack power over the lap
//     gives a ratio of 0.60 at >100 rpm and 0.85 at >250 rpm — losses dominating at walking
//     pace, exactly as expected. At ×1 that ratio would be 6.0-8.5, a motor producing eight
//     times more power than it consumes; at ×0.01 it would be 0.06, a 6 % efficient drive.
//     Only ×0.1 lands anywhere physical.
//
// b4-7 is `D_RUN_TMR`, a u32 that reads 0 in all 20 429 frames. Not decoded: there is nothing
// to decode, and recording that it is dead is more useful than a key that only ever writes 0.
//
// ---------------------------------------------------------------------------------------
// 0x127 — the dual throttle position sensor. Not in Energica's FramesDB; settled by the capture.
//
// ✅ b0-1 and b2-3 as LE u16 correlate with 0x109's throttle at r = +0.9982 and +0.9980 over all
// 1523 frames, and with each other at r = +0.99946. Ranges 0-4023 and 0-4050, so 12-bit ADC
// counts. `b0-1 − b2-3` stays inside [−143, 0] for the entire lap: two channels tracking each
// other within a tolerance, never crossing, which is precisely the arrangement `P0120` (throttle
// fault, physical error) and `P0121` (logic error) exist to police. A divergence here is a real
// diagnostic, and it is the reason to log both rather than one.
//
// Deliberately RAW counts, not a percentage. Fitting them against 0x109 gives
// throttle_pct ≈ counts × 0.0201, and 0x109's own throttle scale is itself only 🟡 in this
// repo — converting would stack an unverified scale on an unverified scale and produce a second,
// slightly different `throttle_pct` for the dashboard to disagree with itself about. The counts
// are what the diagnostic needs.
//
// The frame is a steady 4 Hz (median gap 0.2501 s), not event-driven, which is why it is cheap.
// b5 is constant 0x33 and b6-7 constant 0. ❓ b4 ∈ {0,1} is NOT the throttle-on bit it looks
// like: it is 1 while mean throttle is 0.10 % and 0 while mean throttle is 26.2 %, i.e. inverted,
// and it agrees with 0x102's `throttle_on` in only 24 of 1523 frames. Something like "throttle at
// its rest stop", but one capture at one operating point is not a decode, so it stays out.
//
// ---------------------------------------------------------------------------------------
// 0x125 — two redundant road-speed channels. Not in FramesDB either.
//
// ✅ b0-1 and b2-3 as LE u16 correlate with 0x104's confirmed `speed_can_kmh` at r = +0.9966 and
// +0.9976 over 22 480 frames, and are BYTE-IDENTICAL to each other in 19 823 of them. A pair that
// agrees exactly 88 % of the time and lags into agreement the rest is a redundant pair, almost
// certainly the safety micro's own view of road speed — the same micro whose firmware identity
// block sits on 0x147.
//
// ⚠️ NO SCALE, and that is why these are logged as counts with a blank unit rather than km/h.
// Fitting through the origin against `speed_can_kmh` gives ~109 counts per km/h, which is not a
// round constant under any reading — not ×100, not the motor's 42.0 rpm/km/h, not the ABS
// front-wheel scale (105.2 counts per ABS km/h). Per-sample ratios spread 108.8-116.8 across the
// interquartile range. Publishing that as km/h would put a made-up divisor on the dashboard next
// to a speed that IS calibrated. (That ride has since happened — see the correction below.)
//
// ⚠️ 2026-08-16: that ~109 came from the garage lap fitted against `speed_can_kmh`, and BOTH
// halves of that are now known to be bad — 0x104 reads 3.5 % fast against GPS, and the garage lap
// never passed 11.5 km/h, which is enough to distort a fit on its own (see src/can/abs.ts, where
// the same two mistakes cost the ABS scale 4 % and invented a 9 % channel disagreement).
// Re-fitted against `gps_speed_kmh` over 199 steady-state samples at 40-100 km/h from the two
// 2026-08-04 road captures: **105.1 and 103.7 counts per true km/h**, IQR 104.7-105.5 and
// 103.3-104.0. Note that is NOT 109 × 1.035 = 113 — the garage-lap number was not merely biased
// by the reference, it was wrong in the other direction too, so it cannot be rescued by scaling.
//
// The conclusion survives unchanged: 105.1 is no rounder than 109 was, so these still log as raw
// counts. Two claims above do NOT survive and are corrected here rather than left standing:
//   • "BYTE-IDENTICAL in 19 823 of 22 480" is garage-lap-only. At road speed (both channels above
//     4000 counts, n = 36 195) they are identical in 15 frames — 0.04 % — and otherwise sit a
//     steady +112 counts apart, b0-1 above b2-3 by 1.5 %. A fixed offset at steady state, not a
//     lag: the gap is the same in the steady-state windows as in the raw frames.
//   • the 108.8-116.8 interquartile spread is also garage-lap-only; against GPS the spread is
//     under 1 %, so these channels are far better behaved than that range suggested.
// Still not converted to km/h, and now for a better reason than "no scale is known": there are
// two channels 1.5 % apart, and picking one to publish would be picking which to believe.
//
// ❓ b4-7 is left alone: two more 16-bit channels, both always EVEN (all 22 480 frames), ranging
// to 65530, correlating with speed at only r = +0.67 and stepping by neither 1 nor 2 between
// consecutive frames — so not the counter that shape suggests. Unidentified.
