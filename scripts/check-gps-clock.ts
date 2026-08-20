import { GpsMessageDecoder } from "../src/gps/decode.ts";
import { GPS_UTC_FLOOR_EPOCH_S } from "../src/gps/decode.ts";
import { GpsClockGate, MIN_SECONDS_BETWEEN_STEPS, REQUIRED_CONSISTENT_READINGS } from "../src/gps/clock-gate.ts";

// Replays real GPS sequences out of rides.db through the real decoder and the real
// clock gate, on a laptop, with no bike — the same trick scripts/decode-dtc-response.ts
// plays for the trouble-code decoder, and for the same reason: the bike is reachable
// for a few minutes at a time in a garage with no reception.
//
//   node --experimental-strip-types scripts/check-gps-clock.ts
//
// It guards a regression that would be SILENT — nothing crashes, nothing logs an
// error, the dashboard looks fine, and you find out weeks later when a ride's own
// analysis is wrong. Which is why it asserts against measured numbers rather than
// made-up ones. The 2060 incident behind it: docs/diagnostics-and-checks.md §8.1.
//
// ⚠️ THE FIXTURES ARE OF TWO GRADES AND THE DIFFERENCE MATTERS:
//   PROVEN    the `[row timestamp ms, gps_epoch_s]` pairs, copied out of rides.db
//             exactly as logged. The four corrupt sequences are the only four frames in
//             the whole database whose decoded UTC is beyond year 2049.
//   INFERRED  the raw 8-byte frames in the decoder section. rides.db stores decoded
//             values, not bus bytes, and the one committed capture was taken in a
//             garage with no fix — so these are re-encoded from logged values through
//             the documented bit layout. They prove the decoder's ARITHMETIC, not that
//             the hub ever emitted those exact bytes.

interface ReplaySequence {
  name: string;
  /** `[row timestamp ms, gps_epoch_s]`, verbatim from rides.db. */
  readings: [number, number][];
}

/**
 * The four corrupt frames, each with the eight readings before it and the four after.
 *
 * The row timestamp doubles as the monotonic clock here, which is honest for these
 * windows: the row clock only misbehaves where a step happened, and in the first two
 * sequences the gap after the corrupt frame (300.5 s and 298.6 s) is the 2060 burst
 * itself — the cooldown running out. The replay treats those gaps as real elapsed
 * time, which only makes corroboration harder to reach, never easier.
 */
