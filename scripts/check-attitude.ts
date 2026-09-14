import { decodeFrame } from "../src/can/decode.ts";
import { parseHexBytes } from "./captured-vcu-records.ts";
import { MAX_DECIDEGREES, decodeAttitudeFrame, resetAttitudeDecoder } from "../src/can/attitude.ts";
import { SIGNALS } from "../src/can/registry.ts";
import { boundsFor, isPlausible } from "../public/lib/bounds.js";

// The attitude pair on 0x102 b4-7, which had no assertion anywhere in this suite until
// the bike fell over on 2026-09-13 and gave the decode its first gross-attitude check.
//
//   node --experimental-strip-types scripts/check-attitude.ts
//
// ✅ §1 REPLAYS REAL FRAMES. The Pi's own candump of the fall was recovered on 2026-09-14
// (`capture-20260913-180503-2b9d0f5b.log`, session 143's boot; the 60 s around the fall are
// kept in `evidence/`, gitignored, 80 357 frames of which 5 998 are 0x102). Four of the six
// cases below are those frames byte for byte, which is what scripts/check-button-decode.ts
// requires ("None is hand-written, because a hand-written frame only proves the decoder
// agrees with whoever wrote the fixture").
//
// ⚠️ The remaining TWO — the side-stand reference and the wrap minimum — fall outside that
// window, so only the decoded counts survive for them. Those two are circular against a
// wrong scale: the values came out of the decoder they are replayed through. They are kept
// because each pins something the captured four cannot, and they are labelled
// "counts only" in the output so nobody mistakes one for the other.
//
// ⚠️ An earlier draft of this file RECONSTRUCTED the full frames from the decoded bit
// signals. The capture shows why that was dropped: at the peak the real frame is
// `80 3E A2 04 07 04 78 FE` and the reconstruction had `00 3E A2 44 07 04 78 FE` — b4-7
// exactly right, b0 and b3 both wrong, because the undecoded bits were guessed.
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

function decodedValue(values: { key: string; value: number }[], key: string): number | undefined {
  return values.find(entry => entry.key === key)?.value;
}

/**
 * A captured frame's bytes. ⚠️ `parseHexBytes` rather than `Buffer.from(hex, "hex")`, which
 * stops at the first bad pair and returns a SHORT buffer with no error — a typo in bytes 5-7
 * of a b3 fixture would still decode `lie_down_detected` and pass every §4 assertion on a
 * frame nobody ever captured. This one throws, naming the string.
 */
function frameBytes(hex: string): Buffer {
  return Buffer.from(parseHexBytes(hex));
}

/** Drives `count` identical frames through the decoder. */
function feed(count: number, rollDecidegrees: number, pitchDecidegrees: number): void {
  for (let index = 0; index < count; index += 1) {
    decodeAttitudeFrame(attitudeFrame(rollDecidegrees, pitchDecidegrees));
  }
}

/**
 * Runs `body` with console.warn captured and the decoder reset, and hands back the lines.
 * Each scenario gets its own array, so one cannot leak into the next — the previous shape
 * shared one array across six scenarios and reset it by hand four times, which made the
 * first assertion depend on nothing above it having warned.
 */
function captureWarnings(body: (warnings: string[]) => void): string[] {
  const captured: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]): void => {
    captured.push(args.map(String).join(" "));
  };
  try {
    resetAttitudeDecoder();
    body(captured);
  } finally {
    console.warn = realWarn;
  }
  return captured;
}

// ---------------------------------------------------------------------------------------
// 1. Real frames off the bike's own bus, replayed through the real decoder.
// ---------------------------------------------------------------------------------------

/** 16:21:58.130Z — the roll peak, and the file's most-reused frame. */
const ROLL_PEAK_FRAME = "80 3E A2 04 07 04 78 FE";

/**
 * What the bike was doing, and the expected degrees. All times UTC; the capture renders
 * them at UTC+2.
 *
 * ⚠️ A case carries EITHER the captured frame OR the raw counts, never both. Carrying both
 * looked like a cross-check and was not one: for a captured case the counts were read by
 * nothing, so changing 75 to 750 left the suite green — an assertion that cannot fail, which
 * is the shape §4 below has its own warning about. The union is what stops one coming back.
 */
