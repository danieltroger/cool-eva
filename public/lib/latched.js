// @ts-check

// Which signals get the latched button tile on the ALL page, and which get the plain 1/0.
//
// The rule the tile encodes: a signal whose EDGES are the event worth seeing gets latched,
// counted and timed; a signal whose VALUE is the thing worth reading gets a number. The
// shortest press measured on this bike is 30 ms — under two frames of a 60 Hz display — so
// the raw bit of a horn or a mode button cannot be watched at all, which is what
// ./press.js exists to fix. A lamp output or a vehicle state has no such problem.
//
// Two ways in, and the second is why this file exists. The registry group `buttons` is
// one. The per-key set below is the other, for signals that belong to another group for
// reasons that have nothing to do with the dashboard: db.ts writes the `signal` table with
// ON CONFLICT(key) DO NOTHING, so rides.db keeps the group a key was FIRST seen under for
// ever, and grafana/dashboards/explore.json reads `signal.grp`. Moving a key's group to
// change its tile spends the history's grouping permanently; naming the key here is free.
//
// ⚠️ "Latched" is about the TILE, not about the signal's shape. It is deliberately not
// "momentary", which in ./press.js means the opposite of held — a distinction this file
// must not be read as making, since `high_beam` sits in the group and has been held for
// 67.9 s. Reasoning and corpus: docs/dashboard-decisions.md §"Momentary buttons on a
// phone screen". No `van` import, so scripts/check-all-view-tiles.ts can reach this from
// Node — the same reason ./flasher.js is split out of ./press.js.

/** The registry group whose signals all get this treatment. Set in src/can/registry.ts. */
export const BUTTON_GROUP = "buttons";

/**
 * Signals OUTSIDE `BUTTON_GROUP` that still get the latched tile.
 *
 * `horn` (0x102 b2 0x10) and `ignition_button` (b1 bit6, the red button on the right bar)
 * are both worked by a thumb and both log in `controls`, where they have been since June.
 * ⚠️ Nothing may go in here that a person does not operate: the tile says "PRESSED",
 * "3 presses" and "held for", and those words have to stay true. The beam lamps are
 * outputs rather than switches (`high_beam` is the switch and is already in the group),
 * and `cruise_active` is a vehicle state. An ABS intervention is the honest boundary case
 * — as brief as a press and just as invisible, but nobody presses one, so adding it is a
 * decision about the tile's wording rather than about this mechanism (src/can/abs.ts).
 * @type {ReadonlySet<string>}
 */
export const LATCHED_KEYS = new Set(["horn", "ignition_button"]);

/**
 * Whether this signal's tile should latch, count and time its edges rather than print its
 * value.
 * @param {string} key
 * @param {string} group The key's registry group. Passed in rather than looked up, because
 * `groupOf()` lives in ./store.js, which imports `van` and cannot be reached from Node.
 * @returns {boolean}
 */
export function getsLatchedTile(key, group) {
  return group === BUTTON_GROUP || LATCHED_KEYS.has(key);
}