const CORRUPT_SEQUENCES: ReplaySequence[] = [
  {
    name: "2026-08-08 18:35:25 — decoded 2060-02-16, stepped, 2 192 rows over 299.9 s",
    readings: [
      [1786214117330, 1786214117.003],
      [1786214118432, 1786214118.004],
      [1786214118983, 1786214119.0],
      [1786214120082, 1786214120.001],
      [1786214121174, 1786214121.002],
      [1786214122275, 1786214122.003],
      [1786214123386, 1786214123.004],
      [1786214123926, 1786214124.0],
      [1786214125033, 2844182125.0],
      [1786214425528, 1786214426.002],
      [1786214426629, 1786214427.003],
      [1786214427729, 1786214428.004],
      [1786214428826, 1786214429.005],
      [1786214429376, 1786214430.0],
      [1786214430487, 1786214431.001],
      [1786214431578, 1786214432.002],
      [1786214432677, 1786214433.003],
      [1786214433779, 1786214434.004],
      [1786214434329, 1786214435.0],
    ],
  },
  {
    name: "2026-08-08 20:03:29 — decoded 2060-08-08, stepped, 47 580 rows over 501.5 s",
    readings: [
      [1786219401904, 1786219400.005],
      [1786219402459, 1786219401.0],
      [1786219403686, 1786219402.002],
      [1786219404767, 1786219403.003],
      [1786219405858, 1786219404.004],
      [1786219406418, 1786219405.0],
      [1786219407513, 1786219406.001],
      [1786219408616, 1786219407.002],
      [1786219409922, 2859221008.005],
      [1786219708541, 1786219709.003],
      [1786219709638, 1786219710.004],
      [1786219710743, 1786219711.005],
      [1786219711289, 1786219712.0],
      [1786219712391, 1786219713.001],
      [1786219713486, 1786219714.002],
      [1786219714596, 1786219715.003],
      [1786219715694, 1786219716.004],
      [1786219716248, 1786219717.0],
      [1786219717344, 1786219718.001],
    ],
  },
  {
    name: "2026-08-09 01:02:24 — decoded 2060-02-26, did not step; stream normal 0.55 s later",
    readings: [
      [1786237337064, 1786237337.001],
      [1786237338165, 1786237338.002],
      [1786237339266, 1786237339.003],
      [1786237340362, 1786237340.004],
      [1786237340921, 1786237341.0],
      [1786237342017, 1786237342.001],
      [1786237343114, 1786237343.002],
      [1786237344225, 1786237344.003],
      [1786237344770, 2844982944.008],
      [1786237345322, 1786237345.004],
      [1786237346426, 1786237346.005],
      [1786237346967, 1786237347.0],
      [1786237348067, 1786237348.001],
      [1786237349179, 1786237349.002],
      [1786237350269, 1786237350.003],
      [1786237351376, 1786237351.004],
      [1786237351930, 1786237352.0],
      [1786237353032, 1786237353.001],
      [1786237354122, 1786237354.002],
    ],
  },
  {
    name: "2026-08-09 13:06:29 — decoded 2060-02-09, did not step; stream normal 0.61 s later",
    readings: [
      [1786280782542, 1786280782.004],
      [1786280783097, 1786280783.0],
      [1786280784193, 1786280784.001],
      [1786280785288, 1786280785.002],
      [1786280786399, 1786280786.003],
      [1786280787496, 1786280787.004],
      [1786280788591, 1786280788.005],
      [1786280789147, 1786280789.0],
      [1786280789701, 2843557589.006],
      [1786280790307, 1786280790.001],
      [1786280791408, 1786280791.002],
      [1786280792508, 1786280792.003],
      [1786280793169, 1786280793.0],
      [1786280794361, 1786280794.002],
      [1786280795465, 1786280795.003],
      [1786280796572, 1786280796.004],
      [1786280797671, 1786280797.005],
      [1786280798211, 1786280798.0],
      [1786280799322, 1786280799.001],
    ],
  },
];

/**
 * Two real cold boots: the Pi came up with a stale clock and the GPS disagreed by
 * most of a day. These MUST still step, and quickly — a rule that stops the 2060
 * frames by also refusing these has not fixed anything, it has only moved the damage.
 *
 * The first is the session the brief describes: rows stamped 19:07 whose own GPS
 * frame says 15:53 the following day. It stayed wrong for all 95 of its readings.
 */
const COLD_BOOT_SEQUENCES: ReplaySequence[] = [
  {
    name: "2026-08-02 19:07:20 — system clock 74 772.8 s (20 h 46 m) behind GPS",
    readings: [
      [1785697640226, 1785772413.0],
      [1785697641311, 1785772414.001],
      [1785697642420, 1785772415.002],
      [1785697643511, 1785772416.003],
      [1785697644632, 1785772417.004],
      [1785697645166, 1785772418.0],
      [1785697646261, 1785772419.001],
      [1785697647360, 1785772420.002],
      [1785697648471, 1785772421.003],
      [1785697649562, 1785772422.004],
    ],
  },
  {
    name: "2026-08-08 03:13:24 — system clock 74 295.5 s (20 h 38 m) behind GPS",
    readings: [
      [1786158804501, 1786233100.005],
      [1786158805051, 1786233101.0],
      [1786158806146, 1786233102.001],
      [1786158807256, 1786233103.002],
      [1786158808348, 1786233104.003],
      [1786158809453, 1786233105.004],
      [1786158809999, 1786233106.0],
      [1786158811096, 1786233107.001],
      [1786158812196, 1786233108.002],
      [1786158813296, 1786233109.003],
    ],
  },
];

/**
 * How far forward to shift a whole replay, to prove the rule has no expiry date.
 *
 * Two shifts, not one, and the big one is the point. +10 years only proves there is no
 * calendar ceiling BELOW 2036 — a reintroduced ceiling of 2049 would pass it, since the
 * shifted good data lands at 2036 and the shifted corrupt frames at 2070. +100 years
 * puts the good data at 2126, above any ceiling anyone would plausibly write down, so
 * between them there is nowhere left to hide one.
 */
const REPLAY_SHIFTS_MS: [string, number][] = [
  ["+10 years", 10 * 365.25 * 86_400_000],
  ["+100 years", 100 * 365.25 * 86_400_000],
];

const failures: string[] = [];

