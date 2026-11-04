// @ts-check
import van from "../vendor/van-1.6.1.js";
import { destination, destinationSection, openRidingTab, destinationName } from "../lib/destination.js";
import { SettingsPage } from "./settings-page.js";
import { TripStats } from "./trip-stats.js";
import { WaypointList } from "./waypoints.js";
import { status, refreshStatus } from "./sheet.js";
import { LifetimeBlock } from "./all.js";
import { LifetimeReadButton, refreshLifetimeRead } from "./lifetime-read.js";
import { loadLifetimeStats } from "../lib/lifetime.js";
import { LastServiceRead, refreshVcuWrite } from "./vcu-write.js";
import { ServiceMode, refreshServiceMode } from "./service-mode.js";
import { request } from "../lib/transport.js";
import { showTab } from "../lib/router.js";

const { button, div, h2 } = van.tags;
const bikeReadState = van.state(/** @type {import("../../src/http/vcu-read.ts").VcuReadResponse | null} */ (null));

export function DestinationPage() {
  switch (destination.val) {
    case "settings":
      return SettingsPage();
    case "session":
      void refreshStatus();
      return div({ class: "settings-page" }, h2("This session & waypoints"), TripStats(status), WaypointList(status));
    case "bike-information":
      void loadLifetimeStats();
      void refreshVcuWrite();
      void refreshBikeReadState();
      return div(
        { class: "settings-page" },
        h2("Bike information"),
        LifetimeBlock(true),
        LifetimeReadButton(() => bikeReadState.val),
        LastServiceRead(),
        button(
          {
            class: "menu-link",
            onclick: () => {
              openRidingTab("faults");
            },
          },
          "Fault details → Faults"
        )
      );
    case "advanced-service":
      refreshServiceMode(() => destination.val === "advanced-service");
      return div({ class: "settings-page" }, h2("Advanced service"), ServiceMode(false));
    default:
      return div();
  }
}

export function destinationTitle() {
  return destinationName();
}

async function refreshBikeReadState() {
  try {
    const response = await request("/vcu-read");
    bikeReadState.val = /** @type {import("../../src/http/vcu-read.ts").VcuReadResponse} */ (await response.json());
    void refreshLifetimeRead();
  } catch (error) {
    console.warn("bike information: read state unavailable", error);
  }
}
