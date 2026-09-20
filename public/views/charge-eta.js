// @ts-check

import van from "../vendor/van-1.6.1.js";
import { GOOD, MUTED, WATCH } from "../lib/colors.js";
import { chartTick, isStale, isStaleSampled, valueOf } from "../lib/store.js";
import { chargeMode } from "../lib/charge-mode.js";
import { monotonicNow } from "../lib/clock.js";
import { BOUND_AT_OR_ABOVE, chargeEta, smoothedChargeKw } from "../lib/charge-eta.js";

const { div } = van.tags;

/**
 * Whether the bike is charging at all, as a STATE.
 *
 * ⚠️ A `van.derive`, the way `charge.js` wraps the same call, because `chargeMode` reads `isStale`
 * and `isStale` subscribes to `serverTime` — which `apply()` writes on every message. Calling it
 * inside the tile's own binding paced the tile at the full message rate and rebuilt its DOM node
 * ~10 Hz on a charging bike. Cheap per tick: a handful of Map lookups.
 */
const charging = van.derive(() => chargeMode(valueOf, isStale) !== "none");

// When the charge gets there. Reads `soc`, `charge_soc_limit_pct` and a smoothed `pack_kw` — all
// already on the wire — so there is nothing new on the Pi for this. The arithmetic and every
// measured constant are in ../lib/charge-eta.js; the tables behind them are docs/charge-eta.md.
//
// ⚠️ Read-only. It renders on any phone, writes enabled or not, because it commands nothing.

/** The target when the bike is explicitly set to no limit: it charges to full. */
const FULL = 100;

/**
 * How old `soc` may be before there is nothing to project from.
 *
 * ⚠️ 12 s, NOT the Pi's `SOC_MAX_AGE_MS` of 5 s, and this is the same borrowed-constant error the
 * boundary made before it: the Pi refreshes `LiveValue.ts` on every arrival, so 5 s there is a
 * hundredfold margin — but the browser learns an age only from a `soc` CHANGE, which on a trickle
 * is minutes apart, or from ws.ts's 5 s snapshot heartbeat. Against a 5 s threshold that sawtooths
 * to 5049 ms and the tile blinks out on every late heartbeat. `charge-mode.js`'s
 * CONTACTOR_LIVE_MS and `charge-write.js`'s CHARGE_SESSION_MAX_AGE_MS are both 12 s for exactly
 * this, and this is the third file to need it.
 */
export const SOC_MAX_AGE_MS = 12_000;

/**
 * The ETA tile, or an empty node when there is nothing honest to say.
 *
 * ⚠️ The binding depends on `chartTick` deliberately — the clock time it prints moves with the
 * wall clock and nothing arrives to mark that. Everything else it needs is either a plain signal
 * state or SAMPLED (`isStaleSampled`, the ring), so the tick is what paces it and not the ~10 Hz
 * message rate. `charging` above is a derive for the same reason.
 */
export function ChargeEtaTile() {
  return div(() => {
    chartTick.val;
    // ⚠️ A CHARGE HAS TO BE LIVE. Without this the tile renders off any positive `pack_kw`: the
    // preview's parked fixture carries exactly 0.1 kW and produced "FULL · not before 79h 48m"
    // under "plug in to see delivery", and regen puts a ride above the floor in 3.1 % of minute
    // windows. `chargeMode` is the same predicate the delivery tile above uses, so the two cannot
    // disagree about whether the bike is charging.
    if (charging.val === false) {
      return div();
    }
    const socPct = valueOf("soc");
    // ⚠️ SAMPLED, not subscribed: `isStale` reads serverTime, which apply() writes on EVERY
    // message, so calling it here would pace this whole binding at ~10 Hz mid-charge. The tick
    // above is what paces it. Same reason app.js uses isStaleSampled throughout updateDwell.
    if (isStaleSampled("soc", SOC_MAX_AGE_MS)) {
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
            // Not a hedge on a number that is roughly right: predicted/actual drops 0.92 → 0.78 on
            // AC between target 99 and 100, so a point estimate here would be wrong rather than
            // imprecise. Every target up to 99 gets a real time. docs/charge-eta.md.
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
