// The attitude sensor's two angles, on CAN 0x102 b4-7. Not accelerations.
//
// Until 2026-08-15 these two int16s were logged as `accel_lateral_raw` and
// `accel_frontal_raw` — raw counts, blank unit — on the .xdbc's word that 0x102
// carries accelerations "in g" with no multiplier given. That reading is wrong. The
// fields are the VCU attitude block's two DERIVED angles, in units of 0.1°:
//
//   b4-5 LE int16 = roll,  Energica's `AttitudeSensor_Phi`.   Positive = leaning RIGHT.
//   b6-7 LE int16 = pitch, Energica's `AttitudeSensor_Thete`. Positive = nose-down,
//                                                             i.e. decelerating.
//
// ✅ Four independent things establish that, all from stored data — the bike itself was
// not touched, it is out of reach for about a week from 2026-08-15.
//
//  1. The bytes match Energica's own block. The parked side-stand capture of
//     2026-08-02, `80 10 02 44 99 FF D8 FF`, has b4-5 = 0xFF99 = −103. The KWP dump of
//     2026-06-14 (`obd-garage/kwp_scan_raw.txt`) reads A9 bank 2 id 0x8A —
//     `AttitudeSensor_Phi` — as the *same bytes*, `ff99` = −103. That same block's
//     gravity vector (Gx 53, Gy −179, Gz 982 mg, |G| = 999.6 mg) independently gives
//     atan2(Gy, Gz) = −10.33°. So −103 is −10.3° of roll: the bike leaning left on its
//     side stand, which is where it was. See obd-garage/EMSUITE_FILES.md §2.2.
//  2. The values lie on an arctangent lattice. Across the 15 455 rows logged under the
//     old keys the pair only ever takes values whose spacing SHRINKS with magnitude —
//     ~5.7 apart near zero, ~3.4 apart near 400. A count scaled by a constant cannot do
//     that; round(A·atan(k·q)) does exactly that. Fitting A and q freely over the 80
//     distinct positive values gives A = 576.9 units per radian, against 572.958 for
//     0.1°/radian — 0.7 % off, and a factor of ten away from either 1° or 0.01°.
//  3. Roll tracks the side stand and nothing else. Median −10.8° with the stand down
//     (`stand_up` = 0), −0.6° with it up and the bike moving, and — outside the one
//     230 ms transient described below — it never left ±17.9° across the other 488 of
//     its 494 moving samples, on rides that reached 186 km/h. A *true* lean angle would
//     pass 30° on any roundabout. A gravity-referenced one reads ≈0 in a steady corner,
//     because the bike leans into the resultant — which is what this does.
//  4. Pitch tracks longitudinal acceleration, and gives the sign convention: median
//     +13.1° while the brake bit is set against −5.2° while it is not, +9.2° at closed
//     throttle (regen) and −12.5° above 25 % throttle. Same apparent-vertical effect on
//     the other axis.
//
// The range confirms the unit from the other end. On 2026-08-08 12:30:19 one 40 ms
// burst read −184, −1703, −1506, −425, −215, −108, −6 at 100 Hz. −170.3° is atan2
// wrapping toward ±180° on a hard hit, which is only possible if the field is an angle
// scaled at 0.1°; ±1800 is then the entire range, and nothing in six days of log lies
// outside it. That bound is what this module checks on every frame.
//
// ⚠️ THIS IS APPARENT ATTITUDE, NOT LEAN ANGLE. The block is Gx/Gy/Gz/Phi/Thete/Mag and
// nothing else — three accelerometers and what is derived from them, no gyro. Both
// angles are the direction of the measured vertical, so they answer "which way is down
// as far as the bike can tell", not "how far over is the bike". Cornering hides itself
// almost completely (point 3); braking shows up as pitch (point 4). Anything wanting
// real lean needs a rate gyro the bike does not publish here.
//
// 🟡 Inferred, not proven: that the broadcast pair IS the bank-2 block rather than an
// independent copy of the same sensor. Bit-identical Phi bytes on the side stand is
// strong, but the two were read on different days over different transports. Reading A9
// bank 2 ids 0x87-0x8C live while tilting the bike settles it, and is the outstanding
// experiment (EMSUITE_FILES.md §2.5). Also inferred: the pitch sign convention above is
// measured off this bike's brake and throttle bits, not read out of any document.

import { type DecodedValue, i16le } from "./frame.ts";

/** The frame reports 0.1° per count; every consumer wants degrees. */
const DECIDEGREES_PER_DEGREE = 10;

/**
 * Both angles come out of an atan2, so ±180.0° is the whole reachable range and ±1800
 * is the whole reachable raw value. A count outside it is not a steep bike, it is a
 * frame that no longer means what this file says it means.
 */
const MAX_DECIDEGREES = 1800;

/** b4-7 carry the angles; a shorter frame carries none of them. */
const MIN_FRAME_LENGTH = 8;

let warnedAttitudeOutOfRange = false;

/**
 * The two angles from one 0x102 frame, in degrees. A frame too short to hold them, or a
 * count outside the ±180.0° an atan2 can produce, yields nothing under that key rather
 * than a number that would plot as a plausible angle.
 */
export function decodeAttitudeFrame(data: Buffer): DecodedValue[] {
  if (data.length < MIN_FRAME_LENGTH) return [];
  const values: DecodedValue[] = [];
  addAngle(values, "attitude_roll_deg", i16le(data[4], data[5]), data);
  addAngle(values, "attitude_pitch_deg", i16le(data[6], data[7]), data);
  return values;
}

/**
 * Clears the one-shot warning. Nothing in the running service calls this — one bike, one
 * bus, and a layout change is a once-ever event worth one line in the journal. It exists
 * so replaying two captures through decodeFrame() in one process can still see the
 * second one's out-of-range frames, the same reason resetGpsCanDecoder() exists.
 */
export function resetAttitudeDecoder(): void {
  warnedAttitudeOutOfRange = false;
}

function addAngle(values: DecodedValue[], key: string, decidegrees: number, data: Buffer): void {
  if (Math.abs(decidegrees) > MAX_DECIDEGREES) {
    warnAttitudeOutOfRange(key, decidegrees, data);
    return;
  }
  values.push({ key, value: decidegrees / DECIDEGREES_PER_DEGREE });
}

// Once per process, not once per frame: 0x102 arrives at 100 Hz, so a frame layout
// change would otherwise fill the journal at 200 lines a second and push out whatever
// else went wrong at the same moment.
function warnAttitudeOutOfRange(key: string, decidegrees: number, data: Buffer): void {
  if (warnedAttitudeOutOfRange) return;
  warnedAttitudeOutOfRange = true;
  console.warn(
    `attitude: *** 0x102 ${key} read ${decidegrees} (${(decidegrees / DECIDEGREES_PER_DEGREE).toFixed(1)}°), ` +
      `outside the ±${MAX_DECIDEGREES / DECIDEGREES_PER_DEGREE}° an atan2 can produce. *** b4-7 are no longer ` +
      "the attitude angles this decoder assumes — most likely Energica changed 0x102's layout, or the frame " +
      `is not from the VCU at all. Dropping the sample. Frame: ${data.toString("hex")}. See src/can/attitude.ts.`
  );
}
