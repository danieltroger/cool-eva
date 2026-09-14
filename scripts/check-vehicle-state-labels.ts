import { readFile } from "node:fs/promises";
import { SIGNALS } from "../src/can/registry.ts";
import {
  LATCHING_SUBSTATES,
  NEVER_CAPTURED,
  PAIR_LABELS,
  STATE_KEY,
  STATE_LABELS,
  SUBSTATE_KEY,
  UNLABELLED,
  labelFor,
} from "../public/lib/state-labels.js";
// parseHexBytes and not a Number.parseInt map: a typo yields NaN, Buffer.from stores 0, and
// the probe then asserts against a frame nobody captured. scripts/check-vehicle-status.ts
// carries the same warning at its own fixture parser, which is where this one was copied from.
import { parseHexBytes } from "./captured-vcu-records.ts";
import { decodeVehicleStatusFrame } from "../src/can/vehicle-status.ts";
import { markdownTables, selectTable } from "./markdown-tables.ts";
import { BEHAVIOUR } from "./captured-0x101-label-frames.ts";
import type { Probe } from "./captured-0x101-label-frames.ts";

// Whether the words the ALL page prints under the two 0x101 tiles still match the document
// they were copied from.
//
//   node --experimental-strip-types scripts/check-vehicle-state-labels.ts
//
// public/lib/state-labels.js is a transcription of two tables in docs/can-0x101.md, and a
// transcription rots. This reads both tables back out of the document and compares them, in
// both directions, so neither side can move alone — and then runs the real `pairLabel()` over
// real frames, because agreeing tables do not prove the function that reads them works.
//
// Findings and the vocabulary itself live in docs/can-0x101.md, never here.

const DOC = new URL("../docs/can-0x101.md", import.meta.url);

/**
 * 🚨 Hand-written, and deliberately not derived from the mapping.
 *
 * A "which pairs must carry a phrase" list computed from `PAIR_LABELS` would bless an empty
 * one — `scripts/check-all-view-tiles.ts`'s `MUST_LATCH` argument. These are the pairs
 * docs/can-0x101.md §"What is still open" names as identified, and that bullet and this list
 * have to be edited together: they drifted apart once already, inside the commit that widened
 * the bullet to name 53 and state 100.
 */
const MUST_LABEL: Record<string, string> = {
  "60/62": "parked — the pair the engineering menu shows",
  "40/43": "riding",
  "40/52": "park assist",
  "40/53": "park assist too — measured in docs/vcu-reverse-and-backup.md §8 by the shared ~59 Nm ceiling",
  "80/83": "the blocking fault — 194 947 of 194 948 archive frames carrying 0x100's blocking-fault bit",
  // ⚠️ The two charging pairs are here for the reason the list exists at all. Without them,
  // nulling 100/104 and deleting its vocabulary row leaves the suite GREEN — silently undoing
  // a 15-million-frame result, because A accepts a null in the band table and B only compares
  // phrases that exist on one side.
  "100/101": "AC charging — 7 314 307 frames across 41 files carry the bike's own ac_charging bit",
  "100/104": "DC charging — 1 510 183 of the pair's 1 510 350 frames carry dc_charging",
};

/**
 * 🚨 …and the counts, hard-coded for the same reason.
 *
 * A row count read out of the parse is a budget derived from the thing under test: it moves
 * with the document and can never fire. These are read from the DOCUMENT and tested against
 * the JS, which is the other way round.
 *
 * ⚠️ Honest about what each one buys, because an earlier version of this comment claimed more.
 * `VOCABULARY_*` is the one that catches something nothing else does: a row whose phrase is
 * `—` is skipped by both arms of B, so deleting one is invisible to A-D. The band counts can
 * only fire when both sides were changed together — they are a speed bump that makes a human
 * acknowledge the vocabulary changed size, not a second opinion on the document.
 */