type AngleCase = { what: string; roll: number; pitch: number } & (
  | { frame: string }
  | { rollDecidegrees: number; pitchDecidegrees: number }
);

const ANGLES: AngleCase[] = [
  {
    what: "16:21:57.051, creeping at 3.2 km/h up a ~34 % gravel climb on the front brake, 0.9 s before it went over",
    frame: "80 3E A2 44 4B 00 34 FF",
    roll: 7.5,
    pitch: -20.4,
  },
  {
    what: "16:21:57.911, the first frame past +45° — 89 ms into a 350 °/s roll rate",
    frame: "80 3E A2 04 C5 01 0B FE",
    roll: 45.3,
    pitch: -50.1,
  },
  {
    what: "16:21:58.130, the highest roll OF THE FALL that the ride log holds — not of the log, which reaches +174.2° on a wrap transient. Not the true peak of the fall either: the next frame reads +104.1° and the 1.0° deadband hid it, which is why a check on 'the maximum' would be asserting a property of the log rather than of the bike",
    frame: ROLL_PEAK_FRAME,
    roll: 103.1,
    pitch: -39.2,
  },
  {
    what: "16:21:58.671, at rest on its right side on the panniers. +71.6° rather than 90° because the luggage held it off the ground — a property of the bike's load, not of the sensor",
    frame: "80 3E 02 44 CC 02 53 FF",
    roll: 71.6,
    pitch: -17.3,
  },
  // The remaining two fall outside the recovered 60-second window, so only the decoded
  // counts survive for them. They are kept because each pins something the four above
  // cannot: the sign against the side stand, and that the ±180° band is really reached.
  {
    what: "16:15:20.950, parked, side stand DOWN — the sign reference. b4-5 is 83 FF, byte-identical to the frame the 2026-09-08 KWP read proved against bank 2 id 138",
    rollDecidegrees: -125,
    pitchDecidegrees: -17,
    roll: -12.5,
    pitch: -1.7,
  },
  {
    what: "15:02:18.753 at 63.9 km/h, the archive's most negative roll — an atan2 wrap after a hard hit, NOT an attitude. Both axes swing and recover inside 60 ms; it is here to prove the ±180° band is reachable and must not be gated away",
    rollDecidegrees: -1703,
    pitchDecidegrees: -46,
    roll: -170.3,
    pitch: -4.6,
  },
];

console.log("1. frames from the fall of 2026-09-13, replayed through decodeAttitudeFrame");
resetAttitudeDecoder();
for (const angleCase of ANGLES) {
  // Where the real frame survives, decode THAT — all eight bytes, as the bike sent them.
  // Where it does not, synthesise a payload carrying only the two counts.
  const captured = "frame" in angleCase;
  const payload = captured
    ? frameBytes(angleCase.frame)
    : attitudeFrame(angleCase.rollDecidegrees, angleCase.pitchDecidegrees);
  const decoded = decodeAttitudeFrame(payload);
  const roll = decodedValue(decoded, "attitude_roll_deg");
  const pitch = decodedValue(decoded, "attitude_pitch_deg");
  const origin = captured ? "captured frame" : "counts only";
  check(`[${origin}] ${angleCase.what} → roll ${angleCase.roll}°`, roll === angleCase.roll);
  check(`  … and pitch ${angleCase.pitch}°`, pitch === angleCase.pitch);
}

// The same counts through the whole-frame path. ⚠️ RESTORED: an earlier rewrite of §1
// dropped this, and with it gone `...decodeAttitudeFrame(data)` → `...[]` in decode.ts's
// 0x102 case passes the whole suite — 0x102 can stop emitting both angles with nothing red.
const throughDecodeFrame = decodeFrame(0x102, frameBytes(ROLL_PEAK_FRAME));
check(
  "decodeFrame(0x102, …) still ROUTES b4-7 to the attitude decoder — not just decodeAttitudeFrame directly",
  decodedValue(throughDecodeFrame, "attitude_roll_deg") === 103.1 &&
    decodedValue(throughDecodeFrame, "attitude_pitch_deg") === -39.2
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
  decodedValue(atLimit, "attitude_roll_deg") === 180 && decodedValue(atLimit, "attitude_pitch_deg") === -180
);

