// @ts-check
// ETA model and qualifications: docs/charge-eta.md and docs/charge-dashboard.md.
import van from "../vendor/van-1.6.1.js";
import { chartTick, isStaleSampled, peek } from "../lib/store.js";
import { currentChargeMode } from "../lib/charge-display.js";
import { freshValue, readingStatus } from "../lib/reading-status.js";
import { monotonicNow } from "../lib/clock.js";
import { chargeEta, smoothedChargeKw } from "../lib/charge-eta.js";
import { GOOD, MUTED, WATCH } from "../lib/colors.js";

const { div, span } = van.tags;
export const SOC_MAX_AGE_MS = 12_000;

export function ChargeEtaTile() {
  return div(
    { class: "tile layout-card layout-between charge-eta" },
    span({ class: "charge-label" }, "Time to saved limit"),
    () => {
      chartTick.val;
      const limit = freshValue("charge_soc_limit_pct", true);
      const active = currentChargeMode(true) !== "none";
      const ready =
        active &&
        limit !== null &&
        limit > 0 &&
        !isStaleSampled("soc", SOC_MAX_AGE_MS) &&
        peek("soc") !== null &&
        readingStatus("soc", true) !== "fault" &&
        readingStatus("pack_kw", true) === "fresh" &&
        (freshValue("pack_kw", true) ?? 0) > 0;
      const estimate = ready
        ? chargeEta({ socPct: peek("soc"), targetPct: limit, kw: smoothedChargeKw(monotonicNow()) })
        : null;
      if (!estimate || estimate.kind === "none") {
        return div(
          { class: "value charge-eta-unavailable", "data-charge-eta": "", style: `color:${MUTED}` },
          "Unavailable"
        );
      }
      return div(
        { class: "value", "data-charge-eta": "", style: `color:${estimate.kind === "bound" ? WATCH : GOOD}` },
        durationOf(estimate.minutes),
        span({ class: "unit" }, estimate.kind === "bound" ? "min · not before" : "min · estimated")
      );
    }
  );
}
/** @param {number} minutes */
function durationOf(minutes) {
  const rounded = Math.round(minutes);
  const hours = Math.floor(rounded / 60);
  return hours === 0 ? String(rounded) : `${hours} h ${String(rounded % 60).padStart(2, "0")}`;
}
