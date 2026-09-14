import { readFile } from "node:fs/promises";
import {
  LATCHING_SUBSTATES,
  NEVER_CAPTURED,
  PAIR_LABELS,
  STATE_LABELS,
  UNLABELLED,
  pairLabel,
  stateLabel,
} from "../public/lib/state-labels.js";
import { decodeVehicleStatusFrame } from "../src/can/vehicle-status.ts";
import { markdownTables, selectTable } from "./markdown-tables.ts";

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
 * one — `scripts/check-all-view-tiles.ts`'s `MUST_LATCH` argument. These four are the pairs
 * docs/can-0x101.md §"What is still open" names as identified.
 */
const MUST_LABEL: Record<string, string> = {
  "60/62": "parked — the pair the engineering menu shows",
  "40/43": "riding",
  "40/52": "park assist",
  "80/83": "the blocking fault — 194 947 of 194 948 archive frames carrying 0x100's blocking-fault bit",
};

/**
 * 🚨 …and the counts, hard-coded for the same reason.
 *
 * A row count read out of the parse is a budget derived from the thing under test: it moves
 * with the document and can never fire. If a table is reorganised these are what go red, and
 * they are the only thing standing between a regex that silently matches nothing and seven
 * assertions passing vacuously.
 */
const BAND_PAIRS = 35;
const BAND_STATES = 6;
const VOCABULARY_ROWS = 17;
const STATE_VOCABULARY_ROWS = 1;

/** No label may name a gear: reverse is `rolling_backwards` on 0x104, not a 0x101 state. */
const FORBIDDEN_IN_A_PHRASE = /revers|gear|forward|neutral/i;

interface Probe {
  what: string;
  hex: string;
  tile: "state" | "substate";
  expect: string;
  documented: boolean;
  synthetic?: true;
}

/**
 * Frames through the real decoder and the real label functions.
 *
 * ⚠️ Real bytes wherever a real frame can reach the branch, because a label pinned to a frame
 * the bike sent cannot be argued with. Two branches no capture can ever reach are marked
 * `synthetic` — the convention scripts/check-vehicle-status.ts already uses — and they are the
 * newest code in the file: a pair in NEITHER table is by construction one the bike has never
 * sent, and it is the branch the "never captured" sentinel lives in.
 */
const BEHAVIOUR: Probe[] = [
  {
    what: "parked",
    hex: "3E 3C 04 04 64 00 00 00",
    tile: "substate",
    expect: "parked",
    documented: true,
  },
  {
    what: "🔥 substate 150, bit 7 set — the branch that proves the latching lookup runs BEFORE the band lookup. 150 is in no band, so a band-first pairLabel() calls a documented start-up step uncaptured",
    hex: "96 28 04 04 64 00 00 00",
    tile: "substate",
    expect: "drive-enable step",
    documented: true,
  },
  {
    what: "riding",
    hex: "2B 28 06 44 72 00 00 00",
    tile: "substate",
    expect: "riding",
    documented: true,
  },
  {
    what: "park assist — and ⚠️ NOT a direction: 52 and 53 both read the same phrase",
    hex: "34 28 06 0C 4B 00 00 00",
    tile: "substate",
    expect: "park assist",
    documented: true,
  },
  {
    what: "the blocking fault",
    hex: "53 50 04 14 55 00 00 00",
    tile: "substate",
    expect: "blocking fault",
    documented: true,
  },
  {
    what: "state 1 / substate 3 — documented, and nobody knows what it is",
    hex: "03 01 04 14 64 00 00 00",
    tile: "substate",
    expect: UNLABELLED,
    documented: true,
  },
  {
    what: "the state tile over a state whose own meaning is measured but whose substate's is not",
    hex: "66 64 04 14 64 00 00 00",
    tile: "state",
    expect: "charging",
    documented: true,
  },
  {
    what: "SYNTHETIC — a pair in NEITHER table. No capture can carry one by definition, and this is the branch the sentinel lives in",
    hex: "2B 64 04 14 64 00 00 00",
    tile: "substate",
    expect: NEVER_CAPTURED,
    documented: false,
    synthetic: true,
  },
  {
    what: "SYNTHETIC — a bit-7 substate that is in no table either",
    hex: "91 64 04 14 64 00 00 00",
    tile: "substate",
    expect: NEVER_CAPTURED,
    documented: false,
    synthetic: true,
  },
];

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
  for (const part of row[1].split(",")) {
    const substate = Number(part.trim());
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
for (const row of vocabulary?.rows ?? []) {
  documentedPhrases.set(
    row[0] === "latched" ? `latched/${row[1]}` : `${row[0]}/${row[1]}`,
    row[2] === "—" ? null : row[2]
  );
}
if (documentedPhrases.size !== VOCABULARY_ROWS) {
  failures.push(
    `the vocabulary table parsed as ${documentedPhrases.size} rows against the ${VOCABULARY_ROWS} this check is ` +
      `written for — raise the count here in the same commit that adds or removes one`
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
for (const [key, phrase] of documentedPhrases) {
  if (key.startsWith("latched/")) continue;
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
for (const [substate, phrase] of LATCHING_SUBSTATES) {
  const documented = documentedPhrases.get(`latched/${substate}`);
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
for (const key of documentedPhrases.keys()) {
  if (!key.startsWith("latched/")) continue;
  if (!LATCHING_SUBSTATES.has(Number(key.slice("latched/".length)))) {
    failures.push(`the vocabulary table has a latched row for ${key}, which public/lib/state-labels.js does not carry`);
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

// F. The four identified pairs still carry a phrase.
for (const [pair, why] of Object.entries(MUST_LABEL)) {
  if (!PAIR_LABELS.get(pair)) {
    failures.push(`${pair} has no phrase in public/lib/state-labels.js, and it is ${why}`);
  }
}

// G. The function the tile actually calls, over frames the bike really sent.
for (const probe of BEHAVIOUR) {
  const decoded = new Map(
    decodeVehicleStatusFrame(Buffer.from(probe.hex.split(" ").map(byte => parseInt(byte, 16)))).map(value => [
      value.key,
      value.value,
    ])
  );
  const state = decoded.get("vehicle_state_can");
  const substate = decoded.get("vehicle_substate_can");
  if (state === undefined || substate === undefined) {
    failures.push(`${probe.what}: the frame did not decode to a state and a substate`);
    continue;
  }
  const got = probe.tile === "state" ? stateLabel(state, substate) : pairLabel(state, substate);
  if (got.text !== probe.expect) {
    failures.push(`${probe.what}: ${state}/${substate} renders "${got.text}" and should render "${probe.expect}"`);
  }
  if (got.documented !== probe.documented) {
    failures.push(`${probe.what}: ${state}/${substate} is documented=${got.documented}, expected ${probe.documented}`);
  }
}

console.log(
  `${documentedPairs.size} pairs and ${documentedPhrases.size} vocabulary rows read out of docs/can-0x101.md`
);
console.log(
  `${BEHAVIOUR.length} frames run through pairLabel()/stateLabel(); ${BEHAVIOUR.filter(probe => probe.synthetic).length} of them synthetic`
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
