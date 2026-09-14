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

/**
 * What to print under `vehicle_substate_can`, given both halves of the pair.
 *
 * ⚠️ A substate with bit 7 set belongs to no state band at all — the state latches at its
 * previous value while it is present — so `40/150` is absent from the band table by
 * construction and a lookup that consulted only the pairs would call every start-up step
 * uncaptured. Consulting LATCHING_SUBSTATES is what matters, not the order: the pair table
 * cannot contain a bit-7 key (the check asserts it against the band table), so a pairs-first
 * version that fell through here would behave identically. The mutation suite found that out
 * by proposing the reordering and having it survive.
 * @param {number} state
 * @param {number} substate
 * @returns {StateWords}
 */
export function pairLabel(state, substate) {
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
 * @param {number} state
 * @param {number} substate
 * @returns {StateWords}
 */
export function stateLabel(state, substate) {
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
