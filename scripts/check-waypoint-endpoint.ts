import { createServer } from "http";
import type { AddressInfo } from "net";
import { boundsFor } from "../public/lib/bounds.js";
import { SIGNALS } from "../src/can/registry.ts";
import { defineSignals, latestValue, record, snapshot } from "../src/can/signals.ts";
import { systemClockTrust, syncSystemClockFromGps } from "../src/gps/clock.ts";
import type { WaypointReply } from "../src/http/waypoint.ts";
import { LATITUDE_RANGE, LONGITUDE_RANGE, handleWaypointEndpoint } from "../src/http/waypoint.ts";

// The /waypoint wire, with no Pi and no phone.
//
//   node --experimental-strip-types scripts/check-waypoint-endpoint.ts
//
// ⚠️ NOTHING COVERED THIS ENDPOINT UNTIL NOW, which is how it came to save a position
// 7 000 km from the bike (issue #157). Five refusal branches and five sentences reach a
// rider through Siri or a red banner, and every one of them was unasserted. Three of the
// five are asserted here; the two that are not, and why, are at the foot of the file.
//
// The awkward part is the clock: handleWaypointEndpoint refuses unless
// systemClockTrust() says "satellite-backed", and that is process state set by the real
// gate. Rather than fake it with GPS_TIME_SYNC=0 — which makes systemClockTrust() return
// "satellite-backed" unconditionally and so DELETES the refusal this file wants to
// assert — the clock is corroborated the way the bike corroborates it, with readings.
// Cache-busting the import instead (`waypoint.ts?x`) does not work: the copy re-resolves
// its own static import of gps/clock.ts without the query and shares the loaded one.

let failures = 0;

function check(what: string, condition: boolean) {
  if (condition) {
    console.log(`  ✓ ${what}`);
  } else {
    console.error(`  ✗ ${what}`);
    failures += 1;
  }
}

defineSignals(SIGNALS);

