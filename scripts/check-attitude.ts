import { decodeFrame } from "../src/can/decode.ts";
import { MAX_DECIDEGREES, decodeAttitudeFrame, resetAttitudeDecoder } from "../src/can/attitude.ts";
import { SIGNALS } from "../src/can/registry.ts";
import { boundsFor, isPlausible } from "../public/lib/bounds.js";

// The attitude pair on 0x102 b4-7, which had no assertion anywhere in this suite until
// the bike fell over on 2026-09-13 and gave the decode its first gross-attitude check.
//
//   node --experimental-strip-types scripts/check-attitude.ts
//
// ⚠️ WHAT §1 CAN AND CANNOT PROVE, stated because the honest version is narrower than it
// looks. There is no raw CAN capture for 2026-09-13 on this laptop — the archive's newest
// is 2026-08-19 — so the counts below come from the DECODED ride log, which means the
// VALUES were produced by the very decoder they are replayed through. Against a wrong
// scale they are circular and prove nothing.
//
// What they are NOT circular about is the LAYOUT: which two bytes each angle occupies,
// their endianness, which axis comes first, and the ÷10. Any edit that moves a field,
// flips an endianness or swaps the pair fails §1 even though the fixture came out of the
// decoder, because the stored degrees no longer reproduce from the same bytes. That is
// the regression this section really guards, and it is worth having.
//
// scripts/check-button-decode.ts states the rule this still falls short of ("a
// hand-written frame only proves the decoder agrees with whoever wrote the fixture").
// Satisfying it needs the bike's own bytes. The Pi has kept a per-boot candump under
// /home/pi/ride-captures/ since 2026-09-08, so the fall's boot very likely has them —
// nobody has looked yet, and the PR carries that as a pending step rather than an
// assumption. §2-§4 below are what carry weight meanwhile: none is derived from the log.
//
// Only b4-7 are set. b0-b3 are zero and NOTHING is asserted about them — reconstructing
// them from the decoded bit signals produced a frame that never existed on the wire, and
// that mistake is why this file does not do it.
//
// Evidence: docs/can-decode-findings.md §"Bytes 4-7 — the attitude sensor's two angles".

let failures = 0;

function check(what: string, condition: boolean): void {
  if (condition) {
    console.log(`  ✓ ${what}`);
  } else {
    console.error(`  ✗ ${what}`);
    failures += 1;
  }
}

/** A 0x102 payload carrying only the two angles, as raw 0.1° counts. */
function attitudeFrame(rollDecidegrees: number, pitchDecidegrees: number): Buffer {
  const frame = Buffer.alloc(8);
  frame.writeInt16LE(rollDecidegrees, 4);
  frame.writeInt16LE(pitchDecidegrees, 6);
  return frame;
}

function valueOf(values: { key: string; value: number }[], key: string): number | undefined {
  return values.find(entry => entry.key === key)?.value;
}

// ---------------------------------------------------------------------------------------
// 1. The counts the bike logged on 2026-09-13, replayed through the real decoder.
// ---------------------------------------------------------------------------------------

interface AngleCase {
  /** What the bike was doing, with the timestamp the row carries. All times UTC. */
  what: string;
  rollDecidegrees: number;
  pitchDecidegrees: number;
  roll: number;
  pitch: number;
}

// Each pair is one 0x102 frame: roll and pitch share a timestamp and carry adjacent `seq`,
// which is what makes them the same frame rather than two instants spliced together.
const ANGLES: AngleCase[] = [
  {
    what: "16:15:20.950, parked, side stand DOWN — the sign reference. b4-5 here is 83 FF, byte-identical to the frame the 2026-09-08 KWP read proved against bank 2 id 138, six days apart on the same bike",
    rollDecidegrees: -125,
    pitchDecidegrees: -17,
    roll: -12.5,
    pitch: -1.7,
  },
  {
    what: "16:21:57.051, creeping at 3.2 km/h up a ~34 % gravel climb with the front brake on, 0.9 s before it went over",
    rollDecidegrees: 75,
    pitchDecidegrees: -204,
    roll: 7.5,
    pitch: -20.4,
  },
  {
    what: "16:21:58.130, THE PEAK of the fall — the highest roll ever logged on this bike. Daniel confirms it landed on its RIGHT side, so this frame is a measurement of the sign convention against a known event",
    rollDecidegrees: 1031,
    pitchDecidegrees: -392,
    roll: 103.1,
    pitch: -39.2,
  },
  {
    what: "16:21:58.671, at rest on its right side on the panniers. +71.6° rather than 90° because the luggage held it off the ground — a property of the bike's load, not of the sensor",
    rollDecidegrees: 716,
    pitchDecidegrees: -173,
    roll: 71.6,
    pitch: -17.3,
  },
  {
    what: "15:02:18.753 at 63.9 km/h, the archive's most negative roll — an atan2 wrap after a hard hit, NOT an attitude. Both axes swing and recover inside 60 ms; it is in this file to prove the ±180° band is reachable and must not be gated away",
    rollDecidegrees: -1703,
    pitchDecidegrees: -46,
    roll: -170.3,
    pitch: -4.6,
  },
];

