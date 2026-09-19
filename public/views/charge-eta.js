// @ts-check

import van from "../vendor/van-1.6.1.js";
import { GOOD, MUTED, WATCH } from "../lib/colors.js";
import { chartTick, peek, valueOf } from "../lib/store.js";
import { monotonicNow } from "../lib/clock.js";
import { BOUND_AT_OR_ABOVE, chargeEta, smoothedChargeKw } from "../lib/charge-eta.js";

const { div } = van.tags;

// When the charge gets there. Reads `soc`, `charge_soc_limit_pct` and a smoothed `pack_kw` — all
// already on the wire — so there is nothing new on the Pi for this. The arithmetic and every
// measured constant are in ../lib/charge-eta.js; the tables behind them are docs/charge-eta.md.
//
// ⚠️ Read-only. It renders on any phone, writes enabled or not, because it commands nothing.

/** The target when no limit is set: the bike charges to full. */
const FULL = 100;

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
    const socPct = valueOf("soc");
    const limitPct = valueOf("charge_soc_limit_pct");
    // 0 means "no limit" and an absent reading means "nobody has asked"; both charge to full.
    const targetPct = limitPct === null || limitPct === 0 ? FULL : limitPct;
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
