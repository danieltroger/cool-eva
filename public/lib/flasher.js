// @ts-check

// Which signals are driven by the turn-signal flasher, and how long its off phase is.
//
// `blinker_left` / `blinker_right` are 0x102 b2 bits 2/3 and are the LAMP OUTPUTS rather
// than the switches, so a running indicator toggles them at 1.46 Hz. Anything counting
// edges is therefore over by a factor — 5.8× and 6.2× against the actual signalled turns
// in `rides.db`. A hardware fact about this vehicle rather than a display preference,
// which is why it is stated as data here and consumed as a rule in ./press.js.
//
// Two constants and no logic, in their own file because ./press.js imports `van` and so
// cannot be reached from Node: a rename that missed this file would switch the
// coalescing off silently with every test still green, so scripts/check-button-decode.ts
// imports these and asserts both names are real, registered, and in the right group.
// Blink measurement and gap histogram: docs/dashboard-decisions.md
// §"a flasher is not a finger".

/**
 * Signals whose 0 phase belongs to a relay rather than to the rider.
 *
 * Only the two blinker lamps. ⚠️ Do NOT add a `btn_` key: two of this dashboard's own
 * inputs are gestures that a coalescing rule would eat — see FLASHER_GAP_MS below.
 * @type {ReadonlySet<string>}
 */
export const FLASHER_KEYS = new Set(["blinker_left", "blinker_right"]);

/**
 * How long a flasher signal has to stay at 0 before a reader believes the rider
 * cancelled rather than the relay opening.
 *
 * 700 ms sits in an empty valley: of the 1875 gaps between `blinker_left` flashes in
 * `rides.db`, 1556 are ≤ 400 ms and 302 are > 3 s, leaving 17 in between — and only
 * **eight** of those fall in the 0.4-1.5 s window a threshold has to land in. Anywhere from
 * 0.4 s to 1.5 s classifies all but those eight identically, and they are ambiguous by
 * nature. Full histogram: docs/dashboard-decisions.md §"a flasher is not a finger".
 *
 * ⚠️ This number happens to equal ./gestures.js's DOUBLE_CLICK_WINDOW_MS, and the
 * coincidence is a warning rather than a shared constant — that file uses 700 ms to
 * coalesce two presses into one gesture, this one to say a gap was never a release.
 * Applied to `btn_cruise_set` it would erase the second click the tab gesture is built
 * on. Hence the set above is closed to the two lamps and no `btn_` key may join it.
 */
export const FLASHER_GAP_MS = 700;

/**
 * Whether this signal is driven by the flasher, which changes both how a 0 is read and
 * what a reader should call it — nobody "presses" a turn signal for eight seconds.
 * @param {string} key
 * @returns {boolean}
 */
export function isFlasher(key) {
  return FLASHER_KEYS.has(key);
}
