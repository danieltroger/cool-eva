// @ts-check
// ETA qualifications and preserved evidence: docs/charge-eta.md and docs/charge-dashboard.md.
import van from "../vendor/van-1.6.1.js";
import { chartTick, isStaleSampled, peek } from "../lib/store.js";
import { chargeValue, currentChargeMode } from "../lib/charge-display.js";
import { readingStatus, statusWord } from "../lib/reading-status.js";
import { monotonicNow } from "../lib/clock.js";
import { chargeEta, smoothedChargeKw } from "../lib/charge-eta.js";
import { GOOD, MUTED, WATCH } from "../lib/colors.js";
const { div } = van.tags;
export const SOC_MAX_AGE_MS = 12_000;

export function ChargeEtaTile() {
  return div({ class: "tile charge-eta" }, () => {
    chartTick.val;
    const limit = chargeValue("charge_soc_limit_pct", true);
    const target = limit === 0 ? 100 : limit;
    const label =
      target === null
        ? "Estimated arrival · target unknown"
        : limit === 0
          ? "Estimated full · no saved limit"
          : `Estimated arrival · bike’s ${target}% limit`;
    let reason = "Waiting for charge power";
    const active = currentChargeMode(true) !== "none";
    const powerState = readingStatus("pack_kw", true);
    const incoming = chargeValue("pack_kw", true);
    const soc = peek("soc");
    if (!active) {
      reason = "Charge not established";
    } else if (target === null) {
      reason = `Saved limit ${statusWord(readingStatus("charge_soc_limit_pct", true), "not read")}`;
    } else if (isStaleSampled("soc", SOC_MAX_AGE_MS) || readingStatus("soc", true) === "fault") {
      reason = `Charge level ${statusWord(readingStatus("soc", true), "unavailable")}`;
    } else if (powerState !== "fresh") {
      reason = `Power ${statusWord(powerState)}`;
    } else if (incoming !== null && incoming < 0) {
      reason = "Power out; no arrival inferred";
    } else {
      const estimate = chargeEta({ socPct: soc, targetPct: target, kw: smoothedChargeKw(monotonicNow()) });
      if (estimate.kind === "none" && estimate.why === "already there") {
        reason = "Target reached; stop not established";
      }
      if (estimate.kind !== "none") {
        const bound = estimate.kind === "bound";
        return div(
          { class: "charge-eta-content" },
          div({ class: "label" }, label),
          div(
            { class: "charge-eta-row" },
            div(
              { class: "value", "data-charge-eta": "", style: `color:${bound ? WATCH : GOOD}` },
              clockOf(estimate.minutes)
            ),
            div(
              { class: "sub" },
              `${bound ? "Not before" : "In"} ${durationOf(estimate.minutes)}${bound ? " · taper is uncertain" : " · estimated"}`
            )
          )
        );
      }
    }
    return div(
      { class: "charge-eta-content" },
      div({ class: "label" }, label),
      div(
        { class: "charge-eta-row" },
        div({ class: "value", "data-charge-eta": "", style: `color:${MUTED}` }, "—"),
        div({ class: "sub" }, reason)
      )
    );
  });
}
/** @param {number} minutes */
function clockOf(minutes) {
  const at = new Date(Date.now() + minutes * 60_000);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}
/** @param {number} minutes */
function durationOf(minutes) {
  const rounded = Math.round(minutes),
    hours = Math.floor(rounded / 60);
  return hours === 0 ? `${rounded}m` : `${hours}h ${String(rounded % 60).padStart(2, "0")}m`;
}
