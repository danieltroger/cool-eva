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
  // The three switches added 2026-09-14. `horn_switch` is the thumb behind `horn` above;
  // the two indicator switches are 0.2 s presses (median 0.210 s and 0.180 s over 464 and
  // 361 archive presses), which is two frames of a 60 Hz display.
  horn_switch: "0x102 b1 bit0 V_HORN_SW — the thumb behind the horn output above",
  blinker_switch_left: "0x102 b0 bit4 V_L_TURN_SW — a 0.18 s median press",
  blinker_switch_right: "0x102 b0 bit3 V_R_TURN_SW — a 0.21 s median press",
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
  // ⚠️ The SWITCH, and the one member of this pair that could plausibly have gone the other
  // way — `high_beam` is a switch and IS latched. The difference is use, not kind: a
  // flash-to-pass is momentary, and a low beam is on for the whole ride, so "PRESSED",
  // "3 presses" and "held for 4 h" would all be wrong about it. Same argument as `key_on`.
  low_beam_switch: "a switch that is HELD for an entire ride (b0 bit7), not pressed — set in 38.8 % of archive frames",
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

// 5. 🚨 THE RATCHET. A signal with a blank unit in a group that is not a BOOLEAN_GROUP, and no
//    BY_KEY entry, reaches no rule in bounds.js at all: boundsFor() returns null and the tile
//    renders whatever arrives. That is how `moving` and `rolling_backwards` — two 0/1 flags — sat
//    ungated on this page from June until 2026-09-14, with nothing red, because every other
//    guard in this repo walks the signals that ARE gated.
//
//    ⚠️ The list below is NOT a blessing. It is a ratchet: these are what was ungated the day it
//    was written, and this fails when the next one appears. The three this paragraph used to name
//    as obviously wrong are all gated now — `speed_can_kmh` by #230, `vehicle_state` and
//    `vehicle_substate` by #227 — and what is left wants a judgement about a physical range
//    rather than a line. docs/dashboard-decisions.md §"The ungated signals" has the list and the why.
const KNOWN_UNGATED = new Set([
  // Flag WORDS and raw state bytes, where a 0/1 or numeric bound would reject the real value.
  "bms_error_flags",
  "bms_warning_flags",
  "lmu_comm_warnings",
  "bms_io_state",
  "iso_test_1",
  "iso_test_2",
  "iso_test_total",
  "bms_post_processor_1",
  "clamp_gate",
  "clamp_amount",
  "lmu_cell_mux",
  "vcu_flags_low",
  "vcu_flags_high",
  // Indices and counts into a structure whose size is the real bound.
  "lmu_temp_high_idx",
  "lmu_temp_low_idx",
  "cell_lowest_v_idx",
  "cell_highest_v_idx",
  "cells_connected",
  "keys_paired",
  "gps_satellites",
  "gps_fix",
  "key_fob_id",
  // Monotonic counters and odometers: any ceiling is arbitrary, and the counter that outgrew it
  // would be drawn as a dead sensor on a working bike — bounds.js says exactly this of waypoint_seq.
  "waypoint_seq",
  "waypoint_refused_seq",
  "odometer_km",
  "trip_km",
  "odometer_can_km",
  "dist_since_clear_km",
  "dist_with_mil_km",
  "time_with_mil_min",
  "time_since_clear_min",
  "bms_uptime_min",
  "gps_epoch_s",
  // ⚠️ These are the ones a future change should FIX rather than inherit. The fifteen
  // `bms_state_*` / `bms_err_*` / `bms_warn_*` flags and the three single-byte state words
  // that stood here are gone — #227 gated them; scripts/check-flag-bounds.ts is what holds
  // them. What is left wants a judgement about a physical range rather than a line.
  "charger_enabled",
  "bms_remaining_energy_raw",
  "remaining_ah",
  "bms_remaining_energy_wh",
  "inst_consumption_wh",
  "avg_consumption_wh_km",
]);
const ungated = SIGNALS.filter(signal => boundsFor(signal.key, signal.unit, signal.group) === null);
for (const signal of ungated) {
  if (!KNOWN_UNGATED.has(signal.key)) {
    failures.push(
      `${signal.key} (group "${signal.group}", unit "${signal.unit}") reaches no rule in public/lib/bounds.js, so ` +
        `boundsFor() returns null and the ALL page renders whatever arrives — the combination that left moving ` +
        `and rolling_backwards ungated for three months. Give it a BY_KEY entry, or a group whose rule covers it, or ` +
        `add it to KNOWN_UNGATED here with the reason`
    );
  }
}
// 🚨 …and the other direction, which is the arm that matters more. A stale entry means the list
//    has stopped describing the registry and the next reader trusts it. ⚠️ This asked "is it
//    still a signal?" when it was written, which CANNOT see the commoner rot: an entry someone
//    has since FIXED by giving it a bound stays on the list for ever, and the prose beside it
//    keeps offering a two-line fix for a thing already fixed. It shipped that way — #230 gated
//    `speed_can_kmh` and `motor_rpm_can` while this branch was in review and the list went on
//    naming them. Comparing against `ungated` catches both rots and is shorter.
const ungatedKeys = new Set(ungated.map(signal => signal.key));
for (const key of KNOWN_UNGATED) {
  if (ungatedKeys.has(key)) continue;
  failures.push(
    defined.has(key)
      ? `KNOWN_UNGATED still names "${key}", which public/lib/bounds.js now gates — delete the line, and any prose that calls it ungated`
      : `KNOWN_UNGATED names "${key}", which is no longer a signal in src/can/registry.ts`
  );
}
console.log(`${ungated.length} of ${SIGNALS.length} signals reach no bound in bounds.js; all are on the known list`);

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
