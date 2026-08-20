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
// 20 429 frames of the lap. Negative values are regen. ✅ The 0.1 Nm scale has THREE
// independent sources — Energica's telemetry-scaling table states it outright, the factory
// Optionals imply it from `MAP1_TORQUE`, and the neighbouring scales are ruled out on physics
// (×1 would make the motor produce eight times the power it consumes).
//
// b4-7 is `D_RUN_TMR`, a u32 that reads 0 in all 20 429 frames. Not decoded: recording that it
// is dead is more useful than a key that only ever writes 0.

// ---------------------------------------------------------------------------------------
// 0x127 — the dual throttle position sensor. Not in Energica's FramesDB; settled by capture.
//
// ✅ Both channels correlate with 0x109's throttle at r = +0.998 and with each other at
// +0.99946; `b0-1 − b2-3` stays inside [−143, 0] for the entire lap. Two channels tracking
// within a tolerance and never crossing is precisely the arrangement `P0120`/`P0121` exist to
// police, which is why BOTH are logged.
//
// Deliberately RAW counts, not a percentage: converting would need 0x109's own 🟡 throttle
// scale, stacking an unverified scale on an unverified one to produce a second, slightly
// different `throttle_pct` for the dashboard to disagree with itself about.
//
// ❓ b4 ∈ {0,1} is NOT the throttle-on bit it looks like — it is inverted and agrees with
// 0x102's `throttle_on` in only 24 of 1523 frames. One operating point is not a decode.

// ---------------------------------------------------------------------------------------
// 0x125 — two redundant road-speed channels. Not in FramesDB either.
//
// ✅ Both correlate with 0x104's `speed_can_kmh` at r = +0.997 over 22 480 frames — almost
// certainly the safety micro's own view of road speed.
//
// ⚠️ NO SCALE, which is why these log as counts with a blank unit. Fitted against GPS they
// are 105.1 and 103.7 counts per true km/h — no rounder than the ~109 the garage lap gave,
// which was wrong in BOTH directions and so could not be rescued by scaling. The better
// reason not to convert: the channels sit 1.5 % apart at road speed, so picking one to
// publish would be picking which to believe.
//
// ❓ b4-7 is left alone: two more 16-bit channels, always EVEN, correlating with speed at
// only r = +0.67 and stepping by neither 1 nor 2 — not the counter that shape suggests.
// Fits and corrected claims: docs/can-decode-findings.md § "0x125 / 0x127".