resetAttitudeDecoder();
const pastLimit = decodeAttitudeFrame(attitudeFrame(MAX_DECIDEGREES + 1, 0));
check(
  `a roll count of ${MAX_DECIDEGREES + 1} is dropped rather than logged as an angle`,
  decodedValue(pastLimit, "attitude_roll_deg") === undefined
);
check(
  "…and the pitch in the SAME frame is still emitted, so one bad axis cannot mute the other",
  decodedValue(pastLimit, "attitude_pitch_deg") === 0
);

// ⚠️ BOTH SIGNS, deliberately. The guard is `Math.abs(decidegrees) > MAX_DECIDEGREES`, and
// an edit to a bare `decidegrees > MAX_DECIDEGREES` passes every positive case above while
// letting −180.1° through as a plausible angle. Mutation-tested: dropping the Math.abs
// fails this line and nothing else in the file.
resetAttitudeDecoder();
const pastNegativeLimit = decodeAttitudeFrame(attitudeFrame(-(MAX_DECIDEGREES + 1), -(MAX_DECIDEGREES + 1)));
check(
  `a roll count of −${MAX_DECIDEGREES + 1} is dropped too — the band is symmetric and the wrap transients are on the negative side`,
  decodedValue(pastNegativeLimit, "attitude_roll_deg") === undefined
);
check(
  `…and −${MAX_DECIDEGREES + 1} on pitch likewise`,
  decodedValue(pastNegativeLimit, "attitude_pitch_deg") === undefined
);

// The warning is rationed to once per axis per process, after five CONSECUTIVE frames.
// Captured rather than trusted: at 100 Hz an unrationed warning fills the journal at 200
// lines a second and pushes out whatever else went wrong at the same moment.
const OUT_OF_RANGE = 3000;

const threshold = captureWarnings(warnings => {
  feed(4, OUT_OF_RANGE, 0);
  check(
    "four consecutive out-of-range frames warn about nothing — a single junk sample must not spend the diagnostic",
    warnings.length === 0
  );
  feed(1, OUT_OF_RANGE, 0);
  check("the fifth consecutive frame warns exactly once", warnings.length === 1);
  feed(50, OUT_OF_RANGE, 0);
  check("fifty more frames add no further lines — rationed once per axis per process", warnings.length === 1);
});
check(
  "the line names the axis and the offending count",
  threshold[0]?.includes("attitude_roll_deg") === true && threshold[0]?.includes(String(OUT_OF_RANGE)) === true
);

// A run broken by one good frame must start again, or a flapping signal would warn on
// an accumulation that never actually happened.
const brokenRun = captureWarnings(() => {
  feed(4, OUT_OF_RANGE, 0);
  feed(1, 0, 0);
  feed(4, OUT_OF_RANGE, 0);
});
check("a good frame resets the run, so 4 + 1 + 4 stays silent", brokenRun.length === 0);

// ⚠️ THE RATION IS PER PROCESS, NOT PER RUN, and only this case says so. Moving
// `watch.warned = false` next to the run reset in addAngle() turns one journal line per
// boot into one per burst — at 100 Hz a flapping field would then warn forever, which is
// the exact failure the ration exists to prevent. Every other case here still passes
// under that mutation; this one does not.
const secondBurst = captureWarnings(() => {
  feed(5, OUT_OF_RANGE, 0);
  feed(1, 0, 0);
  feed(5, OUT_OF_RANGE, 0);
});
check(
  "a SECOND burst after a good frame stays silent — the ration is per process, not per run",
  secondBurst.length === 1
);

// Per-axis independence: a stuck roll must not consume pitch's one warning.
const bothAxes = captureWarnings(warnings => {
  feed(20, OUT_OF_RANGE, 0);
  check("pitch still gets its own warning after roll has spent hers", warnings.length === 1);
  feed(20, 0, OUT_OF_RANGE);
});
check(
  "…and the second line names pitch, not roll",
  bothAxes.length === 2 && bothAxes[1]?.includes("attitude_pitch_deg") === true
);

// resetAttitudeDecoder() exists so replaying a second capture in one process can still
// see its own out-of-range frames. If it stopped clearing `warned`, that would be silent.
const afterReset = captureWarnings(() => feed(5, OUT_OF_RANGE, 0));
check("resetAttitudeDecoder() lets a second replay warn again", afterReset.length === 1);

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
const rollSignal = SIGNALS.find(entry => entry.key === "attitude_roll_deg");
for (const angleCase of ANGLES) {
  check(
    `the gate accepts ${angleCase.roll}° — a real reading it rejected would be drawn as a dead sensor`,
    rollSignal !== undefined && isPlausible("attitude_roll_deg", angleCase.roll, rollSignal.unit, rollSignal.group)
  );
}

