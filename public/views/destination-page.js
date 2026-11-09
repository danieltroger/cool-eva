// @ts-check
import van from "../vendor/van-1.6.1.js";
import { destination, destinationName } from "../lib/destination.js";
import { SettingsPage } from "./settings-page.js";
import { TripStats } from "./trip-stats.js";
import { WaypointList, collapseWaypointList } from "./waypoints.js";
import { status, refreshStatus, WaypointButton, DownloadButton } from "./sheet.js";
import { LifetimeBlock } from "./lifetime-block.js";
import { LifetimeReadButton } from "./lifetime-read.js";
import { LastServiceRead } from "./last-service-read.js";
import { openBikeReadings } from "../lib/bike-readings.js";
import { ServiceMode } from "./service-mode.js";

const { div, h2 } = van.tags;

export function DestinationPage() {
  switch (destination.val) {
    case "settings":
      return SettingsPage();
    case "session":
      void refreshStatus();
      return div(
        { class: "settings-page layout-page" },
        h2("This session & waypoints"),
        TripStats(),
        WaypointList(status)
      );
    case "bike-information":
      void refreshStatus();
      collapseWaypointList();
      openBikeReadings();
      return div(
        { class: "settings-page layout-page" },
        TripStats(),
        WaypointButton(),
        WaypointList(status),
        DownloadButton(),
        LifetimeBlock(),
        LifetimeReadButton(),
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
