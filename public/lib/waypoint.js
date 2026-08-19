// @ts-check

/** @typedef {import("../../src/http/waypoint.ts").WaypointReply} WaypointReply */

// Saving a waypoint from the phone, for both callers that do it: the menu button and
// the handlebar long press.
//
// One code path on purpose. The server decides whether a waypoint may be saved — it
// owns the GPS fix, its age and the clock it would be stamped with — and this asks it
// in the one way that gets a machine-readable answer back. Nothing here re-derives
// that judgement from the dashboard's own copy of the signals, because a second
// opinion about whether the save happened is exactly how a banner ends up claiming a
// waypoint that is not in the log.

/**
 * Asks the bike to stamp a waypoint here, now.
 *
 * Never throws: every caller is a UI that has to say something either way, and on a
 * bike the interesting failure is the network rather than the server.
 *
 * @returns {Promise<WaypointReply>}
 */
export async function saveWaypoint() {
  try {
    const response = await fetch("/waypoint", {
      // The endpoint answers Siri in plain text by default (src/http/waypoint.ts).
      // This is the same request, asking for the structured form.
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    const reply = /** @type {WaypointReply} */ (await response.json());
    if (typeof reply?.saved !== "boolean" || typeof reply?.message !== "string") {
      // Shape we did not send. Reported rather than coerced: a malformed reply read
      // as `saved: false` would be a lie in the safe direction, and one read as
      // `saved: true` a lie in the dangerous one.
      console.warn("waypoint: unexpected reply shape", reply);
      return { saved: false, message: "Bike replied with something unexpected — waypoint not confirmed." };
    }
    return reply;
  } catch (error) {
    // The usual cause is the hotspot dropping, which is worth naming: the rider can
    // do something about that, and a bare "failed" leaves the button looking broken.
    console.warn("waypoint: request failed", error);
    return { saved: false, message: "No answer from the bike — is the phone still on its hotspot?" };
  }
}