const BAND_PAIRS = 35;
const BAND_STATES = 6;
const VOCABULARY_PAIR_ROWS = 14;
const VOCABULARY_LATCHED_ROWS = 3;
const STATE_VOCABULARY_ROWS = 1;

/** No label may name a gear: reverse is `rolling_backwards` on 0x104, not a 0x101 state. */
const FORBIDDEN_IN_A_PHRASE = /revers|gear|forward|neutral/i;

const failures: string[] = [];
const text = await readFile(DOC, "utf-8");
const tables = markdownTables(text);

// 1. The band table — which (state, substate) pairs exist at all.
const bandTable = selectTable(
  tables,
  // .some(), not .includes(): the header cells read "b1 (v_vehicle_state)", so an exact element
  // match finds nothing — which is how this selector first shipped, and what assertion G caught.
  header =>
    header.some(cell => cell.includes("v_vehicle_state")) && header.some(cell => cell.includes("v_vehicle_substate")),
  "the state/substate band table",
  failures
);
const documentedPairs = new Set<string>();
const documentedStates = new Set<number>();
for (const row of bandTable?.rows ?? []) {
  const state = Number(row[0]);
  if (!Number.isInteger(state)) {
    failures.push(`the band table has a row whose state is not a number: ${JSON.stringify(row)}`);
    continue;
  }
  documentedStates.add(state);
  if (row.length < 2) {
    // Indexing row[1] on a short row throws, and under top-level await that kills the run
    // before any failure already collected is printed.
    failures.push(`the band table has a row with ${row.length} cells: ${JSON.stringify(row)}`);
    continue;
  }
  for (const part of row[1].split(",")) {
    // /^\d+$/ and not Number.isInteger(Number(x)): `Number("")` is 0, so a trailing comma in
    // the document used to add a phantom substate 0 and step straight over this guard.
    const substate = /^\d+$/.test(part.trim()) ? Number(part.trim()) : NaN;
    if (!Number.isInteger(substate)) {
      failures.push(`the band table's state ${state} lists a substate that is not a number: "${part.trim()}"`);
      continue;
    }
    documentedPairs.add(`${state}/${substate}`);
  }
}
if (documentedPairs.size !== BAND_PAIRS || documentedStates.size !== BAND_STATES) {
  failures.push(
    `the band table in docs/can-0x101.md parsed as ${documentedPairs.size} pairs over ${documentedStates.size} ` +
      `states; this check is written against ${BAND_PAIRS} over ${BAND_STATES}. If the bike really has produced a ` +
      `new one, add it to public/lib/state-labels.js and raise the count here — that pair currently renders ` +
      `"${NEVER_CAPTURED}" on the dashboard, which is the thing worth noticing`
  );
}

// 2. The vocabulary table — what a pair MEANS, and the only place a phrase may come from.
const vocabulary = selectTable(
  tables,
  header => header.join("|") === "state|substate|label|what says so",
  "the pair vocabulary table",
  failures
);
const documentedPhrases = new Map<string, string | null>();
const documentedLatched = new Map<number, string | null>();
for (const row of vocabulary?.rows ?? []) {
  const phrase = row[2] === "—" ? null : row[2];
  if (row[0] === "latched") {
    documentedLatched.set(Number(row[1]), phrase);
  } else {
    documentedPhrases.set(`${row[0]}/${row[1]}`, phrase);
  }
}
// Counted separately, which is strictly stronger than one total: a row moving from the pair
// half to the latched half keeps a combined count at 17 and would go unnoticed.
if (documentedPhrases.size !== VOCABULARY_PAIR_ROWS || documentedLatched.size !== VOCABULARY_LATCHED_ROWS) {
  failures.push(
    `the vocabulary table parsed as ${documentedPhrases.size} pair rows and ${documentedLatched.size} latched ` +
      `ones, against the ${VOCABULARY_PAIR_ROWS} and ${VOCABULARY_LATCHED_ROWS} this check is written for — raise ` +
      `the counts here in the same commit that adds or removes a row`
  );
}

