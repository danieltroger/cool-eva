// @ts-check

// The live pack-resistance estimate, as a van state.
//
// ⚠️ A van.state — NOT a function bindings call — for the same reason `sessionLive` in
// ./charge-write.js is one. `packResistanceWith()` returns early while a measurement is
// fresh, reading no signal at all, and a VanJS binding whose run reads nothing is
// registered to nothing and never runs again. Every consumer would otherwise have to
// arrange its own re-run out of band, which is a rule the next author has to remember
// and which one tile already got wrong: a binding on `coolant_in` does re-run, but not
// on the 20 s staleness timer that flips the provenance it was printing.
//
// The estimator itself stays van-free in ./pack-resistance.js so the check can drive it
// from Node with a stepped clock — the same split as ./flasher.js out of ./press.js.

import van from "../vendor/van-1.6.1.js";
import { observeFrame, packResistanceWith } from "./pack-resistance.js";

/** @typedef {import("./pack-resistance.js").PackResistance} PackResistance */

/** Read `.val` in a binding to react, `.rawVal` to sample without subscribing. */
export const packResistance = van.state(/** @type {PackResistance} */ ({ milliohms: 65, provenance: "assumed" }));

/**
 * Smallest change worth a repaint. The fit moves by fractions of a milliohm between
 * frames and nothing on screen shows a decimal, so publishing every one of those would
 * re-run four tiles at the pair rate for a number that renders identically.
 */
const WORTH_A_REPAINT_MOHM = 0.5;

/**
 * Offers one message's accepted readings to the estimator, then republishes if the
 * answer changed. Called for EVERY message, not only ones carrying a pair: the
 * measured→modelled expiry is a timer, so it has to be noticed by something other than
 * a new sample, and ws.ts guarantees a full snapshot every 5 s even on a parked bike.
 * @param {Record<string, import("../../src/can/signals.ts").LiveValue>} accepted
 * @param {(key: string) => number | null} read
 */
export function observeAndPublish(accepted, read) {
  observeFrame(accepted);
  const next = packResistanceWith(read);
  const shown = packResistance.rawVal;
  if (next.provenance !== shown.provenance || Math.abs(next.milliohms - shown.milliohms) >= WORTH_A_REPAINT_MOHM) {
    packResistance.val = next;
  }
}