// ---------------------------------------------------------------- corrupt frames
console.log("── the four corrupt frames in rides.db ".padEnd(78, "─"));
for (const sequence of CORRUPT_SEQUENCES) {
  runCorruptCase(sequence, 0, failures);
}

// Same four, shifted forward. Every verdict must be identical: nothing in the rule
// names a year, so nothing about it can stop working later — which is the whole
// objection to a hard-coded 2024–2035 window.
for (const [label, shiftMs] of REPLAY_SHIFTS_MS) {
  console.log(`\n── the same four, replayed ${label} `.padEnd(78, "─"));
  for (const sequence of CORRUPT_SEQUENCES) {
    runCorruptCase(sequence, shiftMs, failures);
  }
}

// ------------------------------------------------------------------- cold boots
console.log(`\n── real cold boots, which must still step `.padEnd(78, "─"));
for (const sequence of COLD_BOOT_SEQUENCES) {
  runColdBootCase(sequence, 0, failures);
}
for (const [label, shiftMs] of REPLAY_SHIFTS_MS) {
  console.log(`\n── the same cold boots, replayed ${label} `.padEnd(78, "─"));
  for (const sequence of COLD_BOOT_SEQUENCES) {
    runColdBootCase(sequence, shiftMs, failures);
  }
}

// ------------------------------------------------------- the recoverable cooldown
console.log(`\n── the cooldown must not lock in a bad step `.padEnd(78, "─"));
{
  // A cold boot steps, and then — the pathology — the wall clock is 34 years out and
  // the satellites keep saying so. Before 2026-08-16 the 300 s cooldown swallowed
  // every one of those corrections; that is what made one frame cost five minutes.
  const gate = new GpsClockGate();
  const start = 1786214100000;
  const CLOCK_GOES_BAD_AT = 8;
  let firstRecoveryMs = -1;
  for (let index = 0; index < 400; index += 1) {
    const monotonic = start + index * 1000;
    const gps = 1786214100 + index;
    // A normal session, then at index 8 the wall clock is 34 years out — as it was
    // for 299.9 s and 501.5 s in the log — and the satellites go on saying so.
    const systemClock = index < CLOCK_GOES_BAD_AT ? gps : gps + 1_057_968_000;
    const verdict = gate.offer(gps, systemClock, monotonic);
    if (verdict.step && index >= CLOCK_GOES_BAD_AT && firstRecoveryMs < 0) {
      firstRecoveryMs = monotonic - (start + CLOCK_GOES_BAD_AT * 1000);
      if (verdict.reason !== "clock-implausible") {
        failures.push(`recovery from a bad step should be reported as clock-implausible, got ${verdict.reason}`);
      }
    }
  }
  // The number that matters. Before 2026-08-16 this was MIN_SECONDS_BETWEEN_STEPS —
  // 300 s of rows stamped 2060 — because the cooldown swallowed every correction. It
  // should now be one reading: the clock is already known-bad, so nothing has to be
  // re-corroborated. Asserting the bound rather than "it stepped at all" is the point;
  // a count alone would pass even with the cooldown deleted outright.
  const RECOVERY_BUDGET_MS = 5_000;
  if (firstRecoveryMs < 0) {
    failures.push("a clock left 34 years out was never re-stepped — the cooldown is still locking the damage in");
  } else if (firstRecoveryMs > RECOVERY_BUDGET_MS) {
    failures.push(
      `recovery from a bad step took ${firstRecoveryMs / 1000} s, budget ${RECOVERY_BUDGET_MS / 1000} s ` +
        `(it was ${MIN_SECONDS_BETWEEN_STEPS} s before the fix)`
    );
  }
  console.log(
    `  ✓ clock stranded at 2060 → re-stepped ${firstRecoveryMs / 1000} s later, not ${MIN_SECONDS_BETWEEN_STEPS} s`
  );

  // …and the cooldown must still do its actual job, which is not thrashing over a
  // couple of minutes' drift while systemd-timesyncd disciplines the clock too.
  const thrash = new GpsClockGate();
  let smallSteps = 0;
  for (let index = 0; index < 40; index += 1) {
    if (thrash.offer(1786214100 + index, 1786214100 + index - 120, start + index * 1000).step) {
      smallSteps += 1;
    }
  }
  if (smallSteps !== 1) {
    failures.push(
      `a steady 120 s offset should be stepped once, not ${smallSteps} times — the cooldown is not holding`
    );
  }
  console.log(`  ✓ steady 120 s offset → ${smallSteps} step, then held by the cooldown`);
}

