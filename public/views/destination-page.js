// @ts-check
import van from "../vendor/van-1.6.1.js";
import { destination, destinationName } from "../lib/destination.js";
import { SettingsPage } from "./settings-page.js";
import { TripStats } from "./trip-stats.js";
import { WaypointList, collapseWaypointList } from "./waypoints.js";
import { status, refreshStatus, WaypointButton, DownloadButton } from "./sheet.js";
import { LifetimeBlock } from "./lifetime-block.js";
import { LifetimeReadButton, refreshLifetimeRead } from "./lifetime-read.js";
import { loadLifetimeStats } from "../lib/lifetime.js";
import { LastServiceRead, refreshLastService } from "./last-service-read.js";
import { ServiceMode } from "./service-mode.js";
import { request } from "../lib/transport.js";

const { div, h2 } = van.tags;
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
      void refreshLastService();
      void refreshBikeReadState();
      return div(
        { class: "settings-page" },
        h2("This ride"),
        TripStats(status),
        WaypointButton(),
        WaypointList(status),
        DownloadButton(),
        LifetimeBlock(),
        LifetimeReadButton(() => bikeReadState.val),
        LastServiceRead()
      );
    case "advanced-service":
      return ServiceMode();
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
