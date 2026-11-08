// @ts-check
// Approved single-page allocation and measurement scopes: docs/charge-dashboard.md.
import van from "../vendor/van-1.6.1.js";
import { chargePowerDisplay, currentChargeMode, displayChargeMode } from "../lib/charge-display.js";
import { readingStatus, statusWord, freshValue } from "../lib/reading-status.js";
import { ChargeAcLimits } from "./charge-ac-limits.js";
import { ChargeGraph } from "./charge-graph.js";
import { ChargeEtaTile } from "./charge-eta.js";
import { ChargeStopControl } from "./charge-stop.js";
import { ChargeAutoControl } from "./charge-auto.js";
import { ChargeCurrentControl } from "./charge-current.js";
import { ChargeSocLimitControl, readChargeSocLimitOnEntry } from "./charge-soc-limit.js";
import { connection } from "../lib/store.js";
import * as colors from "../lib/colors.js";

const { div, span } = van.tags;

export function ChargeView() {
  void readChargeSocLimitOnEntry();
  return div(
    { class: "view charge-view layout-page layout-stack", "data-view": "charge" },
    () =>
      displayChargeMode.val === "none"
        ? div(
            { class: "tile layout-card charge-idle" },
            span({ class: "charge-section-title" }, () => (connection.val === "live" ? "Not charging" : "Unavailable"))
          )
        : div(
            { class: "layout-stack charge-readings" },
            ChargeHero(),
            ChargeEtaTile(),
            displayChargeMode.val === "ac" ? ChargeAcLimits() : ChargeGraph(),
            ChargeStopControl()
          ),
    div({ class: "layout-stack charge-controls" }, ChargeSocLimitControl(), ChargeCurrentControl(), ChargeAutoControl())
  );
}

function ChargeHero() {
  return div(
    { class: "tile layout-card charge-delivery" },
    div(
      { class: "layout-between" },
      span(
        {
          class: "charge-label",
          "data-charge-direction": "",
          style: () =>
            `color:${chargePowerDisplay().label === "POWER OUT" ? chargePowerDisplay().color : "var(--label)"}`,
        },
        deliveryLabel
      ),
      div(
        { class: "value", style: () => `color:${colors.stateOfCharge(freshValue("soc"))}` },
        span({ "data-charge-soc": "" }, () =>
          freshValue("soc") === null ? statusWord(readingStatus("soc")) : String(Math.round(freshValue("soc") ?? 0))
        ),
        () => (freshValue("soc") === null ? "" : span({ class: "unit" }, "%"))
      )
    ),
    div(
      { class: "layout-between" },
      div(
        {
          class: "value",
          "aria-label": () =>
            `${chargePowerDisplay().label} ${chargePowerDisplay().magnitude} ${chargePowerDisplay().unit}`,
          style: () => `color:${chargePowerDisplay().color}`,
        },
        span({ "data-charge-power": "" }, () => chargePowerDisplay().magnitude),
        span({ class: "unit" }, () => chargePowerDisplay().unit)
      ),
      span(
        { class: "charge-sub", "data-charge-electrical": "" },
        () =>
          `${currentChargeMode() === "ac" ? "Battery · " : ""}${electrical("pack_a", "A")} · ${electrical("pack_v", "V")}`
      )
    )
  );
}

function deliveryLabel() {
  const power = chargePowerDisplay();
  if (power.label === "POWER OUT") return "Power out";
  if (power.status === "fresh" && power.label === "POWER") return "Power";
  const mode = currentChargeMode();
  return mode === "dc" ? "DC charging" : mode === "ac" ? "AC charging" : "Charging";
}
/** @param {string} key @param {string} unit */
function electrical(key, unit) {
  const value = freshValue(key);
  return value === null ? statusWord(readingStatus(key)) : `${Math.round(Math.abs(value))} ${unit}`;
}
