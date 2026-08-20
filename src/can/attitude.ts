// The attitude sensor's two angles, on CAN 0x102 b4-7. Not accelerations.
//
// Until 2026-08-15 these two int16s were logged as `accel_lateral_raw` and
// `accel_frontal_raw` — raw counts, blank unit — on the .xdbc's word that 0x102 carries
// accelerations "in g". That reading is wrong. They are the VCU attitude block's two
// DERIVED angles, in units of 0.1°:
//
//   b4-5 LE int16 = roll,  Energica's `AttitudeSensor_Phi`.   Positive = leaning RIGHT.
//   b6-7 LE int16 = pitch, Energica's `AttitudeSensor_Thete`. Positive = nose-down,
//                                                             i.e. decelerating.
//
// ✅ Four independent things establish that, all from stored data: the side-stand bytes are
// bit-identical to the KWP dump's `AttitudeSensor_Phi` and agree with that block's own gravity
// vector at −10.33°; the values lie on an arctangent lattice (spacing SHRINKS with magnitude,
// which no constant scale can do) fitting 576.9 units/radian against 572.958 for 0.1°/radian;
// roll tracks the side stand and nothing else; and pitch tracks braking and throttle, which is
// what gives the sign convention. ±1800 is the whole range an atan2 can reach, and that bound
// is what this module checks on every frame.
//
// ⚠️ THIS IS APPARENT ATTITUDE, NOT LEAN ANGLE. Three accelerometers and what is derived from
// them — no gyro. Both angles are the direction of the measured vertical, so they answer "which
// way is down as far as the bike can tell", not "how far over is the bike": cornering hides
// itself almost completely (roll stayed inside ±17.9° on rides that reached 186 km/h), while
// braking shows up as pitch. Anything wanting real lean needs a gyro the bike does not publish.
//
// 🟡 Inferred, not proven: that the broadcast pair IS the bank-2 block rather than an
// independent copy of the same sensor, and the pitch sign convention, which is measured off
// this bike's own brake and throttle bits rather than read out of a document.
//
// Evidence in full: docs/can-decode-findings.md § "Bytes 4-7 — the attitude sensor's two angles".

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

/**
 * How many CONSECUTIVE out-of-range frames it takes to warn, per axis.
 *
 * A bare inequality would spend the warning on noise. This bike emits occasional junk
 * samples on plenty of signals — `high_beam` reading 193, 0xFFFF cell voltages, −32767
 * GPS altitude, the whole reason public/lib/bounds.js exists — and one of those landing
 * in b4-7 must not silence the diagnostic for the rest of the boot, because the thing it
 * is there to catch (a frame layout change) arrives later and lasts forever. 0x102 is
 * 100 Hz, so five frames is 50 ms: nothing a real layout change would survive, and far
 * more than a single corrupted sample can fake. pack-temperature.ts guards its warnings
 * the same way at 3, against frames that arrive at 1-20 Hz rather than 100.
 */
const OUT_OF_RANGE_FRAMES_BEFORE_WARNING = 5;

/** Per-axis, so a stuck roll can never mask a later, independent problem on pitch. */
interface AxisRangeWatch {
  consecutiveOutOfRange: number;
  warned: boolean;
}

const rollRangeWatch: AxisRangeWatch = { consecutiveOutOfRange: 0, warned: false };
const pitchRangeWatch: AxisRangeWatch = { consecutiveOutOfRange: 0, warned: false };

/**
 * The two angles from one 0x102 frame, in degrees. A frame too short to hold them, or a
 * count outside the ±180.0° an atan2 can produce, yields nothing under that key rather
 * than a number that would plot as a plausible angle.
 */
export function decodeAttitudeFrame(data: Buffer): DecodedValue[] {
  if (data.length < MIN_FRAME_LENGTH) return [];
  const values: DecodedValue[] = [];
  addAngle(values, "attitude_roll_deg", i16le(data[4], data[5]), rollRangeWatch, data);
  addAngle(values, "attitude_pitch_deg", i16le(data[6], data[7]), pitchRangeWatch, data);
  return values;
}

/**
 * Clears both axes' warning state. Nothing in the running service calls this — one bike,
 * one bus, and a layout change is a once-ever event worth one line in the journal. It
 * exists so replaying two captures through decodeFrame() in one process can still see
 * the second one's out-of-range frames, the same reason resetGpsCanDecoder() exists.
 */
export function resetAttitudeDecoder(): void {
  for (const watch of [rollRangeWatch, pitchRangeWatch]) {
    watch.consecutiveOutOfRange = 0;
    watch.warned = false;
  }
}

function addAngle(values: DecodedValue[], key: string, decidegrees: number, watch: AxisRangeWatch, data: Buffer): void {
  if (Math.abs(decidegrees) > MAX_DECIDEGREES) {
    noteAttitudeOutOfRange(key, decidegrees, watch, data);
    return;
  }
  watch.consecutiveOutOfRange = 0;
  values.push({ key, value: decidegrees / DECIDEGREES_PER_DEGREE });
}

// The sample is dropped on every out-of-range frame; only the journal line is rationed.
// Once per axis per process, not once per frame: 0x102 arrives at 100 Hz, so a layout
// change would otherwise fill the journal at 200 lines a second and push out whatever
// else went wrong at the same moment.
function noteAttitudeOutOfRange(key: string, decidegrees: number, watch: AxisRangeWatch, data: Buffer): void {
  watch.consecutiveOutOfRange++;
  if (watch.consecutiveOutOfRange < OUT_OF_RANGE_FRAMES_BEFORE_WARNING || watch.warned) return;
  watch.warned = true;
  console.warn(
    `attitude: *** 0x102 ${key} read ${decidegrees} (${(decidegrees / DECIDEGREES_PER_DEGREE).toFixed(1)}°) on ` +
      `${watch.consecutiveOutOfRange} consecutive frames, outside the ` +
      `±${MAX_DECIDEGREES / DECIDEGREES_PER_DEGREE}° an atan2 can produce. *** b4-7 are no longer ` +
      "the attitude angles this decoder assumes — most likely Energica changed 0x102's layout, or the frame " +
      `is not from the VCU at all. Dropping the sample. Frame: ${data.toString("hex")}. See src/can/attitude.ts.`
  );
}