console.log("1. angle counts from the 2026-09-13 ride log, replayed through decodeAttitudeFrame");
resetAttitudeDecoder();
for (const angleCase of ANGLES) {
  const decoded = decodeAttitudeFrame(attitudeFrame(angleCase.rollDecidegrees, angleCase.pitchDecidegrees));
  const roll = valueOf(decoded, "attitude_roll_deg");
  const pitch = valueOf(decoded, "attitude_pitch_deg");
  check(`${angleCase.what} → roll ${angleCase.roll}°`, roll === angleCase.roll);
  check(`  … and pitch ${angleCase.pitch}°`, pitch === angleCase.pitch);
}

// The same counts through the whole-frame path, so a change to decode.ts's 0x102 case that
// stopped calling decodeAttitudeFrame would fail here rather than silently drop both keys.
const throughDecodeFrame = decodeFrame(0x102, attitudeFrame(1031, -392));
check(
  "decodeFrame(0x102, …) still routes b4-7 to the attitude decoder",
  valueOf(throughDecodeFrame, "attitude_roll_deg") === 103.1 &&
    valueOf(throughDecodeFrame, "attitude_pitch_deg") === -39.2
);

// ---------------------------------------------------------------------------------------
// 2. The ±1800 guard: EXERCISED TODAY, ASSERTED NOWHERE. That distinction is the point.
//
// scripts/check-derived-signals.ts sweeps every stream id over every byte value at every
// DLC, which drives 0x102 far past five consecutive out-of-range frames — so both
// attitude warnings already print to stderr on every `npm test` ("0x102 attitude_roll_deg
// read 2559" and the pitch twin). Nothing checks that they did. Nothing checks the sample
// was dropped, that the threshold is five rather than one, that the ration is per process,
// or that a good frame restarts the run. A guard whose output nobody reads is a guard that
// can be deleted by accident, which is what this section stops.
//
// (An earlier draft of this file claimed the path was never exercised at all. It was
// measured against check-can-decoders.ts alone, where it is true — that file's all-zero
// and all-ones payloads both decode IN range, so the counter resets between the two that
// do not and never passes 2. Wrong file, right mechanism, false conclusion.)
// ---------------------------------------------------------------------------------------

console.log("\n2. the out-of-range guard");
resetAttitudeDecoder();

const atLimit = decodeAttitudeFrame(attitudeFrame(MAX_DECIDEGREES, -MAX_DECIDEGREES));
check(
  `±${MAX_DECIDEGREES / 10}° is INSIDE the band and is kept — the wrap transients live here and gating them away would delete the evidence`,
  valueOf(atLimit, "attitude_roll_deg") === 180 && valueOf(atLimit, "attitude_pitch_deg") === -180
);

resetAttitudeDecoder();
const pastLimit = decodeAttitudeFrame(attitudeFrame(MAX_DECIDEGREES + 1, 0));
check(
  `a roll count of ${MAX_DECIDEGREES + 1} is dropped rather than logged as an angle`,
  valueOf(pastLimit, "attitude_roll_deg") === undefined
);
check(
  "…and the pitch in the SAME frame is still emitted, so one bad axis cannot mute the other",
  valueOf(pastLimit, "attitude_pitch_deg") === 0
);

// ⚠️ BOTH SIGNS, deliberately. The guard is `Math.abs(decidegrees) > MAX_DECIDEGREES`, and
// an edit to a bare `decidegrees > MAX_DECIDEGREES` passes every positive case above while
// letting −180.1° through as a plausible angle. Mutation-tested: dropping the Math.abs
// fails this line and nothing else in the file.
resetAttitudeDecoder();
const pastNegativeLimit = decodeAttitudeFrame(attitudeFrame(-(MAX_DECIDEGREES + 1), -(MAX_DECIDEGREES + 1)));
check(
  `a roll count of −${MAX_DECIDEGREES + 1} is dropped too — the band is symmetric and the wrap transients are on the negative side`,
  valueOf(pastNegativeLimit, "attitude_roll_deg") === undefined
);
check(`…and −${MAX_DECIDEGREES + 1} on pitch likewise`, valueOf(pastNegativeLimit, "attitude_pitch_deg") === undefined);