// 3. The state vocabulary — the one state whose own meaning is measured.
const stateVocabulary = selectTable(
  tables,
  header => header.join("|") === "state|label|what says so",
  "the state vocabulary table",
  failures
);
const documentedStatePhrases = new Map<number, string>();
for (const row of stateVocabulary?.rows ?? []) {
  documentedStatePhrases.set(Number(row[0]), row[1]);
}
if (documentedStatePhrases.size !== STATE_VOCABULARY_ROWS) {
  failures.push(
    `the state vocabulary table parsed as ${documentedStatePhrases.size} rows against ${STATE_VOCABULARY_ROWS}`
  );
}

// A. The mapping covers the band table exactly — both directions.
for (const pair of documentedPairs) {
  if (!PAIR_LABELS.has(pair)) {
    failures.push(
      `docs/can-0x101.md's band table has ${pair} and public/lib/state-labels.js does not, so the dashboard calls a ` +
        `pair the archive HAS produced "${NEVER_CAPTURED}" — add it with a phrase, or with null if nobody knows what it is`
    );
  }
}
for (const pair of PAIR_LABELS.keys()) {
  // Only meaningful once the table parsed; otherwise every pair cascades over one real failure.
  if (bandTable && !documentedPairs.has(pair)) {
    failures.push(`public/lib/state-labels.js maps ${pair}, which is in no band in docs/can-0x101.md's band table`);
  }
}

// B. Every phrase matches its row, and every row has a phrase — both directions.
for (const [pair, phrase] of PAIR_LABELS) {
  if (phrase === null) continue;
  const documented = documentedPhrases.get(pair);
  if (documented === undefined) {
    failures.push(`public/lib/state-labels.js labels ${pair} "${phrase}" and the vocabulary table has no row for it`);
  } else if (documented !== phrase) {
    failures.push(`${pair} is "${phrase}" in public/lib/state-labels.js and "${documented}" in docs/can-0x101.md`);
  }
}
// Guarded once rather than per iteration: a vocabulary table that failed to select reports
// that once, rather than sixteen times over as a missing row.
for (const [key, phrase] of vocabulary ? documentedPhrases : []) {
  const mapped = PAIR_LABELS.get(key);
  if (mapped === undefined) {
    failures.push(
      `docs/can-0x101.md's vocabulary table has a row for ${key}, which public/lib/state-labels.js does not map`
    );
  } else if (mapped !== phrase) {
    failures.push(
      `${key} is "${phrase}" in docs/can-0x101.md and ${JSON.stringify(mapped)} in public/lib/state-labels.js`
    );
  }
}

// C. The three bit-7 substates, which belong to no band and so cannot be covered by A.
for (const [substate, phrase] of vocabulary ? LATCHING_SUBSTATES : []) {
  const documented = documentedLatched.get(substate);
  if (documented === undefined) {
    failures.push(
      `public/lib/state-labels.js carries latching substate ${substate} with no row in the vocabulary table`
    );
  } else if (documented !== phrase) {
    failures.push(
      `latching substate ${substate} is ${JSON.stringify(phrase)} in the mapping and ${JSON.stringify(documented)} in the document`
    );
  }
}
for (const substate of documentedLatched.keys()) {
  if (!LATCHING_SUBSTATES.has(substate)) {
    failures.push(
      `the vocabulary table has a latched row for substate ${substate}, which public/lib/state-labels.js does not carry`
    );
  }
}

// D. The state-level fallback.
for (const [state, phrase] of STATE_LABELS) {
  if (documentedStatePhrases.get(state) !== phrase) {
    failures.push(
      `state ${state} is "${phrase}" in the mapping and ${JSON.stringify(documentedStatePhrases.get(state))} in the document`
    );
  }
}
for (const [state, phrase] of documentedStatePhrases) {
  if (STATE_LABELS.get(state) !== phrase) {
    failures.push(
      `the state vocabulary table names state ${state} "${phrase}" and public/lib/state-labels.js does not`
    );
  }
}

