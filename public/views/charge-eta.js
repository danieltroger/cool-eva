// @ts-check

import van from "../vendor/van-1.6.1.js";
import { GOOD, MUTED, WATCH } from "../lib/colors.js";
import { chartTick, isStale, valueOf } from "../lib/store.js";
import { chargeMode } from "../lib/charge-mode.js";
import { monotonicNow } from "../lib/clock.js";
import { BOUND_AT_OR_ABOVE, chargeEta, smoothedChargeKw } from "../lib/charge-eta.js";

const { div } = van.tags;

// When the charge gets there. Reads `soc`, `charge_soc_limit_pct` and a smoothed `pack_kw` — all
// already on the wire — so there is nothing new on the Pi for this. The arithmetic and every
// measured constant are in ../lib/charge-eta.js; the tables behind them are docs/charge-eta.md.
//
// ⚠️ Read-only. It renders on any phone, writes enabled or not, because it commands nothing.

/** The target when the bike is explicitly set to no limit: it charges to full. */
const FULL = 100;

/**
 * How old `soc` may be before there is nothing to project from. The same 5 s the Pi's own
 * `SOC_MAX_AGE_MS` uses, and for the same reason: it rides a 20 Hz frame, so this means the BMS
 * has gone quiet rather than that the value is merely old.
 */
const SOC_MAX_AGE_MS = 5_000;

/**
 * The ETA tile, or an empty node when there is nothing honest to say.
 *
 * ⚠️ The binding depends on `chartTick` deliberately — the clock time it prints moves with the
 * wall clock and nothing arrives to mark that. `pack_kw` is SAMPLED through `peek`/the ring rather
 * than subscribed, so the tile is paced by the tick and not by the message rate.
 */
export function ChargeEtaTile() {
  return div(() => {
    chartTick.val;
    // ⚠️ A CHARGE HAS TO BE LIVE. Without this the tile renders off any positive `pack_kw`: the
    // preview's parked fixture carries exactly 0.1 kW and produced "FULL · not before 79h 48m"
    // under "plug in to see delivery", and regen puts a ride above the floor in 3.1 % of minute
    // windows. `chargeMode` is the same predicate the delivery tile above uses, so the two cannot
    // disagree about whether the bike is charging.
    if (chargeMode(valueOf, isStale) === "none") {
      return div();
    }
    const socPct = valueOf("soc");
    // ⚠️ A stale `soc` is not a slow one — 0x200 is 20 Hz, so this means the BMS went quiet.
    if (isStale("soc", SOC_MAX_AGE_MS)) {
      return div();
    }
    const limitPct = valueOf("charge_soc_limit_pct");
    // ⚠️ ABSENT IS NOT "NO LIMIT". Nothing rebroadcasts this signal, so a value we have not seen
    // means "not asked and not touched" — docs/dash-command-0x2c-charge-limit.md says exactly that.
    // Reading null as 100 made "not before 29m" the DEFAULT render on a fresh page load, on a bike
    // that was in fact going to stop at 90 in 21 minutes. Only an explicit 0 means no limit.
    if (limitPct === null) {
      return div();
    }
    const targetPct = limitPct === 0 ? FULL : limitPct;
    const eta = chargeEta({ socPct, targetPct, kw: smoothedChargeKw(monotonicNow()) });
    if (eta.kind === "none") {
      return div();
    }
    const bound = eta.kind === "bound";
    return div(
      { class: "tile span2" },
      div({ class: "label" }, bound ? "Full" : `To ${targetPct} %`),
      div({ class: "value", style: `color:${bound ? WATCH : GOOD}` }, clockOf(eta.minutes)),
      div({ class: "sub", style: `color:${MUTED}` }, `${bound ? "not before" : "in"} ${durationOf(eta.minutes)}`),
      bound
        ? div(
            { class: "action-note", style: `color:${MUTED}` },
            // Not a hedge on a number that is roughly right: the last point alone measures 3.4-76.9
            // minutes on AC against 4-11 normally, so a point estimate here would be wrong, not
            // imprecise. Every target up to 99 gets a real time.
            "The pack's own taper takes the last point, and how long that takes is not predictable from here."
          )
        : div()
    );
  });
}

/**
 * The wall-clock time `minutes` from now, as HH:MM in the phone's own timezone — which is why this
 * arithmetic is in the browser and not on a Pi that steps its own clock.
 * @param {number} minutes
 */
function clockOf(minutes) {
  const at = new Date(Date.now() + minutes * 60_000);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

/**
 * `4h 20m`, or `20m` under the hour. Rounded to the minute: the inputs do not support seconds and
 * printing them would claim a precision the 190 Wh figure does not have.
 * @param {number} minutes
 */
function durationOf(minutes) {
  const whole = Math.round(minutes);
  const hours = Math.floor(whole / 60);
  return hours === 0 ? `${whole}m` : `${hours}h ${String(whole % 60).padStart(2, "0")}m`;
}