// The warning is rationed to once per axis per process, after five CONSECUTIVE frames.
// Captured rather than trusted: at 100 Hz an unrationed warning fills the journal at 200
// lines a second and pushes out whatever else went wrong at the same moment.
const warnings: string[] = [];
const realWarn = console.warn;
console.warn = (...args: unknown[]): void => {
  warnings.push(args.map(String).join(" "));
};
try {
  resetAttitudeDecoder();
  for (let frame = 0; frame < 4; frame += 1) {
    decodeAttitudeFrame(attitudeFrame(3000, 0));
  }
  const beforeThreshold = warnings.length;
  decodeAttitudeFrame(attitudeFrame(3000, 0));
  const atThreshold = warnings.length;
  for (let frame = 0; frame < 50; frame += 1) {
    decodeAttitudeFrame(attitudeFrame(3000, 0));
  }
  const afterThreshold = warnings.length;

  check(
    "four consecutive out-of-range frames warn about nothing — a single junk sample must not spend the diagnostic",
    beforeThreshold === 0
  );
  check("the fifth consecutive frame warns exactly once", atThreshold === 1);
  check("fifty more frames add no further lines — rationed once per axis per process", afterThreshold === 1);
  check(
    "the line names the axis and the offending count",
    warnings[0]?.includes("attitude_roll_deg") === true && warnings[0]?.includes("3000") === true
  );

  // A run broken by one good frame must start again, or a flapping signal would warn on
  // an accumulation that never actually happened.
  resetAttitudeDecoder();
  warnings.length = 0;
  for (let frame = 0; frame < 4; frame += 1) {
    decodeAttitudeFrame(attitudeFrame(3000, 0));
  }
  decodeAttitudeFrame(attitudeFrame(0, 0));
  for (let frame = 0; frame < 4; frame += 1) {
    decodeAttitudeFrame(attitudeFrame(3000, 0));
  }
  check("a good frame resets the run, so 4 + 1 + 4 stays silent", warnings.length === 0);

  // Per-axis independence: a stuck roll must not consume pitch's one warning.
  resetAttitudeDecoder();
  warnings.length = 0;
  for (let frame = 0; frame < 20; frame += 1) {
    decodeAttitudeFrame(attitudeFrame(3000, 0));
  }
  const afterRoll = warnings.length;
  for (let frame = 0; frame < 20; frame += 1) {
    decodeAttitudeFrame(attitudeFrame(0, 3000));
  }
  check("pitch still gets its own warning after roll has spent hers", afterRoll === 1 && warnings.length === 2);
  check("…and the second line names pitch, not roll", warnings[1]?.includes("attitude_pitch_deg") === true);

  // resetAttitudeDecoder() exists so replaying a second capture in one process can still
  // see its own out-of-range frames. If it stopped clearing `warned`, that would be silent.
  resetAttitudeDecoder();
  warnings.length = 0;
  for (let frame = 0; frame < 5; frame += 1) {
    decodeAttitudeFrame(attitudeFrame(3000, 0));
  }
  check("resetAttitudeDecoder() lets a second replay warn again", warnings.length === 1);
} finally {
  console.warn = realWarn;
}

const shortFrame = decodeAttitudeFrame(Buffer.alloc(7));
check("a 7-byte frame yields no angles rather than reading past the end", shortFrame.length === 0);

// ---------------------------------------------------------------------------------------
// 3. bounds.js and the decoder must agree about what an angle can be.
// ---------------------------------------------------------------------------------------

console.log("\n3. the dashboard's plausibility gate");
const attitudeKeys = ["attitude_roll_deg", "attitude_pitch_deg"];
for (const key of attitudeKeys) {
  const signal = SIGNALS.find(entry => entry.key === key);
  check(`${key} is in the registry`, signal !== undefined);
  if (!signal) {
    continue;
  }
  const range = boundsFor(key, signal.unit, signal.group);
  check(
    `${key} is gated, and to exactly the ±${MAX_DECIDEGREES / 10}° the decoder enforces — asked of bounds.js rather than copied, so the two cannot drift`,
    range !== null && range[0] === -MAX_DECIDEGREES / 10 && range[1] === MAX_DECIDEGREES / 10
  );
}

// ⚠️ That gate is DECORATIVE and this check says so rather than letting a reader assume
// otherwise: the decoder drops an out-of-range count before it is ever logged, so nothing
// the server emits can fail it. It is defence in depth, agreeing with the decoder rather
// than second-guessing it — the same argument the cell-voltage band in bounds.js makes
// about itself. What it really buys is that the two numbers are stated in one place.
for (const angleCase of ANGLES) {
  const signal = SIGNALS.find(entry => entry.key === "attitude_roll_deg");
  check(
    `the gate accepts ${angleCase.roll}° — a real reading it rejected would be drawn as a dead sensor`,
    signal !== undefined && isPlausible("attitude_roll_deg", angleCase.roll, signal.unit, signal.group)
  );
}

