import { SIGNALS } from "../src/can/registry.ts";
import { boundsFor } from "../public/lib/bounds.js";
import { BUTTON_GROUP, LATCHED_KEYS, getsLatchedTile } from "../public/lib/latched.js";

// Which tile each signal gets on the dashboard's ALL page, checked from Node.
//
//   node --experimental-strip-types scripts/check-all-view-tiles.ts
//
// `views/all.js` renders a signal either as `ButtonTile` — latched for 600 ms, with a
// press count and a held-for line — or as `RawTile`, which prints the number. The choice
// is `getsLatchedTile(key, group)`, and getting it wrong is silent in both directions: a
// latched signal shown raw is a ~30 ms event on a 60 Hz display, i.e. a tile that never
// visibly changes, and a lamp shown latched reads "3 presses" about something nobody
// pressed.
//
// The rule lives in `public/lib/latched.js` and not next to the tile precisely so this
// file can reach it: `views/all.js` and `lib/press.js` both import `van`, which needs a
// DOM. Same split, same reason, as `lib/flasher.js` and `scripts/check-button-decode.ts`.

/**
 * Signals that MUST get the latched tile, named here rather than derived.
 *
 * Deriving the list from `getsLatchedTile()` would make the check agree with the
 * implementation by construction — it would bless an empty set. These are hand-written
 * from what the bike does: a person's thumb moves each of them.
 */
const MUST_LATCH: Record<string, string> = {
  horn: "0x102 b2 0x10 — a horn blast is as brief as a button press",
  ignition_button: "0x102 b1 bit6 — the red button on the right bar",
};

/**
 * …and the ones that must NOT, with the reason each is not a button.
 *
 * ⚠️ `abs_event` and the other ABS flags are deliberately in NEITHER list. They are as
 * brief as a press and just as invisible, and since the tile is picked per key now,
 * naming one in LATCHED_KEYS is a one-line change — what stops it is that the tile says
 * "PRESSED" and nothing presses an ABS intervention. Asserting their absence here would
 * turn that wording decision into a two-file one for no gain.
 */
const MUST_NOT_LATCH: Record<string, string> = {
  high_beam_lamp: "a lamp OUTPUT (b2 bit0); the switch that drives it is `high_beam`, which is in the group",
  low_beam_lamp: "a lamp OUTPUT (b2 bit1)",
  cruise_active: "a vehicle STATE — cruise armed — which the registry argues at its entry",
  key_on: "a vehicle state that holds for a whole ride",
  moving: "a vehicle state",
  front_brake_pressure_bar: "a measurement in bar; a number belongs in a number tile",
};

const failures: string[] = [];
const defined = new Map(SIGNALS.map(signal => [signal.key, signal]));
const groupMembers = SIGNALS.filter(signal => signal.group === BUTTON_GROUP);

// 1. The set names real signals, and names them for a reason that still holds.
if (LATCHED_KEYS.size === 0) {
  failures.push(
    "public/lib/latched.js's LATCHED_KEYS is empty, so every latched signal outside the buttons group renders as a raw 1/0"
  );
}
for (const key of LATCHED_KEYS) {
  const signal = defined.get(key);
  if (!signal) {
    failures.push(
      `public/lib/latched.js names "${key}", which is not a signal in src/can/registry.ts — a rename that missed ` +
        `that file switches the latch off silently, and the symptom is a tile that never changes`
    );
    continue;
  }
  if (signal.group === BUTTON_GROUP) {
    failures.push(
      `"${key}" is in group "${BUTTON_GROUP}" AND in LATCHED_KEYS — the group already latches it, so the entry is ` +
        `redundant and the set stops being the list of exceptions it is documented as`
    );
  }
  if (signal.deadband) {
    failures.push(
      `${key} has deadband ${signal.deadband}: signals.ts logs on |change| > deadband, so a 0/1 signal with any ` +
        `deadband stops logging after its first sample and the tile has nothing to latch`
    );
  }
  // The tile shows a rejected reading as a fault rather than as a press, which only
  // works while bounds.js gates the signal — a decoder returning the masked byte
  // (`lampsAndState & 0x10` is 16, not 1) must not be able to pass for a press.
  const bounds = boundsFor(key, signal.unit, signal.group);
  if (!bounds || bounds[0] !== 0 || bounds[1] !== 1) {
    failures.push(
      `public/lib/bounds.js does not gate ${key} (group "${signal.group}", unit "${signal.unit}") to 0…1 — got ${JSON.stringify(bounds)}`
    );
  }
}

// 2. The keys that must be latched, through the real function rather than the set.
for (const [key, why] of Object.entries(MUST_LATCH)) {
  const signal = defined.get(key);
  if (!signal) {
    failures.push(`${key} is not in src/can/registry.ts at all`);
    continue;
  }
  if (!getsLatchedTile(key, signal.group)) {
    failures.push(
      `${key} would get the plain RawTile — ${why}. A press is ~30 ms, one or two frames of a 60 Hz display, so a ` +
        `raw 1/0 readout of it cannot be watched at all`
    );
  }
}

// 3. Every member of the group, which is the other half of the same rule.
for (const signal of groupMembers) {
  if (!getsLatchedTile(signal.key, signal.group)) {
    failures.push(`${signal.key} is in group "${BUTTON_GROUP}" but would not get the latched tile`);
  }
}
if (groupMembers.length === 0) {
  failures.push(`no signal is in group "${BUTTON_GROUP}", so the buttons section of the ALL page is empty`);
}

// 4. …and the keys that must not be, which is what stops the rule from widening into
//    "everything that is 0 or 1". Half the bits on 0x102 are outputs or states.
for (const [key, why] of Object.entries(MUST_NOT_LATCH)) {
  const signal = defined.get(key);
  if (!signal) {
    failures.push(`${key} is not in src/can/registry.ts at all`);
    continue;
  }
  if (getsLatchedTile(key, signal.group)) {
    failures.push(
      `${key} would get the latched button tile, which says "PRESSED", "3 presses" and "held for" — but it is ${why}`
    );
  }
}

console.log(
  `${groupMembers.length} signals in group "${BUTTON_GROUP}" plus ${LATCHED_KEYS.size} named keys ` +
    `(${[...LATCHED_KEYS].join(", ")}) get the latched tile`
);
console.log(`${Object.keys(MUST_NOT_LATCH).length} outputs, states and measurements checked to still get the raw one`);

if (failures.length > 0) {
  console.error("FAILED:");
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  process.exit(1);
}
console.log(
  `✓ every latched key is registered, deadband-free and gated to 0…1; the ${Object.keys(MUST_LATCH).length} keys ` +
    `that must latch do, and the ${Object.keys(MUST_NOT_LATCH).length} that must not do not`
);