const server = createServer((req, res) => {
  handleWaypointEndpoint(res, req.headers.accept);
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

/** The endpoint as the dashboard and the handlebar banner see it. */
async function ask(): Promise<WaypointReply> {
  const response = await fetch(`${base}/waypoint`, { headers: { Accept: "application/json" } });
  return (await response.json()) as WaypointReply;
}

/** A fix, straight into liveState, exactly as the GPS decoders put one there. */
function stageFix(latitude: number, longitude: number) {
  record("gps_lat", latitude);
  record("gps_lon", longitude);
}

// --- 1. The bounds this file and the dashboard have to agree about ------------
//
// public/lib/bounds.js cannot import a .ts module — the dashboard has no build step —
// so the same four signals are gated in two files that cannot see each other. This is
// the assertion that stops them drifting; without it the pair is a comment.

console.log("\n1. the server's limits and the dashboard's are the same limits");

for (const key of ["gps_lat", "waypoint_lat"]) {
  const group = key.startsWith("waypoint") ? "waypoint" : "gps";
  const bounds = boundsFor(key, "°", group);
  check(
    `${key} is gated to ${LATITUDE_RANGE[0]}…${LATITUDE_RANGE[1]} on both sides`,
    bounds !== null && bounds[0] === LATITUDE_RANGE[0] && bounds[1] === LATITUDE_RANGE[1]
  );
}
for (const key of ["gps_lon", "waypoint_lon"]) {
  const group = key.startsWith("waypoint") ? "waypoint" : "gps";
  const bounds = boundsFor(key, "°", group);
  check(
    `${key} is gated to ${LONGITUDE_RANGE[0]}…${LONGITUDE_RANGE[1]} on both sides`,
    bounds !== null && bounds[0] === LONGITUDE_RANGE[0] && bounds[1] === LONGITUDE_RANGE[1]
  );
}

// --- 2. Refusals, in the order a cold boot meets them -------------------------

console.log("\n2. what it refuses, and whether it says why");

const noFix = await ask();
check("with no fix at all, nothing is saved", !noFix.saved);
check("…and the sentence says which of the five reasons it was", noFix.message.includes("No GPS fix yet"));

stageFix(45.374038, 14.321478);

// The clock branch. Skipped rather than failed if the operator has claimed the clock,
// because GPS_TIME_SYNC=0 makes this refusal structurally unreachable — see the header.
if (process.env.GPS_TIME_SYNC === "0") {
  console.log("  – clock refusal not checked: GPS_TIME_SYNC=0 says something else owns the clock");
} else {
  const untrusted = await ask();
  check("a good fix with an unsynced clock is still refused", !untrusted.saved);
  check("…and the sentence blames the clock, not the fix", untrusted.message.includes("clock"));
  check("…and no waypoint reached the log", latestValue("waypoint_seq") === null);
}

// --- 3. The clock, corroborated the way the bike corroborates it --------------
//
// GpsClockGate wants REQUIRED_CONSISTENT_READINGS agreeing inside its window; readings
// that match the system clock produce the "in-agreement" verdict, which confirms the
// clock without stepping it. `step: false` is what guarantees this check never spawns
// `date` — the child process sits past that early return in gps/clock.ts.

console.log("\n3. a corroborated clock, and then a waypoint");

for (let reading = 0; reading < 6; reading += 1) {
  await syncSystemClockFromGps(Date.now() / 1000);
}
if (process.env.GPS_TIME_SYNC === "0") {
  // Asserting it here would pass without the readings having done anything, since the
  // env makes systemClockTrust() answer "satellite-backed" before it looks at the gate.
  console.log("  – the clock was already trusted by GPS_TIME_SYNC=0, so the corroboration proves nothing here");
} else {
  check("six corroborating readings make the clock satellite-backed", systemClockTrust() === "satellite-backed");
}

const saved = await ask();
check("a fresh, plausible fix under a trusted clock saves", saved.saved);
check("…and the reply carries the sequence a banner shows", saved.sequence === 1);
check("…and the count is what the log got", latestValue("waypoint_seq") === 1);

const stamped = snapshot();
check(
  "…and the position saved is the position held, copied rather than inferred",
  stamped.waypoint_lat?.value === 45.374038 && stamped.waypoint_lon?.value === 14.321478
);
check(
  "…and all three rows share one timestamp, so the log can pivot them on it",
  stamped.waypoint_seq?.ts === stamped.waypoint_lat?.ts && stamped.waypoint_lat?.ts === stamped.waypoint_lon?.ts
);

// --- 4. A fix that is not a position on Earth ---------------------------------
//
// ⚠️ THE CASE THIS FILE WAS WRITTEN FOR. On main both of these save: the endpoint
// copied whatever liveState held, and nothing anywhere gated a coordinate.

console.log("\n4. a fix that is not a position on Earth");

stageFix(200, 14.321478);
const badLatitude = await ask();
check("a latitude of 200 is refused", !badLatitude.saved);
check("…and the sentence names the reason and the numbers", badLatitude.message.includes("not a real position"));
check("…and nothing was recorded: the count has not moved", latestValue("waypoint_seq") === 1);

stageFix(45.374038, 999);
const badLongitude = await ask();
check("a longitude of 999 is refused too", !badLongitude.saved);
check("…and still nothing was recorded", latestValue("waypoint_seq") === 1);

stageFix(-90, -180);
const corners = await ask();
check("the corners of the planet are positions, and save", corners.saved && corners.sequence === 2);

// A refusal must not have eaten a sequence number, which is the kind of off-by-one a
// counter shared between a refusal path and a save path invites.
stageFix(45.374038, 14.321478);
const afterRefusals = await ask();
check("the sequence counts saves, not attempts", afterRefusals.sequence === 3);

// --- 5. Siri's half of the contract -------------------------------------------
//
// Siri sends no Accept header and speaks the body. A JSON body would be read out as
// punctuation, and a non-2xx is not spoken at all — which is why even a refusal is 200.

console.log("\n5. what Siri gets");

const spoken = await fetch(`${base}/waypoint`);
const spokenBody = await spoken.text();
check("no Accept header still gets text/plain", (spoken.headers.get("content-type") ?? "").startsWith("text/plain"));
check("…with 200, so Siri speaks it", spoken.status === 200);
check("…and one line, ending in a newline", spokenBody.endsWith("\n") && spokenBody.trim().split("\n").length === 1);

stageFix(200, 14.321478);
const spokenRefusal = await fetch(`${base}/waypoint`);
const spokenRefusalBody = await spokenRefusal.text();
check("a refusal is 200 as well, or it is never heard", spokenRefusal.status === 200);
check("…and says the same thing the JSON caller was told", spokenRefusalBody.includes("not a real position"));

const html = await fetch(`${base}/waypoint`, { headers: { Accept: "text/html" } });
check("any other Accept is Siri's contract, not the dashboard's", (await html.text()).includes("not a real position"));

server.close();

// Two of the five sentences are not asserted here. A fix older than FIX_MAX_AGE_MS takes
// a 31-second wait, because its age comes from a monotonic mark taken inside record() —
// against a suite that runs in ten seconds. And "the clock disagrees" needs the gate to
// reach `contested`, which takes a corroborated time that contradicts one already
// trusted; check-gps-clock.ts drives that gate directly and is the place for it.
//
// The branch with no sentence of its own — a signal in liveState with no monotonic mark —
// cannot be reached from outside signals.ts at all: record() writes both together, which
// is the property that makes it "cannot happen" in the handler's own words.
console.log(
  `\n${failures === 0 ? "✓" : "✗"} /waypoint: three of the five refusal sentences, the save, the sequence and Siri's contract` +
    ` — ${failures} failure${failures === 1 ? "" : "s"}`
);
if (failures > 0) {
  process.exit(1);
}