// gps_course_deg fell through the same hole and, unlike the attitude pair, its gate FIRES:
// the field is 9 bits, and 3 of 105 118 rows in the 2026-09-13 dump read past 360, the
// highest 442.0. Without a bound a decode failure renders as a heading.
const course = SIGNALS.find(entry => entry.key === "gps_course_deg");
check("gps_course_deg is in the registry", course !== undefined);
if (course) {
  check(
    "gps_course_deg is gated to 0…360",
    JSON.stringify(boundsFor("gps_course_deg", course.unit, course.group)) === "[0,360]"
  );
  check("…so the observed 442.0 is rejected", !isPlausible("gps_course_deg", 442, course.unit, course.group));
  check("…and a real heading of 359.9 is kept", isPlausible("gps_course_deg", 359.9, course.unit, course.group));
}

// ---------------------------------------------------------------------------------------
// 4. V_LIEDOWN_DETECTED — 0x102 b3 bit 5, the VCU's own fall flag.
//
// 🟡 UNVERIFIED against this bike. It is decoded on the vendor frame table alone, because
// the one event that would confirm it — 2026-09-13 16:21:58 — is the one whose raw bytes
// are not on this laptop. The Pi's own candump capture of that boot has them; the PR
// carries the pending step. Until then this section checks the WIRING, not the meaning.
// ---------------------------------------------------------------------------------------

console.log("\n4. the lie-down flag");
const liedownSet = decodeFrame(0x102, Buffer.from([0x00, 0x00, 0x00, 0x20, 0x00, 0x00, 0x00, 0x00]));
const liedownClear = decodeFrame(0x102, Buffer.from([0x00, 0x00, 0x00, 0x44, 0x00, 0x00, 0x00, 0x00]));
check("b3 bit 5 set decodes lie_down_detected = 1", valueOf(liedownSet, "lie_down_detected") === 1);
check(
  "b3 = 0x44, the value 88.4 % of archived frames carry, decodes it = 0",
  valueOf(liedownClear, "lie_down_detected") === 0
);

// ⚠️ The neighbour test only means something if the neighbour MOVES. An earlier draft
// asserted fast_dc_contactor === 0 on two payloads that both have bit 0 clear, which is an
// assertion no mutation of the lie-down mask could ever fail. These two differ in bit 0
// and bit 1 as well as bit 5, so a mask that reached across the byte fails here.
const liedownWithNeighbours = decodeFrame(0x102, Buffer.from([0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x00]));
check(
  "b3 = 0x03 — lie-down clear while BOTH neighbours are set — keeps the three apart",
  valueOf(liedownWithNeighbours, "lie_down_detected") === 0 &&
    valueOf(liedownWithNeighbours, "fast_dc_contactor") === 1 &&
    valueOf(liedownWithNeighbours, "cruise_active") === 1
);
check(
  "…and b3 = 0x20 — lie-down set while both neighbours are clear — is the other diagonal",
  valueOf(liedownSet, "lie_down_detected") === 1 &&
    valueOf(liedownSet, "fast_dc_contactor") === 0 &&
    valueOf(liedownSet, "cruise_active") === 0
);

const liedown = SIGNALS.find(entry => entry.key === "lie_down_detected");
check("lie_down_detected is in the registry", liedown !== undefined);
if (liedown) {
  check(
    "…gated to 0/1, so a decoder that returned the masked byte (32, not 1) could not paint it as fallen",
    JSON.stringify(boundsFor(liedown.key, liedown.unit, liedown.group)) === "[0,1]"
  );
  check(
    "…and carries NO deadband, or |1 − 0| > 1 is false and it would log once after boot and never again",
    (liedown.deadband ?? 0) < 1
  );
}

// A short frame must not invent a fall: b3 is absent below 4 bytes.
const withoutByte3 = decodeFrame(0x102, Buffer.from([0x00, 0x00, 0x00]));
check(
  "a 3-byte 0x102 emits no lie_down_detected at all rather than 0",
  valueOf(withoutByte3, "lie_down_detected") === undefined
);

console.log("");
if (failures > 0) {
  console.error(`✗ ${failures} attitude check(s) failed`);
  process.exit(1);
}
console.log("✓ the attitude pair, its ±180° guard, its dashboard gate and the lie-down flag all hold");
