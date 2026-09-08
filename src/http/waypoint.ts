import type { ServerResponse } from "http";
import { saveWaypointNow, type WaypointOutcome } from "../gps/waypoint.ts";

// GET /waypoint — the HTTP shell over ../gps/waypoint.ts, which owns the gates, the
// records and the counters. A long press of the indicator-cancel switch reaches that
// same function without coming through here at all.
//
// Built for a Siri Shortcut: one "Get Contents of URL" action, GET so there is no body
// to configure, and a short plain-text reply that Siri reads back out loud — which is
// the only feedback you get with the phone in a pocket and gloves on.
//
// The dashboard button asks for `Accept: application/json` and gets the same outcome as
// a machine-readable WaypointReply, because a banner deciding whether to be green or red
// cannot do it by reading English. ⚠️ Siri's contract is untouched: no Accept header, or
// any other Accept, still gets exactly the plain-text line it always did.

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

/**
 * @param accept the request's Accept header, or undefined. Only "application/json"
 *   changes anything; everything else, Siri included, gets plain text.
 */
export function handleWaypointEndpoint(res: ServerResponse, accept: string | undefined): void {
  const outcome = saveWaypointNow();
  respond(res, accept, outcome);
}

/**
 * One reply, in whichever of the two forms the caller asked for.
 *
 * Always 200, even for a refusal, and that is deliberate rather than sloppy: Siri
 * surfaces a non-2xx as a generic shortcut failure and never speaks the body, so a rider
 * whose fix had gone stale would hear nothing at all — the one outcome where being told
 * matters most. `saved` carries the verdict for callers that can read it.
 *
 * ⚠️ The reply is built field by field rather than by passing the outcome through, so the
 * refusal CODE stays off the wire: it is the dashboard's live-signal business
 * (public/lib/announce.js), and Siri has the sentence.
 */
function respond(res: ServerResponse, accept: string | undefined, outcome: WaypointOutcome): void {
  const reply: WaypointReply = { saved: outcome.saved, message: outcome.message };
  if (outcome.sequence !== undefined) {
    reply.sequence = outcome.sequence;
  }
  const wantsJson = (accept ?? "").toLowerCase().includes("application/json");
  const body = Buffer.from(wantsJson ? JSON.stringify(reply) : reply.message + "\n", "utf-8");
  res.writeHead(200, {
    "Content-Type": wantsJson ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
    "Content-Length": String(body.length),
  });
  res.end(body);
}