// --------------------------------------------------- the anchor must self-heal
console.log(`\n── an anchor that cannot be reconfirmed must expire `.padEnd(78, "─"));
{
  // The known-good anchor is what distinguishes "we never had a good time" from "we
  // had one and this disagrees". It has to be able to go stale, or a session that
  // once held a wrong-but-corroborated time could never correct itself again —
  // trading a five-minute lock-in for a permanent one.
  //
  // rides.db has two real stretches that exercise this: satellite time jumping 607 s
  // and 88 s with no monotonic time to back it up, which the gate refuses for 43 and
  // 421 readings respectively. Both are inside any year window ever proposed, so the
  // old check could not have seen them at all.
  const gate = new GpsClockGate();
  const start = 1786214100000;
  for (let index = 0; index < 10; index += 1) {
    gate.offer(1786214100 + index, 1786214100 + index, start + index * 1000);
  }
  // Now the satellites insist on a time 10 minutes ahead, consistently, forever.
  let firstAcceptedAfterMs = -1;
  for (let index = 0; index < 900; index += 1) {
    const monotonic = start + 10_000 + index * 1000;
    const verdict = gate.offer(1786214710 + index, 1786214110 + index, monotonic);
    if (verdict.step && firstAcceptedAfterMs < 0) {
      firstAcceptedAfterMs = monotonic - start;
    }
  }
  // …and the case that expiry alone would turn into an oscillator: two sources
  // disagreeing by 607 s, alternating frame by frame, which is what the +607 s cluster
  // in rides.db looks like if it had a second source interleaved with it. Neither may
  // win: no window is ever self-consistent, so the gate must refuse both and SAY SO,
  // rather than adopting whichever happened to be talking when the anchor expired.
  const contested = new GpsClockGate();
  let contestedSteps = 0;
  let saidSomethingIsWrong = false;
  for (let index = 0; index < 2000; index += 1) {
    const monotonic = 1786214100000 + index * 1000;
    const truth = 1786214100 + index;
    const verdict = contested.offer(index % 2 === 0 ? truth : truth + 607, truth, monotonic);
    if (verdict.step) {
      contestedSteps += 1;
    } else if (verdict.reason === "inconsistent-readings") {
      saidSomethingIsWrong = true;
    }
  }
  if (contestedSteps > 0) {
    failures.push(`two sources 607 s apart must not make the clock oscillate, but it stepped ${contestedSteps} times`);
  }
  if (!saidSomethingIsWrong) {
    failures.push("a permanently self-contradicting stream must be reported as inconsistent-readings, not stay quiet");
  }
  console.log(`  ✓ two sources 607 s apart, alternating → ${contestedSteps} steps, reported as inconsistent`);

  if (firstAcceptedAfterMs < 0) {
    failures.push("a persistently disagreeing satellite time must eventually be accepted — the anchor never expired");
  } else {
    console.log(`  ✓ anchor expired and the new time was accepted after ${(firstAcceptedAfterMs / 1000).toFixed(0)} s`);
  }
}

