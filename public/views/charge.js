// @ts-check
// Overview budget, delivery direction and observed temperature graph: docs/charge-dashboard.md.
import van from "../vendor/van-1.6.1.js";
import { SubTabs } from "../lib/sub-tabs.js";
import { chargePowerDisplay, chargeValue, currentChargeMode } from "../lib/charge-display.js";
import { readingStatus, statusWord } from "../lib/reading-status.js";
import { ChargeGraph } from "./charge-graph.js";
import { ChargeEtaTile } from "./charge-eta.js";
import { ChargeStopControl } from "./charge-stop.js";
import { ChargeAutoSummary } from "./charge-auto.js";
import { showView } from "../lib/router.js";
import * as colors from "../lib/colors.js";
const { div, span, button } = van.tags;

export function ChargeView() {
  return div(
    { class: "view riding-view charge-view", "data-view": "charge" },
    SubTabs("charge"),
    ChargeHero(),
    ChargeEtaTile(),
    ChargeGraph(),
    div(
      { class: "tile charge-controller" },
      button(
        {
          class: "charge-controller-summary",
          onclick: () => showView("charge-controls"),
          "aria-label": "Charge controls and operation results",
        },
        ChargeAutoSummary()
      ),
      ChargeStopControl({ compact: true })
    )
  );
}

function ChargeHero() {
  return div(
    { class: "tile charge-hero" },
    div(
      { class: "charge-soc" },
      div({ class: "label" }, () => {
        const mode = currentChargeMode();
        return mode === "none"
          ? "Battery · not charging"
          : mode === "charging"
            ? "Battery · charge session"
            : `Battery · ${mode.toUpperCase()} session`;
      }),
      div(
        { class: "charge-soc-number", style: () => `color:${colors.stateOfCharge(chargeValue("soc"))}` },
        span({ "data-charge-soc": "" }, () => {
          const value = chargeValue("soc");
          return value === null ? statusWord(readingStatus("soc")) : String(Math.round(value));
        }),
        span({ class: "hero-unit" }, () => (chargeValue("soc") === null ? "" : "%"))
      )
    ),
    div(
      {
        class: "charge-delivery",
        "aria-label": () => {
          const shown = chargePowerDisplay();
          return `${shown.label} ${shown.magnitude} ${shown.unit}`;
        },
      },
      div(
        { class: "label", "data-charge-direction": "", style: () => `color:${chargePowerDisplay().color}` },
        () => chargePowerDisplay().label
      ),
      div(
        { class: "value", style: () => `color:${chargePowerDisplay().color}` },
        span({ "data-charge-power": "" }, () => chargePowerDisplay().magnitude),
        span({ class: "unit" }, () => chargePowerDisplay().unit)
      ),
      div({ class: "sub", "data-charge-electrical": "" }, () => {
        const amps = chargeValue("pack_a"),
          volts = chargeValue("pack_v");
        return `${amps === null ? statusWord(readingStatus("pack_a")) : `${Math.abs(amps).toFixed(0)} A`} · ${volts === null ? statusWord(readingStatus("pack_v")) : `${Math.round(volts)} V`}`;
      })
    )
  );
}
