// @ts-check
import van from "../vendor/van-1.6.1.js";
import { destination, openRidingView, destinationName, ridingUrl } from "../lib/destination.js";
import { AccessLink } from "./settings-access.js";
import { SettingsPage } from "./settings-page.js";
import { TripStats } from "./trip-stats.js";
import { WaypointList, collapseWaypointList } from "./waypoints.js";
import { status, refreshStatus, WaypointButton, DownloadButton } from "./sheet.js";
import { LifetimeBlock } from "./all.js";
import { LifetimeReadButton, refreshLifetimeRead } from "./lifetime-read.js";
import { loadLifetimeStats } from "../lib/lifetime.js";
import { LastServiceRead, refreshVcuWrite } from "./vcu-write.js";
import { ServiceMode, refreshServiceMode } from "./service-mode.js";
import { request } from "../lib/transport.js";
import { openDestination } from "../lib/destination.js";
import { BatteryCoolingPage } from "./battery-cooling.js";

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
      void refreshStatus();
      collapseWaypointList();
      void loadLifetimeStats();
      void refreshVcuWrite();
      void refreshBikeReadState();
      return div(
        { class: "settings-page" },
        h2("This ride"),
        TripStats(status),
        WaypointButton(),
        WaypointList(status),
        DownloadButton(),
        button({ class: "menu-link", onclick: () => openDestination("battery-cooling") }, "Battery & cooling"),
        LifetimeBlock(true),
        LifetimeReadButton(() => bikeReadState.val),
        LastServiceRead(),
        button(
          {
            class: "menu-link",
            onclick: () => {
              openRidingView("fault-report");
            },
          },
          "Fault details → Full report"
        )
      );
    case "battery-cooling":
      return BatteryCoolingPage();
    case "advanced-service":
      refreshServiceMode(() => destination.val === "advanced-service");
      return div(
        { class: "settings-page" },
        AccessLink(),
        ServiceMode(false),
        van.tags.a(
          {
            class: "layout-list-row navigation-link",
            href: ridingUrl("all"),
            onclick: (/** @type {MouseEvent} */ event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              openRidingView("all");
            },
          },
          van.tags.span("All signals"),
          van.tags.span("›")
        )
      );
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