// ------------------------------------------------------------------- the floor
console.log(`\n── the floor, which is the only calendar bound there is `.padEnd(78, "─"));
{
  // The GPS week-number rollover is the one failure that lands a receiver in a PAST
  // year, and it is not hypothetical: it is why 1999 and 1980 turn up in GPS bug
  // reports. Five mutually consistent readings from 1999 must still be refused.
  const gate = new GpsClockGate();
  const rolledOver = Date.UTC(1999, 7, 22) / 1000;
  let accepted = 0;
  for (let index = 0; index < 10; index += 1) {
    if (gate.offer(rolledOver + index, 1786214100, 1786214100000 + index * 1000).step) {
      accepted += 1;
    }
  }
  if (accepted !== 0) {
    failures.push(`a week-rollover 1999 time must never be stepped to, but was ${accepted} time(s)`);
  }
  console.log(`  ✓ ten consistent readings from 1999-08-22 → ${accepted} steps`);
  // The floor has to stay below the oldest data the repo can be handed, or
  // decrypt-log.ts and replay-capture.ts would silently lose gps_epoch_s out of
  // history. The 2026-08 sequences replayed above are the live half of that check;
  // this is the half that names the reason.
  // Pinned to the OLDEST data this repo can be handed, not to the newest fixture here.
  // Against the fixtures the floor could be raised to 2026-07 and stay green while
  // decrypt-log.ts quietly dropped gps_epoch_s from every April–June segment — which is
  // the exact regression the floor's own comment says this check exists to catch.
  const OLDEST_DATA_THIS_REPO_HOLDS = Date.UTC(2026, 3, 1) / 1000; // April 2026, the legacy coolant history
  if (GPS_UTC_FLOOR_EPOCH_S > OLDEST_DATA_THIS_REPO_HOLDS) {
    failures.push(
      "the floor has been raised above the oldest data in the repo (April 2026) — decrypt-log.ts and " +
        "replay-capture.ts would silently drop gps_epoch_s out of history"
    );
  }
  const zeroedDateField = Date.UTC(2000, 0, 1) / 1000;
  if (zeroedDateField >= GPS_UTC_FLOOR_EPOCH_S) {
    failures.push("a zeroed date field decodes as 2000-01-01 and must be below the floor");
  }

  // NaN fails every comparison, so it would pass the corroboration test rather than
  // fail it. Nothing can produce one today; this is here because the failure mode is
  // silent acceptance and would stay silent.
  const nanGate = new GpsClockGate();
  let nanAccepted = 0;
  for (let index = 0; index < 10; index += 1) {
    if (nanGate.offer(Number.NaN, 1786214100, 1786214100000 + index * 1000).step) {
      nanAccepted += 1;
    }
  }
  if (nanAccepted !== 0) {
    failures.push(`NaN must never corroborate, but was accepted ${nanAccepted} time(s)`);
  }
  console.log(`  ✓ ten NaN readings → ${nanAccepted} steps`);
}

// --------------------------------------------------------------- the decoder
console.log(`\n── the decoder `.padEnd(78, "─"));
{
  // A frame carrying the year byte that produced 2060 must still DECODE — the raw
  // gps_epoch_s is the evidence that found this bug, and dropping it in the decoder
  // would have made the corruption invisible. Refusing to act on it is the gate's job.
  const decoder = new GpsMessageDecoder();
  decoder.decode(longitudeFrame(0, 1));
  const corrupt = decoder.decode(timeFrame({ year: 60, month: 2, day: 16, hours: 18, minutes: 35, seconds: 25 }));
  const decodedUtc = corrupt.find(value => value.key === "gps_epoch_s");
  if (!decodedUtc || new Date(decodedUtc.value * 1000).getUTCFullYear() !== 2060) {
    failures.push("a corrupt year byte must still be logged raw as gps_epoch_s, so the corruption stays visible");
  } else {
    console.log(
      `  ✓ corrupt year byte still decodes to ${new Date(decodedUtc.value * 1000).toISOString()} and is logged`
    );
  }
  // …but a year below the floor is not a date at all, so it does not reach the log.
  const belowFloor = decoder.decode(timeFrame({ year: 24, month: 6, day: 1, hours: 12, minutes: 0, seconds: 0 }));
  if (belowFloor.some(value => value.key === "gps_epoch_s")) {
    failures.push("a 2024 UTC is below the floor and must not decode");
  }
  console.log("  ✓ a 2024 UTC is below the floor and does not decode");

  // The decoder has to keep working on years the field can still express. `year` is
  // 7 bits, so 2000+year spans 2000–2127 and the 2000 pivot does not expire — provided
  // the hub keeps counting past 99 rather than wrapping, which is the one part of this
  // no capture can settle. Anything past 2127 is beyond what the frame can say at all.
  for (const year of [36, 99, 100, 127]) {
    const decoded = decoder
      .decode(timeFrame({ year, month: 8, day: 16, hours: 12, minutes: 0, seconds: 0 }))
      .find(value => value.key === "gps_epoch_s");
    const decodedYear = decoded === undefined ? undefined : new Date(decoded.value * 1000).getUTCFullYear();
    if (decodedYear !== 2000 + year) {
      failures.push(`year field ${year} should decode as ${2000 + year}, got ${decodedYear}`);
    }
  }
  console.log("  ✓ year fields 36, 99, 100 and 127 decode as 2036, 2099, 2100 and 2127");

  // Altitude is two's complement, not sign-and-magnitude: 0xFFFF is −1 m, not
  // −32 767 m. rides.db has 145 rows between −32 756 and −32 767 and none between
  // −13 and −1, which is impossible under sign-magnitude and inevitable under this.
  const altitudeDecoder = new GpsMessageDecoder();
  const nearSeaLevel = altitudeDecoder.decode(longitudeFrame(0xffff, 1));
  const altitude = nearSeaLevel.find(value => value.key === "gps_altitude_m");
  if (!altitude || altitude.value !== -1) {
    failures.push(`0xFFFF altitude should decode as −1 m (two's complement), got ${altitude?.value}`);
  }
  console.log(`  ✓ 0xFFFF altitude decodes as ${altitude?.value} m`);
  const positive = altitudeDecoder.decode(longitudeFrame(137, 1)).find(value => value.key === "gps_altitude_m");
  if (positive?.value !== 137) {
    failures.push(`a positive altitude must be unchanged, got ${positive?.value}`);
  }

  // A fix is the cluster of sub-frames from ONE cycle. A time sub-frame arriving with
  // only half a position must produce no position, rather than blending the fresh
  // half with whatever the other half was last time.
  const blend = new GpsMessageDecoder();
  blend.decode(latitudeFrame());
  blend.decode(longitudeFrame(10, 1));
  const complete = blend.decode(timeFrame({ year: 26, month: 8, day: 16, hours: 12, minutes: 0, seconds: 0 }));
  if (!complete.some(value => value.key === "gps_lat")) {
    failures.push("a complete cycle must emit a position");
  }
  const suppressedBefore = blend.suppressedFixes;
  blend.decode(longitudeFrame(10, 1)); // longitude again, no new latitude
  const halfCycle = blend.decode(timeFrame({ year: 26, month: 8, day: 16, hours: 12, minutes: 0, seconds: 1 }));
  if (halfCycle.some(value => value.key === "gps_lat" || value.key === "gps_lon")) {
    failures.push("a cycle missing its latitude sub-frame must emit no position, not a blended one");
  }
  if (blend.suppressedFixes !== suppressedBefore + 1) {
    failures.push("a suppressed fix must be counted, so a hub sending half a position can be complained about");
  }
  console.log(`  ✓ complete cycle emits a position; a half cycle emits none and is counted`);
}