// gps_course_deg fell through the same hole and, unlike the attitude pair, its gate FIRES.
// The field is 9 bits. Across the whole /dl dump — every day it holds, not just 2026-09-13 —
// 3 of 105 118 rows read past 360: two at 442.0 on 2026-08-08 and one at 366.0 on 2026-09-13,
// which is 1 of that day's 12 771. Without a bound a decode failure renders as a heading.
const course = SIGNALS.find(entry => entry.key === "gps_course_deg");
check("gps_course_deg is in the registry", course !== undefined);
if (course) {
  check(
    "gps_course_deg is gated to 0…360",
    JSON.stringify(boundsFor("gps_course_deg", course.unit, course.group)) === "[0,360]"
  );
  check("…so the 442.0 seen on 2026-08-08 is rejected", !isPlausible("gps_course_deg", 442, course.unit, course.group));
  check("…and a real heading of 359.9 is kept", isPlausible("gps_course_deg", 359.9, course.unit, course.group));
}

// ---------------------------------------------------------------------------------------
// 4. V_LIEDOWN_DETECTED — 0x102 b3 bit 5, the VCU's own fall flag.
// ---------------------------------------------------------------------------------------

console.log("\n4. the lie-down flag");
// ✅ CONFIRMED 2026-09-14 against the bike's own bytes, so this is no longer 🟡. In the
// recovered capture b3 bit 5 has EXACTLY ONE transition in 60 s — 0 → 1 at 16:21:58.811Z,
// 0.900 s after the roll crossed +45° and 0.669 s after the peak — and it never clears
// again in the remaining 3 118 frames. It LEADS the drive shutdown by 551 ms: energized,
// go_request and go all drop together at 16:21:59.362Z. A flag that fires once, when the
// bike goes down, and before the VCU cuts the drive, is a lie-down detector.
const LIE_DOWN_SET = "80 3E 02 64 C7 02 43 FF"; // 16:21:58.811Z, the rising edge
const liedownSet = decodeFrame(0x102, frameBytes(LIE_DOWN_SET));
const liedownClear = decodeFrame(0x102, frameBytes(ROLL_PEAK_FRAME));
check(
  "the captured rising-edge frame decodes lie_down_detected = 1",
  decodedValue(liedownSet, "lie_down_detected") === 1
);
check(
  "…and the captured frame from the roll PEAK, 681 ms earlier, still reads 0 — the flag is not merely a copy of a steep angle",
  decodedValue(liedownClear, "lie_down_detected") === 0
);

// ⚠️ The neighbour test only means something if the neighbour MOVES. An earlier draft
// asserted fast_dc_contactor === 0 on two payloads that both had bit 0 clear, which is an
// assertion no mutation of the lie-down mask could ever fail. These two differ in bit 0
// and bit 1 as well as bit 5, so a mask that reached across the byte fails here.
const liedownWithNeighbours = decodeFrame(0x102, Buffer.from([0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x00]));
check(
  "b3 = 0x03 — lie-down clear while BOTH neighbours are set — keeps the three apart",
  decodedValue(liedownWithNeighbours, "lie_down_detected") === 0 &&
    decodedValue(liedownWithNeighbours, "fast_dc_contactor") === 1 &&
    decodedValue(liedownWithNeighbours, "cruise_active") === 1
);
check(
  "…and the captured 0x64 — lie-down set while both neighbours are clear — is the other diagonal",
  decodedValue(liedownSet, "lie_down_detected") === 1 &&
    decodedValue(liedownSet, "fast_dc_contactor") === 0 &&
    decodedValue(liedownSet, "cruise_active") === 0
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
  decodedValue(withoutByte3, "lie_down_detected") === undefined
);

console.log("");
if (failures > 0) {
  console.error(`✗ ${failures} attitude check(s) failed`);
  process.exit(1);
}
console.log("✓ the attitude pair, its ±180° guard, its dashboard gate and the lie-down flag all hold");
