// @ts-check
// Header geometry, notice policy and CAN liveness constraints: docs/dashboard-header.md.
import van from "../vendor/van-1.6.1.js";
import { connection, signalState, systemStatus } from "../lib/store.js";
import { destination, backDestinationName, openDestination, closeDestination } from "../lib/destination.js";
import { openSheet } from "./sheet.js";
import { BleHeaderButton } from "./ble-connect.js";
import { HeaderTitle } from "./header-title.js";

const { button, div, span } = van.tags;

export function Header() {
  return div(
    { class: () => (destination.val ? "header destination-header" : "header") },
    button(
      {
        class: "menu",
        onclick: () => (destination.rawVal ? closeDestination() : openSheet()),
        "aria-label": () => (destination.val ? `Back to ${backDestinationName.val}` : "Open menu"),
      },
      () => (destination.val ? `‹ ${backDestinationName.val}` : "☰")
    ),
    HeaderTitle(),
    div(
      { class: "status" },
      BleHeaderButton(() => openDestination("settings", "connections")),
      button(
        {
          class: "can-status-link",
          "aria-label": "CAN adapter details",
          onclick: () => openDestination("settings", "connections"),
        },
        span({ class: () => `dot ${canDotState()}` }),
        "CAN"
      ),
      span({ class: () => `dot ${connection.val}` }),
      span(() => (connection.val === "live" ? "live" : connection.val === "connecting" ? "connecting" : "offline"))
    )
  );
}

/** @returns {"up" | "down" | "unknown"} */
function canDotState() {
  if (connection.val !== "live") return "unknown";
  if (systemStatus.val) return systemStatus.val.can.state;
  return signalState("can_link").val?.value === 0 ? "down" : "unknown";
}