console.log("");
if (failures.length > 0) {
  console.error("FAILED:");
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  process.exit(1);
}
console.log("✓ all four corrupt frames refused, both cold boots stepped, and every verdict identical ten years on");

/**
 * Replays one corrupt sequence and asserts the corrupt frame never becomes a step
 * while the good frames around it still corroborate normally.
 *
 * `offsetMs` shifts both clocks together, which is what makes the 2036 pass
 * meaningful: the sequence is the same, only the calendar moved.
 */
function runCorruptCase(sequence: ReplaySequence, offsetMs: number, collected: string[]): void {
  const gate = new GpsClockGate();
  const shiftedSeconds = offsetMs / 1000;
  let steppedToACorruptTime = 0;
  let corroboratedBefore = 0;
  let corroboratedAfter = 0;
  let seenCorrupt = false;
  let refusedByCorroboration = false;

  for (const [rowMs, gpsSeconds] of sequence.readings) {
    const monotonicMs = rowMs + offsetMs;
    const gps = gpsSeconds + shiftedSeconds;
    // The system clock is whatever the row was stamped with, which is what the
    // service actually had at that instant.
    const verdict = gate.offer(gps, rowMs / 1000 + shiftedSeconds, monotonicMs);
    const isCorruptFrame = Math.abs(gpsSeconds - rowMs / 1000) > 2 * 365 * 86_400;
    if (isCorruptFrame) {
      seenCorrupt = true;
      if (verdict.step) {
        steppedToACorruptTime += 1;
      } else if (verdict.reason === "inconsistent-readings") {
        // WHICH rule refused it, not merely that something did. Without this the
        // check would pass just as happily with a hard-coded year ceiling doing the
        // work — the thing the whole design is trying not to depend on.
        refusedByCorroboration = true;
      }
      continue;
    }
    if (verdict.step === false && verdict.reason === "in-agreement") {
      if (seenCorrupt) {
        corroboratedAfter += 1;
      } else {
        corroboratedBefore += 1;
      }
    }
  }

  if (steppedToACorruptTime > 0) {
    collected.push(`${sequence.name}: stepped to the corrupt time ${steppedToACorruptTime} time(s)`);
  }
  if (!refusedByCorroboration) {
    collected.push(`${sequence.name}: the corrupt frame was not refused BY CORROBORATION — some other rule caught it`);
  }
  if (corroboratedBefore === 0) {
    collected.push(
      `${sequence.name}: no good reading corroborated — the rule is rejecting everything, not just the corruption`
    );
  }
  // The lesson of this whole PR was that the guard against thrashing was also the
  // guard against recovery, so "it refused the bad frame" is only half a pass. The
  // stream has to come back: one corrupt reading poisons the window until it ages
  // out, and these fixtures carry enough trailing readings to show it doing so.
  if (corroboratedAfter === 0) {
    collected.push(`${sequence.name}: the stream never recovered after the corrupt frame`);
  }
  console.log(
    `  ✓ ${sequence.name}\n      corrupt steps ${steppedToACorruptTime}, refused by corroboration, ` +
      `corroborated ${corroboratedBefore} before / ${corroboratedAfter} after`
  );
}

