import { STREAM_IDS, decodeFrame } from "../src/can/decode.ts";
import { resetAttitudeDecoder } from "../src/can/attitude.ts";
import { resetGpsCanDecoder } from "../src/can/gps.ts";

// No decoder may emit a signal that is computed from other signals on the same frame.
//
//   node --experimental-strip-types scripts/check-derived-signals.ts
//
// The log stores the bits the bus sent, not combinations of them: a derived key costs
// rows on the SD card, a registry entry, a bounds entry and a tile, in exchange for a
// value any reader can recompute — and it adds a second thing that has to stay in step
// with the first. `brake` = `front_brake | rear_brake` was the one that existed, from
// June until 2026-08-30, and unpicking it cost a rewritten Grafana lane because both
// halves are log-on-change (docs/can-decode-findings.md §"Why `brake` was removed").
//
// This is the sweep that established `brake` was the ONLY one, kept so the next one fails
// rather than ships. It is a property of the decoders rather than of the registry on
// purpose: a key stops being derived when the decoder stops computing it, and a registry
// entry removed while the decoder still emits it would only relocate the row to "misc".
//
// ⚠️ What it can and cannot see. Two signals related by a scale or an offset (0x10B's
// km/kWh and its kWh/100km, say) are NOT caught and are not meant to be: both are read
// off the wire, and which of them is "derived" is a question about the sender, not about
// this repo. What is caught is a decoder computing a BOOLEAN from other booleans in the
// same frame, exhaustively per byte, which is the shape `brake` had.

/** Marks a payload where a key was not emitted at all — a short frame, or a gated decoder. */
const ABSENT = -1;

/**
 * What a run that actually reached the decoders looks like, as literals.
 *
 * Without a floor this check passes having tested nothing: narrow `STREAM_IDS` to nothing,
 * or let a decoder gain an early `return []` on a shape the sweep generates, and it prints
 * "0 flags that actually move, 0 combinations tried" and still exits ✓ — the failure mode
 * the whole file exists to prevent, turned on itself.
 *
 * ⚠️ Literals rather than the measured values, because an assertion phrased in the thing
 * it is checking passes for every value of that thing. Today: 20 432 payloads, 62 moving
 * flags, 14 282 combinations.
 */
const LEAST_PAYLOADS = 20_000;
const LEAST_MOVING_FLAGS = 60;
const LEAST_COMBINATIONS = 14_000;

const failures: string[] = [];
const payloads = sweepPayloads();

resetAttitudeDecoder();
resetGpsCanDecoder();

let comparisons = 0;
let booleanKeys = 0;
for (const id of STREAM_IDS) {
  const vectors = new Map<string, Int32Array>();
  payloads.forEach((payload, index) => {
    let decoded;
    try {
      decoded = decodeFrame(id, payload);
    } catch (error) {
      failures.push(
        `decodeFrame(0x${id.toString(16)}, ${payload.toString("hex")}) threw: ${error instanceof Error ? error.message : String(error)}`
      );
      return;
    }
    for (const { key, value } of decoded) {
      let vector = vectors.get(key);
      if (!vector) {
        vector = new Int32Array(payloads.length).fill(ABSENT);
        vectors.set(key, vector);
      }
      vector[index] = value;
    }
  });

  // Only the flags, and only the ones that actually move. A key stuck at one value across
  // the whole sweep matches half the expressions below by coincidence and proves nothing;
  // a non-boolean cannot be an OR of anything.
  const flags = [...vectors.entries()].filter(([, vector]) => movesBetweenZeroAndOne(vector));
  booleanKeys += flags.length;
  for (const [target, targetVector] of flags) {
    for (const [firstKey, firstVector] of flags) {
      if (firstKey === target) continue;
      comparisons += 1;
      if (matches(targetVector, index => firstVector[index])) {
        failures.push(derived(id, target, `a copy of ${firstKey}`));
      }
      if (matches(targetVector, index => (firstVector[index] ? 0 : 1))) {
        failures.push(derived(id, target, `the inverse of ${firstKey}`));
      }
      for (const [secondKey, secondVector] of flags) {
        if (secondKey === target || secondKey <= firstKey) continue;
        comparisons += 2;
        if (matches(targetVector, index => (firstVector[index] || secondVector[index] ? 1 : 0))) {
          failures.push(derived(id, target, `${firstKey} | ${secondKey}`));
        }
        if (matches(targetVector, index => (firstVector[index] && secondVector[index] ? 1 : 0))) {
          failures.push(derived(id, target, `${firstKey} & ${secondKey}`));
        }
      }
    }
  }
}

