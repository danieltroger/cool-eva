import type { ServerResponse } from "http";
import { ageMs, record, snapshot } from "../can/signals.ts";

// GET /waypoint — stamp "I am here, now" into the ride log.
//
// Built for a Siri Shortcut: one "Get Contents of URL" action, GET so there is no
// body to configure, and a short plain-text reply that Siri reads back out loud —
// which is the only feedback you get with the phone in a pocket and gloves on.
//
// Nothing new goes on the wire. A waypoint is recorded as three ordinary signals
// (`waypoint_seq`, `waypoint_lat`, `waypoint_lon`), so it travels the existing
// path: sealed into the encrypted log by record(), and pushed to any open
// dashboard by the WebSocket patch it already triggers. The log format is
// unchanged, and `scripts/decrypt-log.ts` needs no special case.
//
// Position is copied into the waypoint's own signals rather than left implicit in
// whatever gps_lat/gps_lon happened to be logged nearby: those carry a ~3 m
// deadband, so at a standstill the last logged fix can be minutes old even though
// the live one is current.

/** A fix older than this is not where you are any more. */
const FIX_MAX_AGE_MS = 30_000;

let waypointCount = 0;

export function handleWaypointEndpoint(res: ServerResponse): void {
  const signals = snapshot();
  const latitude = signals.gps_lat;
  const longitude = signals.gps_lon;
  const now = Date.now();

  if (!latitude || !longitude) {
    // 200, not an error status: Siri surfaces a non-2xx as a generic shortcut
    // failure and never speaks the body, so the rider would hear nothing useful.
    respond(res, "No GPS fix yet — waypoint not saved.");
    console.warn("waypoint: refused, no GPS fix has been received");
    return;
  }

  // Monotonic age, not `now - latitude.ts`. The Pi has no RTC, so the first GPS fix
  // of a no-network boot steps the wall clock by however wrong it was — and this
  // endpoint is reached exactly then, on a bike that has just been switched on with
  // a fresh fix. Against wall time that fix reads as hours old and the waypoint is
  // refused for the whole ride; against the monotonic clock it reads as what it is.
  const latitudeAge = ageMs("gps_lat");
  const longitudeAge = ageMs("gps_lon");
  if (latitudeAge === null || longitudeAge === null) {
    // Cannot happen while record() writes liveState and the monotonic mark together,
    // which is exactly why it must not be papered over with a sentinel: an Infinity
    // here would have Siri announce "GPS fix is Infinity seconds old".
    respond(res, "No GPS fix yet — waypoint not saved.");
    console.warn("waypoint: refused, GPS signals present but never marked as seen");
    return;
  }
  const fixAgeMs = Math.max(latitudeAge, longitudeAge);
  if (fixAgeMs > FIX_MAX_AGE_MS) {
    respond(res, `GPS fix is ${Math.round(fixAgeMs / 1000)} seconds old — waypoint not saved.`);
    console.warn(`waypoint: refused, fix is ${Math.round(fixAgeMs / 1000)} s old`);
    return;
  }

  waypointCount += 1;
  // Sequence first: a reader scanning the log in order sees the marker before the
  // coordinates it labels, and the count is what the dashboard watches to notice
  // that a waypoint was saved from the phone rather than from its own button.
  record("waypoint_seq", waypointCount, now);
  record("waypoint_lat", latitude.value, now);
  record("waypoint_lon", longitude.value, now);

  const spoken = `Waypoint ${waypointCount} saved.`;
  respond(res, spoken);
  console.log(`waypoint: #${waypointCount} at ${latitude.value.toFixed(5)}, ${longitude.value.toFixed(5)}`);
}

/** How many waypoints this boot — for /status. */
export function waypointsSaved(): number {
  return waypointCount;
}

function respond(res: ServerResponse, text: string): void {
  const body = Buffer.from(text + "\n", "utf-8");
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Content-Length": String(body.length) });
  res.end(body);
}
