// @ts-check

// Which signals are driven by the turn-signal flasher, and how long its off phase is.
//
// Two constants and no logic, in their own file for the same reason ./gestures.js is
// split from ./handlebar-gestures.js: ./press.js imports `van`, which needs a DOM, so
// nothing in it can be reached from Node — and these two constants are exactly the kind
// that has to be checkable from Node. `FLASHER_KEYS` names registry keys by string, and
// a rename that missed this file would switch the coalescing off silently and inflate
// the blinker count 5.8× with every test still green. scripts/check-button-decode.ts
// imports what is below and asserts both names are real, registered, and in the group
// whose tiles use them.
//
// ## Why the flasher needs naming at all
//
// `blinker_left` / `blinker_right` are 0x102 b2 bits 2/3, and they are the LAMP OUTPUTS
// rather than the switches — so while an indicator runs, they toggle. Measured off this
// bike's own ride log (`rides.db`, Apr–Aug 2026), the blink is **333 ms on, 349 ms off**,
// i.e. 1.46 Hz. Every one of those is a real rising edge on the wire, so anything
// counting edges gets an answer that is wrong by a factor rather than by a little:
//
//   blinker_left    1881 rising edges  →   323 actual uses   (5.8× over)
//   blinker_right   2693 rising edges  →   436 actual uses   (6.2× over)
//
// The rest of the bike's 1/0 signals are pressed and released by a person, and for those
// a 0 means what it says. These two are the exception, and it is a hardware fact about
// this vehicle rather than a display preference — which is why it is stated as data here
// and consumed as a rule in ./press.js.

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
 * 700 ms sits in an empty valley, and the distribution really is two humps with almost
 * nothing between them. Of the 1875 gaps between `blinker_left` flashes in `rides.db`:
 *
 *   ≤ 400 ms   1556   the relay's own off phase
 *   0.4-1.5 s     8   ← the valley the threshold has to land in
 *   1.5-3 s       9
 *   > 3 s       302   the rider genuinely finished and signalled again later
 *
 * So anywhere from 0.4 s to 1.5 s classifies all but eight of them identically; 700 ms
 * is the middle of that. The eight are the cost, and they are ambiguous by nature — a
 * cancel-and-immediately-re-signal is not distinguishable from a dropped blink.
 *
 * ⚠️ This number happens to equal ./gestures.js's DOUBLE_CLICK_WINDOW_MS, and the
 * coincidence is a warning rather than a shared constant. That file uses 700 ms to say
 * "two presses this close are one gesture"; this one uses it to say "a gap this short
 * was never a release". Applied to `btn_cruise_set` the rule here would erase the second
 * click the tab gesture is built on, and applied to `high_beam` it would collapse the
 * three-flash gesture in ../app.js to one press. Hence the set above is closed.
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
