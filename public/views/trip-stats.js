// @ts-check
import van from "../vendor/van-1.6.1.js";
import { chartTick } from "../lib/store.js";
import { distanceKm, movingTimeSeconds } from "../lib/trip.js";
import { duration } from "../lib/format.js";
import * as units from "../lib/units.js";

// The former waypoint tile's restart and subscription constraints: docs/waypoints.md.

export function TripStats() {
  return div(
    { class: "settings-card layout-card", "data-this-ride": "" },
    h3("This ride"),
    div(
      { class: "layout-list-row" },
      "Distance",
      div(() => {
        chartTick.val;
        const travelledKm = distanceKm();
        return travelledKm == null ? "–" : `${units.distance(travelledKm).toFixed(1)} ${units.distanceUnit()}`;
      })
    ),
    div(
      { class: "layout-list-row" },
      "Riding time",
      div(() => {
        chartTick.val;
        return duration(movingTimeSeconds());
      })
    )
  );
}

const { div, h3 } = van.tags;
