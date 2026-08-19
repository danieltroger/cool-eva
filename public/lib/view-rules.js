// @ts-check

// When the bike gets to choose the screen instead of you.
//
// Its own module with no runtime imports, like ./charge-mode.js — the type below is a
// JSDoc-only import that the browser never sees — so the rules can be replayed a state
// at a time in scripts/check-connection.ts §8. They used to live inline in app.js's
// autoFocus(), where the only way to exercise them was to ride the bike.
//
// ## Edge-triggered, and why that needs a link
//
// "The moment charging starts", not "while charging": a rule that keeps forcing the
// view fights the rider, so once it has moved you, you can move back and it stays put
// until the condition next changes.
//
// That is also what makes these rules sensitive to the dashboard losing its link, in a
// way that a continuous rule would not be. `charging` is answered by charge-mode.js
// from freshness as much as from values, and store.js's isStale() reports EVERY signal
// stale while no messages are arriving — correctly, because nothing on the page is
// being refreshed then. But "the bike stopped telling us it is charging" is not the
// same event as "the bike stopped charging", and on a DC fast charge the two are
// indistinguishable from values alone: the BMS reports Idle for the whole session, so
// the contactor bit's freshness is the only evidence there is (see charge-mode.js).
//
// Left to itself the pair would therefore fire twice on every dropout — off the Charge
// tab when the link went, back onto it when the link returned — with a history entry
// for each, so Back would walk through two moves the rider never made. Once per screen
// lock, at a charger, which is exactly where the phone gets picked up. So: no link, no
// news about the bike, and the edges are held rather than fired.

/** @typedef {import("./router.js").TabName} TabName */

/**
 * What the dashboard knows about the bike this instant.
 * @typedef {object} BikeState
 * @property {boolean} linkIsLive whether messages are arriving at all
 * @property {boolean} charging chargeMode() !== "none"
 * @property {boolean} critical near-empty on SOC or on the weakest cell's headroom
 * @property {boolean} heardFromBike whether the bike has said anything yet at all
 */

/**
 * What the rules remember between calls. Mutated in place — a shared context object,
 * per CLAUDE.md — because these are edges and the previous value IS the state.
 * @typedef {object} ViewRuleMemory
 * @property {boolean} honourUrlTab the one pass a URL that named a tab gets; see below
 * @property {boolean} wasCharging
 * @property {boolean} wasCritical
 */

/**
 * The tabs to move to, in order. Usually none.
 *
 * A list rather than one tab because two rules can fire in the same instant — leaving a
 * charger with the pack near empty is "back to Ride" and then "into Hypermile" — and
 * that was two moves before this was a function, so it stays two moves now.
 *
 * @param {ViewRuleMemory} memory
 * @param {BikeState} bike
 * @param {TabName} showing which tab the rider is looking at
 * @returns {TabName[]}
 */
export function viewRules(memory, bike, showing) {
  if (!bike.linkIsLive) {
    // News about the phone, not about the bike. Returning WITHOUT touching the two
    // remembered values is the whole point: it holds every edge across the gap, so the
    // link coming back is not itself an event. See the header.
    return [];
  }

  if (memory.honourUrlTab) {
    memory.wasCharging = bike.charging;
    memory.wasCritical = bike.critical;
    // Held until the bike has said something. Before the first BMS message every
    // reading is "no", which is the absence of a state rather than a state to seed
    // from — seed on that and the pass is spent before it was ever needed.
    memory.honourUrlTab = !bike.heardFromBike;
    return [];
  }

  /** @type {TabName[]} */
  const moves = [];

  if (bike.charging && !memory.wasCharging) {
    moves.push("charge");
  }
  // Leaving the charger takes you back to the riding screen, but only if you are still
  // looking at the one it moved you to.
  if (!bike.charging && memory.wasCharging && showing === "charge") {
    moves.push("ride");
  }
  memory.wasCharging = bike.charging;

  if (bike.critical && !memory.wasCritical && !bike.charging) {
    moves.push("hypermile");
  }
  memory.wasCritical = bike.critical;

  return moves;
}