console.log(
  `swept ${STREAM_IDS.length} broadcast ids × ${payloads.length} payloads; ` +
    `${booleanKeys} flags that actually move, ${comparisons} combinations tried`
);

// A sweep that swept nothing agrees with every claim below it, so each of the three
// numbers on that line has to clear a floor before the ✓ means anything.
if (payloads.length < LEAST_PAYLOADS) {
  failures.push(
    `the payload sweep produced ${payloads.length} payloads, under the ${LEAST_PAYLOADS} a per-byte sweep of every ` +
      `DLC over both backgrounds gives (20 432 today) — it is no longer exhaustive per byte, so a derived flag can ` +
      `hide in the values it stopped generating`
  );
}
if (booleanKeys < LEAST_MOVING_FLAGS) {
  failures.push(
    `only ${booleanKeys} moving 0/1 signals were found across ${STREAM_IDS.length} ids, under the ` +
      `${LEAST_MOVING_FLAGS} this decoder set has (62 today) — the sweep has stopped reaching the decoders, and a ` +
      `flag it never saw move is a flag it never tested`
  );
}
if (comparisons < LEAST_COMBINATIONS) {
  failures.push(
    `only ${comparisons} combinations were tried, under the ${LEAST_COMBINATIONS} these flags produce (14 282 ` +
      `today) — the ✓ below would be reporting that nothing was compared`
  );
}

if (failures.length > 0) {
  console.error("FAILED:");
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  process.exit(1);
}
console.log("✓ no decoder emits a flag that is an identity, inverse, OR or AND of other flags on the same frame");

function derived(id: number, key: string, expression: string): string {
  return (
    `0x${id.toString(16).toUpperCase().padStart(3, "0")} emits \`${key}\`, which is exactly ${expression} over every ` +
    `payload swept — so it is computed, not measured, and the log should not carry it. Emit the parts and let the ` +
    `reader combine them; docs/can-decode-findings.md §"The log stores measured bits, not combinations of them"`
  );
}

/** True where the key was emitted with the value the expression predicts, everywhere it was emitted at all. */
function matches(target: Int32Array, expected: (index: number) => number): boolean {
  for (let index = 0; index < target.length; index++) {
    if (target[index] === ABSENT) continue;
    if (target[index] !== expected(index)) return false;
  }
  return true;
}

function movesBetweenZeroAndOne(vector: Int32Array): boolean {
  let sawZero = false;
  let sawOne = false;
  for (const value of vector) {
    if (value === ABSENT) continue;
    if (value === 0) sawZero = true;
    else if (value === 1) sawOne = true;
    else return false;
  }
  return sawZero && sawOne;
}

/**
 * Every value of every byte, at every DLC, against both a 0x00 and a 0xFF background —
 * 18 432 payloads — plus 2 000 pseudo-random full frames.
 *
 * The per-byte sweep is what makes the answer exhaustive for a flag that lives in one
 * byte, which every flag on this bus does. The random frames are for the cross-byte case
 * the sweep fixes one byte at a time and would otherwise miss; the generator is seeded so
 * a failure here is reproducible rather than a coin toss on the next run.
 */
function sweepPayloads(): Buffer[] {
  const list: Buffer[] = [];
  for (let length = 1; length <= 8; length++) {
    for (let index = 0; index < length; index++) {
      for (let value = 0; value < 256; value++) {
        const overZeroes = Buffer.alloc(length);
        overZeroes[index] = value;
        list.push(overZeroes);
        const overOnes = Buffer.alloc(length, 0xff);
        overOnes[index] = value;
        list.push(overOnes);
      }
    }
  }
  const random = seededRandom(0x102);
  for (let frame = 0; frame < 2000; frame++) {
    const payload = Buffer.alloc(8);
    for (let index = 0; index < 8; index++) {
      payload[index] = Math.floor(random() * 256);
    }
    list.push(payload);
  }
  return list;
}

/** mulberry32 — small, seeded, and identical on every machine that runs the check. */
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}
