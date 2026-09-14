// @ts-check

// What the VCU's state machine is doing, in words, for the ALL page's two 0x101 tiles.
//
// DISPLAY ONLY. Nothing here is logged: the ride log keeps the raw bytes, the way it kept
// them when `brake` was removed for being derived. The vocabulary is copied from the tables
// in docs/can-0x101.md and scripts/check-vehicle-state-labels.ts asserts the two still agree,
// so the document leads and this file follows.
//
// No `van` import, so the check can reach it from Node — ./latched.js's reason, same split.

/** A pair the archive has produced but nobody has identified. */
export const UNLABELLED = "unlabelled";

/** A pair NEITHER corpus has ever carried, which is the event worth catching. */
export const NEVER_CAPTURED = "never captured";

/** @typedef {{ text: string, documented: boolean }} StateWords */

/** @typedef {{ state: number, substate: number }} StatePair */

/**
 * What to print under one of the two tiles that has a vocabulary, or `null` for every other
 * signal on the page.
 *
 * ⚠️ Takes the pair as a NAMED pair rather than two numbers, and owns the per-key dispatch
 * itself, because both of those were seams the view could get wrong silently: swapping the
 * two arguments turns a parked `60/62` into `62/60`, which is in neither table and renders in
 * the fault ink, and swapping which tile calls which function reads "charging" under a
 * substate. Neither is reachable from a caller now, and the check exercises this function
 * rather than the two below it.
 * @param {string} key
 * @param {StatePair} pair
 * @returns {StateWords | null}
 */
export function labelFor(key, pair) {
  if (key === STATE_KEY) {
    return stateLabel(pair.state, pair.substate);
  }
  if (key === SUBSTATE_KEY) {
    return pairLabel(pair.state, pair.substate);
  }
  return null;
}

/**
 * Whether this signal gets a label line at all.
 *
 * A named predicate rather than two key comparisons in the view — ./latched.js exports
 * `getsLatchedTile()` for the same reason, so the key names live on one side of the seam.
 * @param {string} key
 * @returns {boolean}
 */
export function hasStateVocabulary(key) {
  return key === STATE_KEY || key === SUBSTATE_KEY;
}

/**
 * The two signals this vocabulary is about.
 *
 * Named as constants so scripts/check-vehicle-state-labels.ts can assert them against
 * src/can/registry.ts — a rename that missed this file would otherwise just make the label
 * line quietly disappear, which is ./latched.js's argument for the same shape.
 */
export const STATE_KEY = "vehicle_state_can";
export const SUBSTATE_KEY = "vehicle_substate_can";

/**
 * What to print under `vehicle_substate_can`, given both halves of the pair.
 *
 * ⚠️ A substate with bit 7 set belongs to no state band, so it is looked up on the substate
 * alone: `40/150` is absent from the band table by construction. Why the ORDER of the two
 * lookups is not what matters — and how the mutation suite established that — is in
 * docs/can-0x101.md §"The vocabulary the dashboard renders".
 * @param {number} state
 * @param {number} substate
 * @returns {StateWords}
 */
function pairLabel(state, substate) {
  if (substate >= 128) {
    return words(LATCHING_SUBSTATES.get(substate));
  }
  return words(PAIR_LABELS.get(`${state}/${substate}`));
}

/**
 * What to print under `vehicle_state_can`.
 *
 * The pair's phrase where there is one, because the document gives meaning to pairs. The
 * state-level fallback exists for the one state whose own meaning has been measured: a bike
 * in `100/102` is charging even though nobody knows what substate 102 is, and printing
 * "unlabelled" over a state this repo has identified would be false modesty.
 *
 * ⚠️ The fallback does NOT cover a pair in neither table. `100/<something new>` reads
 * "never captured" on both tiles rather than "charging" on this one: a pair nothing has ever
 * logged is the louder fact, and a state phrase over it would bury exactly what the raw
 * logging exists to surface.
 * @param {number} state
 * @param {number} substate
 * @returns {StateWords}
 */
function stateLabel(state, substate) {
  const pair = pairLabel(state, substate);
  if (pair.text !== UNLABELLED) {
    return pair;
  }
  const named = STATE_LABELS.get(state);
  return named ? { text: named, documented: true } : pair;
}

/**
 * Every (state, substate) pair `0x101` has produced, and a phrase for the ones whose meaning
 * is written down — `null` where the archive has seen it and nobody has identified it.
 *
 * These 35 are the band table of docs/can-0x101.md §"What actually holds", entry for entry.
 * @type {ReadonlyMap<string, string | null>}
 */
export const PAIR_LABELS = new Map([
  ["1/2", null],
  ["1/3", null],
  ["1/6", null],
  ["1/9", null],
  ["20/20", null],
  ["20/22", null],
  ["20/23", null],
  ["20/26", null],
  ["20/28", null],
  ["20/31", null],
  ["20/32", null],
  ["20/33", null],
  ["20/34", null],
  ["40/41", "drive-enable step"],
  ["40/42", "drive-enable step"],
  ["40/43", "riding"],
  ["40/46", "drive-enable step"],
  ["40/47", "drive-enable step"],
  ["40/51", "drive-enable step"],
  ["40/52", "park assist"],
  ["40/53", "park assist"],
  ["40/59", "drive-enable step"],
  ["60/62", "parked"],
  ["60/63", "entering parked"],
  ["80/83", "blocking fault"],
  ["100/101", "AC charging"],
  ["100/102", null],
  ["100/104", "DC charging"],
  ["100/105", null],
  ["100/106", null],
  ["100/107", null],
  ["100/109", null],
  ["100/110", null],
  ["100/112", null],
  ["100/113", null],
]);

/**
 * The three substates with bit 7 set. They belong to no band — the state holds its previous
 * value while one is present, 1 748 of 1 748 archive frames — so they are looked up on the
 * substate alone. 144 has a phrase nowhere and keeps `null`.
 * @type {ReadonlyMap<number, string | null>}
 */
export const LATCHING_SUBSTATES = new Map([
  [143, "drive-enable step"],
  [144, null],
  [150, "drive-enable step"],
]);

/**
 * States whose OWN meaning is measured, for `stateLabel()`'s fallback. One so far.
 * @type {ReadonlyMap<number, string>}
 */
export const STATE_LABELS = new Map([[100, "charging"]]);

/**
 * One map lookup turned into the two facts the tile needs. Takes the looked-up value rather
 * than the map and the key, so the two callers keep their own key types.
 * @param {string | null | undefined} phrase
 * @returns {StateWords}
 */
function words(phrase) {
  if (phrase === undefined) {
    return { text: NEVER_CAPTURED, documented: false };
  }
  return { text: phrase ?? UNLABELLED, documented: true };
}
