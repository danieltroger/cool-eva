// @ts-check
import van from "../vendor/van-1.6.1.js";
import { SubTabs } from "../lib/sub-tabs.js";
import { ChargeCurrentControl } from "./charge-current.js";
import { ChargeSocLimitControl, ChargeLimitReadControl } from "./charge-soc-limit.js";
import { ChargeAutoControl } from "./charge-auto.js";
import { ChargeStopOutcome } from "./charge-stop.js";
import { openDestination } from "../lib/destination.js";
const { div, button } = van.tags;

export function ChargeControlsView() {
  return div(
    { class: "view charge-controls-view", "data-view": "charge-controls" },
    SubTabs("charge"),
    ChargeCurrentControl(),
    ChargeSocLimitControl(),
    div(
      { class: "tile charge-secondary-controls" },
      ChargeAutoControl({ compact: true }),
      div(
        { class: "compact-action-row" },
        ChargeLimitReadControl(),
        button(
          { class: "settings-button", onclick: () => openDestination("settings", "charging") },
          "Charging settings →"
        )
      ),
      ChargeStopOutcome()
    )
  );
}
