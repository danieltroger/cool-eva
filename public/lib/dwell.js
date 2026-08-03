// @ts-check

import { peek } from "./store.js";

// The under-voltage dwell timer.
//
// The BMS does not cut discharge the moment a cell dips below the cut-off — its
// `DischargeModeUnderVoltageCutOffTimer` is 60 s, and the minimum cell has to stay
// under for that whole minute before the contactors open. That single fact is the
// difference between a useful display and one that panics: a hard pull drags the
// weakest cell under the floor routinely, and a naive alarm would fire on every
// overtake.
//
// So instead of a threshold light, this tracks the timer itself — filling while
// under, draining while above — and the view shows how much of the minute is used.
// "You have 40 seconds of this left" is something a rider can act on.
//
// The drain is symmetric with the fill because the BMS's own reset behaviour is not
// documented in the config and has never been observed on this bike (no capture has
// ever come near the floor). Symmetric is the middle assumption: an instant reset
// would understate a cell bouncing in and out of the cut-off, and no drain at all
// would leave the bar stuck full after a single dip.

/** Seconds the minimum cell must stay below cut-off before discharge is cut. */
export const CUTOFF_TIMER_S = 60;

let underSeconds = 0;
let lastUpdateMs = 0;

/**
 * Advance the timer. Call on a regular tick; it uses wall-clock deltas, so an
 * irregular or throttled interval stays correct.
 * @param {number} nowMs
 */
export function updateDwell(nowMs) {
  const elapsedS = lastUpdateMs === 0 ? 0 : (nowMs - lastUpdateMs) / 1000;
  lastUpdateMs = nowMs;

  const minimum = peek("cell_min_mv");
  const cutoff = peek("cell_cutoff_mv");
  if (minimum == null || cutoff == null) {
    return;
  }
  // A tab that was backgrounded for a minute must not credit the whole minute to
  // the timer in one step — we have no idea what the cell did while we weren't
  // looking, and inventing a full cut-out is worse than under-reporting.
  const step = Math.min(elapsedS, 2);
  underSeconds = minimum < cutoff ? Math.min(CUTOFF_TIMER_S, underSeconds + step) : Math.max(0, underSeconds - step);
}

/** Seconds accumulated below the cut-off, 0…CUTOFF_TIMER_S. */
export function dwellSeconds() {
  return underSeconds;
}

/** Seconds of continued abuse before the BMS would open the contactors. */
export function secondsRemaining() {
  return CUTOFF_TIMER_S - underSeconds;
}