/** Replays one cold boot and asserts it steps, within a couple of seconds. */
function runColdBootCase(sequence: ReplaySequence, offsetMs: number, collected: string[]): void {
  const gate = new GpsClockGate();
  const shiftedSeconds = offsetMs / 1000;
  let firstStepIndex = -1;
  let firstStepOffsetSeconds = 0;

  for (const [index, [rowMs, gpsSeconds]] of sequence.readings.entries()) {
    const verdict = gate.offer(gpsSeconds + shiftedSeconds, rowMs / 1000 + shiftedSeconds, rowMs + offsetMs);
    if (verdict.step && firstStepIndex < 0) {
      firstStepIndex = index;
      firstStepOffsetSeconds = verdict.offsetSeconds;
      if (verdict.reason !== "cold-boot") {
        collected.push(`${sequence.name}: first step should be reported as cold-boot, got ${verdict.reason}`);
      }
    }
  }

  if (firstStepIndex < 0) {
    collected.push(`${sequence.name}: never stepped — a cold boot with a stale clock MUST be corrected`);
    return;
  }
  if (firstStepIndex + 1 > REQUIRED_CONSISTENT_READINGS) {
    collected.push(
      `${sequence.name}: took ${firstStepIndex + 1} readings to step, more than the ${REQUIRED_CONSISTENT_READINGS} corroboration needs`
    );
  }
  const elapsedMs = sequence.readings[firstStepIndex][0] - sequence.readings[0][0];
  console.log(
    `  ✓ ${sequence.name}\n      stepped on reading ${firstStepIndex + 1} after ${(elapsedMs / 1000).toFixed(2)} s, correcting ${firstStepOffsetSeconds.toFixed(1)} s`
  );
}

/**
 * A sub-0xFE time frame carrying these fields. INFERRED: re-encoded from the bit
 * layout in src/gps/decode.ts rather than copied off the bus, because the one
 * committed capture was taken in a garage with no fix and rides.db stores decoded
 * values. It proves the arithmetic round-trips, not what the hub emitted.
 */
function timeFrame(when: {
  year: number;
  month: number;
  day: number;
  hours: number;
  minutes: number;
  seconds: number;
}): Uint8Array {
  const satellites = 9;
  return Uint8Array.from([
    26,
    0xfe,
    0,
    (when.seconds & 63) << 2,
    (when.minutes & 63) | ((when.hours & 3) << 6),
    ((when.hours >> 2) & 7) | ((when.day & 31) << 3),
    (when.month & 15) | ((when.year & 15) << 4),
    ((when.year >> 4) & 7) | ((satellites & 31) << 3),
  ]);
}

/** A sub-0x01 frame carrying a raw 16-bit altitude field and a fix value. */
function longitudeFrame(rawAltitude: number, fix: number): Uint8Array {
  const raw = rawAltitude & 0xffff;
  return Uint8Array.from([
    26,
    0x01,
    (fix & 3) | ((raw & 63) << 2),
    (raw >> 6) & 0xff,
    (raw >> 14) & 3,
    0x11,
    0x22,
    0x33,
  ]);
}

/** A sub-0x00 frame. Only its presence matters here, not the coordinate it carries. */
function latitudeFrame(): Uint8Array {
  return Uint8Array.from([26, 0x00, 0x10, 0x20, 0x30, 0x40, 0x50, 0x11]);
}
