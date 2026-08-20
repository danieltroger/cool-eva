import type { ServerResponse } from "http";
import { ageMs, record, snapshot } from "../can/signals.ts";
import { systemClockTrust } from "../gps/clock.ts";

// GET /waypoint — stamp "I am here, now" into the ride log.
//
// Built for a Siri Shortcut: one "Get Contents of URL" action, GET so there is no
// body to configure, and a short plain-text reply that Siri reads back out loud —
// which is the only feedback you get with the phone in a pocket and gloves on.
//
// Two dashboard callers now ask for `Accept: application/json` and get the same
// outcome as a machine-readable WaypointReply, because a banner deciding whether to
// be green or red cannot do it by reading English. ⚠️ Siri's contract is untouched:
// no Accept header, or any other Accept, still gets exactly the plain-text line it
// always did.
//
// Nothing new goes on the wire — a waypoint is three ordinary signals, so it travels
// the existing path and scripts/decrypt-log.ts needs no special case. Position is
// copied into those signals rather than left implicit in whatever gps_lat/gps_lon
// was logged nearby: those carry a ~3 m deadband, so at a standstill the last logged
// fix can be minutes old even though the live one is current.
// docs/diagnostics-and-checks.md §9.5.

/** A fix older than this is not where you are any more. */
const FIX_MAX_AGE_MS = 30_000;

/**
 * What the endpoint says, for a caller that has to act on it rather than read it.
 *
 * A named type rather than an inline literal, for the reason CLAUDE.md gives about
 * `DashboardMessage`: the dashboard has no build step, so this interface — imported
 * through JSDoc in public/lib/waypoint.js — is the only thing that stops the two ends
 * drifting. `npm run typecheck` covers both.
 */
export interface WaypointReply {
  /** Whether a waypoint is now in the log. The banner's colour, and the only claim that matters. */
  saved: boolean;
  /** The same sentence Siri is given, for a caller that wants to show it verbatim. */
  message: string;
  /** Which waypoint it was, this boot. Absent when nothing was saved. */
  sequence?: number;
}

let waypointCount = 0;

/**
 * @param accept the request's Accept header, or undefined. Only "application/json"
 *   changes anything; everything else, Siri included, gets plain text.
 */
export function handleWaypointEndpoint(res: ServerResponse, accept: string | undefined): void {
  const signals = snapshot();
  const latitude = signals.gps_lat;
  const longitude = signals.gps_lon;
  const now = Date.now();

  if (!latitude || !longitude) {
    respond(res, accept, { saved: false, message: "No GPS fix yet — waypoint not saved." });
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
    respond(res, accept, { saved: false, message: "No GPS fix yet — waypoint not saved." });
    console.warn("waypoint: refused, GPS signals present but never marked as seen");
    return;
  }
  const fixAgeMs = Math.max(latitudeAge, longitudeAge);
  if (fixAgeMs > FIX_MAX_AGE_MS) {
    const seconds = Math.round(fixAgeMs / 1000);
    respond(res, accept, { saved: false, message: `GPS fix is ${seconds} seconds old — waypoint not saved.` });
    console.warn(`waypoint: refused, fix is ${seconds} s old`);
    return;
  }

  // A waypoint is a place AND a time, and the time is the half this bike is bad at.
  // The Pi has no RTC, so before the first GPS sync the clock is wherever the
  // filesystem left it — and #59 documents a corrupt hub frame that once put it in
  // 2060 and stamped 49 772 rows with it. A position saved against either is worse
  // than no waypoint: it is a waypoint that will be believed.
  //
  // Checked last, because it is the least likely thing still missing by the time we
  // get here — a fresh fix usually means time frames are arriving too, and the gate
  // needs only 1.4–5 s of them to corroborate a time. What this really catches is the
  // state ../gps/clock.ts warns can persist forever: frames arriving, position fine,
  // and the gate refusing every one of them, so the clock silently never syncs at all.
  //
  // The two refusals are worded apart because the rider's options are not the same.
  // "Not yet" is waited out; "disagrees" will not fix itself and wants the journal.
  const trust = systemClockTrust();
  if (trust !== "satellite-backed") {
    const message =
      trust === "never-synced"
        ? "Bike's clock has not synced to GPS yet — waypoint not saved."
        : "Bike's clock disagrees with GPS — waypoint not saved.";
    respond(res, accept, { saved: false, message });
    console.warn(`waypoint: refused, system clock is ${trust}`);
    return;
  }

  waypointCount += 1;
  // Sequence first: a reader scanning the log in order sees the marker before the
  // coordinates it labels, and the count is what the dashboard watches to notice
  // that a waypoint was saved from the phone rather than from its own button.
  record("waypoint_seq", waypointCount, now);
  record("waypoint_lat", latitude.value, now);
  record("waypoint_lon", longitude.value, now);

  respond(res, accept, { saved: true, message: `Waypoint ${waypointCount} saved.`, sequence: waypointCount });
  console.log(`waypoint: #${waypointCount} at ${latitude.value.toFixed(5)}, ${longitude.value.toFixed(5)}`);
}

/** How many waypoints this boot — for /status. */
export function waypointsSaved(): number {
  return waypointCount;
}

/**
 * One reply, in whichever of the two forms the caller asked for.
 *
 * Always 200, even for a refusal, and that is deliberate rather than sloppy: Siri
 * surfaces a non-2xx as a generic shortcut failure and never speaks the body, so a
 * rider whose fix had gone stale would hear nothing at all — the one outcome where
 * being told matters most. `saved` carries the verdict for callers that can read it.
 */
function respond(res: ServerResponse, accept: string | undefined, reply: WaypointReply): void {
  const wantsJson = (accept ?? "").toLowerCase().includes("application/json");
  const body = Buffer.from(wantsJson ? JSON.stringify(reply) : reply.message + "\n", "utf-8");
  res.writeHead(200, {
    "Content-Type": wantsJson ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
    "Content-Length": String(body.length),
  });
  res.end(body);
}