// E. No label names a gear.
for (const phrase of [...PAIR_LABELS.values(), ...LATCHING_SUBSTATES.values(), ...STATE_LABELS.values()]) {
  if (phrase !== null && FORBIDDEN_IN_A_PHRASE.test(phrase)) {
    failures.push(
      `the phrase "${phrase}" names a gear or a direction. The bike's reverse is not a 0x101 state — it is ` +
        `rolling_backwards on 0x104 and the REVERSE_* parameters — and docs/vcu-reverse-and-backup.md flags the ` +
        `52-is-reverse attribution as the weakest link in its own chain`
    );
  }
}

// F. The identified pairs still carry a phrase.
for (const [pair, why] of Object.entries(MUST_LABEL)) {
  if (!PAIR_LABELS.get(pair)) {
    failures.push(`${pair} has no phrase in public/lib/state-labels.js, and it is ${why}`);
  }
}

// G. The function the tile actually calls, over frames the bike really sent.
for (const probe of BEHAVIOUR) {
  const decoded = new Map(
    decodeVehicleStatusFrame(Buffer.from(parseHexBytes(probe.hex))).map(value => [value.key, value.value])
  );
  const state = decoded.get(STATE_KEY);
  const substate = decoded.get(SUBSTATE_KEY);
  if (state === undefined || substate === undefined) {
    failures.push(`${probe.what}: the frame did not decode to a state and a substate`);
    continue;
  }
  // Through labelFor(), i.e. the entry point public/views/all.js actually calls, so the
  // per-key dispatch is covered rather than assumed. The two functions under it are exported
  // for the document's sake, not for the tile's.
  const got = labelFor(probe.tile === "state" ? STATE_KEY : SUBSTATE_KEY, { state, substate });
  if (!got) {
    failures.push(`${probe.what}: labelFor() returned nothing for a key that must have a vocabulary`);
    continue;
  }
  if (got.text !== probe.expect) {
    failures.push(`${probe.what}: ${state}/${substate} renders "${got.text}" and should render "${probe.expect}"`);
  }
  // Derived from the hand-written `expect`, not from the function under test, so it still
  // fires if words() flips the flag — and eleven table fields that could only ever be written
  // one way stop being maintained by hand.
  const documented = probe.expect !== NEVER_CAPTURED;
  if (got.documented !== documented) {
    failures.push(`${probe.what}: ${state}/${substate} is documented=${got.documented}, expected ${documented}`);
  }
}

// H. The two keys the label line renders under, pinned against the registry. A rename there
//    that missed public/lib/state-labels.js makes the line silently disappear — the failure
//    scripts/check-all-view-tiles.ts guards against for public/lib/latched.js's keys.
for (const key of [STATE_KEY, SUBSTATE_KEY]) {
  if (!SIGNALS.some(signal => signal.key === key)) {
    failures.push(
      `public/lib/state-labels.js labels "${key}", which src/can/registry.ts does not define — the ALL page would ` +
        `render no label line at all, and nothing else would say so`
    );
  }
}

console.log(
  `${documentedPairs.size} pairs and ${documentedPhrases.size} vocabulary rows read out of docs/can-0x101.md`
);
console.log(
  `${BEHAVIOUR.length} frames run through labelFor(); ${BEHAVIOUR.filter(probe => probe.synthetic).length} of them synthetic`
);

if (failures.length > 0) {
  console.error("FAILED:");
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  process.exit(1);
}
console.log(
  `✓ the ${BAND_PAIRS} documented pairs, the ${LATCHING_SUBSTATES.size} latching substates and the ` +
    `${STATE_LABELS.size} named state agree with docs/can-0x101.md in both directions, and no phrase names a gear`
);
