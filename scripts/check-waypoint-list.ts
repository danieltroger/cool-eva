import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SIGNALS } from "../src/can/registry.ts";
import { defineSignals, record, snapshot } from "../src/can/signals.ts";
import {
  MAX_EVENTS,
  createWaypointLog,
  recordRefusedWaypoint,
  recordSavedWaypoint,
  waypointEventsOf,
  waypointLog,
  type WaypointEvent,
} from "../src/gps/waypoint-log.ts";
import type { StatusPayload } from "../src/http/status.ts";
import { WAYPOINT_REFUSAL_TEXT } from "../public/lib/announce.js";
import {
  WAYPOINT_HISTORY_NOTE,
  blankWaypointMemory,
  shouldRefreshOnWaypoint,
  waypointListSummary,
  waypointRows,
} from "../public/lib/waypoint-list.js";
import { blockAt, declarationBody } from "./source-blocks.ts";
import { recordingResponse } from "./recording-response.ts";

// The menu sheet's waypoint list: what the bike remembers of this boot, and what the phone
// makes of it.
//
//   node --experimental-strip-types scripts/check-waypoint-list.ts
//
// ⚠️ WHAT THIS IS REALLY GUARDING is that the list cannot quietly be SHORT. Every way it
// can lose a waypoint is silent by nature — a cap that evicts the wrong end, a bike that
// kept fewer than it counted, a view that shows six of fifty — so each of those is asserted
// against the words the phone puts on screen rather than against an internal number.
//
// ⚠️ GPS_TIME_SYNC=0 is set before src/gps/waypoint.ts is imported, the way
// scripts/check-hold-gestures.ts does it: with it unset, systemClockTrust() answers
// "never-synced" in a process with no GPS and every save below would be refused for that
// one reason. It also means `clockTrustworthy` reads true on every refusal this file
// produces through the real path, so the false case is driven straight into the log — the
// clock gate itself is scripts/check-gps-clock.ts's.
process.env.GPS_TIME_SYNC = "0";
const { WAYPOINT_REFUSAL, saveWaypointNow, startWaypointFixTracking, waypointsRefused, waypointsSaved } =
  await import("../src/gps/waypoint.ts");
// ⚠️ …and /status with it, for the same reason and not by preference: ESM evaluates every
// static import before the first line of this file, so importing src/http/status.ts at the
// top would pull src/gps/clock.ts in — and SYNC_ENABLED is read there at import time —
// before the assignment above could mean anything. The symptom is every save below refused
// with "system clock is never-synced", which is a true statement about the wrong thing.
const { handleStatusEndpoint } = await import("../src/http/status.ts");

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

/**
 * What a full log may cost on the wire, in bytes of JSON.
 *
 * ⚠️ A budget, deliberately NOT derived from MAX_EVENTS — a limit computed from the thing
 * it limits cannot fire. /status is fetched every time the sheet opens, over a garage
 * hotspot, and a full-precision coordinate pair is ~119 B of that, so this is the number
 * that says "the list is a list, not a ride log": 50 events measure about 6 kB.
 */
const MAX_PAYLOAD_BYTES = 12_000;

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

/** A saved event, for the pure half — the bike's own are asserted in §1. */
function saved(sequence: number, at: number, latitudeDeg = 51.4779, longitudeDeg = -0.0015): WaypointEvent {
  return { outcome: "saved", sequence, latitudeDeg, longitudeDeg, at };
}

/** A refused event, ditto. */
function refused(refusal: number, at: number, clockTrustworthy = true): WaypointEvent {
  return { outcome: "refused", refusal: refusal as 1, at, clockTrustworthy };
}

// --- 1. the bike's own log, through the real save and the real refusal --------
//
// The endpoint's own gates are scripts/check-waypoint-endpoint.ts's; what is asserted here
// is that each outcome leaves exactly one event behind, carrying the moment the ride log
// carries. Driven once through the real path for the wiring — the rules themselves are
// exercised against a log of this file's own below, which is the only way to reach a cap of
// fifty without satisfying seven gates fifty-three times.

console.log("\n1. a save and a refusal each leave one event in the bike's own log");

const fixes = startWaypointFixTracking();

// ⚠️ THE SAME POSITION TWICE, with a microtask between: onFixChanged() runs from a
// queueMicrotask, and the corroboration gate (#178) wants a SAMPLE newer than the fix it
// would save. Identical values sit inside the deadband, so `precedingFix` stays null and
// the gate takes the arm this file needs. check-waypoint-endpoint.ts §stageFix has the
// whole argument.
record("gps_lat", 51.4779);
record("gps_lon", -0.0015);
await Promise.resolve();
record("gps_lat", 51.4779);
record("gps_lon", -0.0015);

const beforeSave = waypointEventsOf(waypointLog).length;
const outcome = saveWaypointNow();
const afterSave = waypointEventsOf(waypointLog);
check("the save was not refused for something this file staged wrong", outcome.saved);
check("it appended exactly one event", afterSave.length === beforeSave + 1);
const savedEvent = afterSave[afterSave.length - 1];
check(
  "…and it is a `saved` one carrying the sequence the rider was told",
  savedEvent.outcome === "saved" && savedEvent.sequence === outcome.sequence
);
// The same instant as the three signals. A row in this list and a row in the ride log are
// the same waypoint, and a second Date.now() would have put them milliseconds apart.
const signals = snapshot();
check(
  "…stamped with the same moment as waypoint_seq/lat/lon",
  savedEvent.at === signals.waypoint_seq.ts && savedEvent.at === signals.waypoint_lat.ts
);
check(
  "…and the position the signals carry, not a nearby fix",
  savedEvent.outcome === "saved" &&
    savedEvent.latitudeDeg === signals.waypoint_lat.value &&
    savedEvent.longitudeDeg === signals.waypoint_lon.value
);

// And a refusal. ⚠️ Not by clearing the fix — liveState keeps the last value it was given
// and record() drops a non-finite one, so "no fix" is unreachable once one has arrived.
// A position off the Earth is, and which gate answers does not matter here: what is
// asserted is that a refusal leaves an event and takes no sequence number with it.
const savesBeforeRefusal = waypointsSaved();
record("gps_lat", 91);
record("gps_lon", 0);
await Promise.resolve();
const refusal = saveWaypointNow();
const afterRefusal = waypointEventsOf(waypointLog);
check("a refusal was recorded as one", refusal.saved === false && refusal.refusal !== undefined);
check("it appended exactly one event", afterRefusal.length === afterSave.length + 1);
const refusedEvent = afterRefusal[afterRefusal.length - 1];
check(
  "…a `refused` one carrying the gate's own code",
  refusedEvent.outcome === "refused" && refusedEvent.refusal === refusal.refusal
);
check("…and it consumed no sequence number", waypointsSaved() === savesBeforeRefusal);
check("both counters see it", waypointsRefused() === 1 && waypointsSaved() === 1);
fixes.stop();

// --- 1b. a refusal the Pi could not date, through the real clock gate ---------
//
// ⚠️ ITS OWN PROCESS, and that is the only way this can be asserted at all: SYNC_ENABLED is
// read in src/gps/clock.ts at import time, so a process that set GPS_TIME_SYNC=0 to make the
// saves above possible can never reach "never-synced" afterwards. A child without it can,
// and it is the pairing that matters — CLOCK_NEVER_SYNCED and a `clockTrustworthy: false`
// stamped from the same gate, on the same event, so the phone knows not to print a time.
//
// The fix is staged exactly as above, because the clock gate is LAST: without a corroborated
// fresh fix this refuses for NO_FIX and never reaches the question.

console.log("\n1b. a cold boot's refusal carries the Pi's own verdict on its clock");

const cold = await promisify(execFile)(
  process.execPath,
  [
    "--experimental-strip-types",
    "--input-type=module",
    "-e",
    `import { SIGNALS } from "./src/can/registry.ts";
     import { defineSignals, record } from "./src/can/signals.ts";
     import { saveWaypointNow, startWaypointFixTracking } from "./src/gps/waypoint.ts";
     import { waypointEventsOf, waypointLog } from "./src/gps/waypoint-log.ts";
     defineSignals(SIGNALS);
     const fixes = startWaypointFixTracking();
     record("gps_lat", 51.4779);
     record("gps_lon", -0.0015);
     await Promise.resolve();
     record("gps_lat", 51.4779);
     record("gps_lon", -0.0015);
     const outcome = saveWaypointNow();
     fixes.stop();
     console.log(JSON.stringify({ outcome, events: waypointEventsOf(waypointLog) }));`,
  ],
  // `undefined` really does unset it: Node drops undefined values when it builds the child's
  // environment, rather than passing the string "undefined".
  { cwd: ROOT, env: { ...process.env, GPS_TIME_SYNC: undefined } }
);
const coldEvents = (JSON.parse(cold.stdout.trim()) as { outcome: { refusal?: number }; events: WaypointEvent[] })
  .events;
const coldRefusal = coldEvents[coldEvents.length - 1];
check("a bike whose clock has never synced refuses the save", coldRefusal?.outcome === "refused");
check(
  "…for the clock, which is the last gate and so the one being asked about",
  coldRefusal?.outcome === "refused" && coldRefusal.refusal === WAYPOINT_REFUSAL.CLOCK_NEVER_SYNCED
);
check(
  "⚠️  …and the event says the clock was not to be believed, which is what stops the phone printing a time of day",
  coldRefusal?.outcome === "refused" && coldRefusal.clockTrustworthy === false
);
check(
  "…while this process, which owns its own clock, stamps the opposite",
  refusedEvent.outcome === "refused" && refusedEvent.clockTrustworthy === true
);

// --- 2. the cap evicts refusals before it ever evicts a place ----------------
//
// ⚠️ NOT "the newest MAX_EVENTS are kept", which is what an unconditional cap would do and
// is exactly the failure this rule exists to prevent: a rider holding the switch at a cold
// boot produces refusals as fast as a thumb moves, and fifty of them would evict every
// waypoint of the ride while the counters stayed correct.

console.log("\n2. the cap drops the oldest refusal first, and a save only when there is none");

const small = createWaypointLog(4);
recordSavedWaypoint(small, 1, 51.4779, -0.0015, 1000);
recordRefusedWaypoint(small, 3, 1100, true);
recordSavedWaypoint(small, 2, 51.4779, -0.0015, 1200);
recordRefusedWaypoint(small, 6, 1300, true);
recordSavedWaypoint(small, 3, 51.4779, -0.0015, 1400);
const afterCap = waypointEventsOf(small);
check(`it holds its cap and no more (${afterCap.length})`, afterCap.length === 4);
check(
  "every save survived — #1, #2 and #3 are all there",
  afterCap
    .filter(event => event.outcome === "saved")
    .map(event => (event.outcome === "saved" ? event.sequence : 0))
    .join() === "1,2,3"
);
check(
  "…and it was the OLDEST refusal that went, not the oldest event",
  afterCap
    .filter(event => event.outcome === "refused")
    .map(event => (event.outcome === "refused" ? event.refusal : 0))
    .join() === "6"
);
check("fire order is unchanged by the eviction", afterCap.map(event => event.at).join() === "1000,1200,1300,1400");

const savesOnly = createWaypointLog(2);
recordSavedWaypoint(savesOnly, 1, 51.4779, -0.0015, 1000);
recordSavedWaypoint(savesOnly, 2, 51.4779, -0.0015, 1100);
recordSavedWaypoint(savesOnly, 3, 51.4779, -0.0015, 1200);
check(
  "with nothing but saves it does give way, oldest first",
  waypointEventsOf(savesOnly)
    .map(event => (event.outcome === "saved" ? event.sequence : 0))
    .join() === "2,3"
);

// ⚠️ The shape that inverts the rule's own wording: a log with no refusal in it yet takes
// one, and the only refusal present is the arrival. Saves still win — which is the rule —
// but it is worth pinning, because the obvious "fix" is to evict the oldest save instead.
const savesThenRefusal = createWaypointLog(2);
recordSavedWaypoint(savesThenRefusal, 1, 51.4779, -0.0015, 1000);
recordSavedWaypoint(savesThenRefusal, 2, 51.4779, -0.0015, 1100);
recordRefusedWaypoint(savesThenRefusal, 6, 1200, true);
check(
  "a refusal arriving at a log full of saves is what gives way, and both saves stay",
  waypointEventsOf(savesThenRefusal)
    .map(event => (event.outcome === "saved" ? `#${event.sequence}` : "refused"))
    .join() === "#1,#2"
);

const full = createWaypointLog();
for (let index = 1; index <= MAX_EVENTS; index += 1) {
  recordSavedWaypoint(full, index, 51.477912345678, -0.001512345678, 1_760_000_000_000 + index);
}
const payloadBytes = JSON.stringify(waypointEventsOf(full)).length;
check(
  `a full log is ${payloadBytes} B of JSON, inside the ${MAX_PAYLOAD_BYTES} B this may cost /status`,
  payloadBytes <= MAX_PAYLOAD_BYTES
);

// --- 3. newest first is the ORDER SERVED, never a sort on the Pi's clock -----

console.log("\n3. the rows are the served order reversed, whatever the clock did");

// A clock step mid-boot: the third event is stamped an hour BEFORE the second, which is
// what `date -u -s` does to a Pi with no RTC (src/gps/clock.ts). Fire order still says
// which came last, and a sort by `at` would put row #2 on top.
const stepped = [saved(1, 5_000_000), saved(2, 9_000_000), saved(3, 5_400_000)];
check(
  "the newest row is the one that happened last, not the one with the latest stamp",
  waypointRows(stepped)[0].mark === "#3"
);
check(
  "…and the rest follow in reverse fire order",
  waypointRows(stepped)
    .map(row => row.mark)
    .join() === "#3,#2,#1"
);
check("a payload that is not a list at all draws nothing rather than throwing", waypointRows(undefined).length === 0);
check(
  "a record this dashboard cannot read is SHOWN, not dropped",
  waypointRows([{ outcome: "something-else" } as unknown as WaypointEvent])[0].fault
);

// --- 4. asking the bike again, without asking it every five seconds ----------
//
// ⚠️ THE HEARTBEAT IS THE DEFECT THIS GUARDS. src/ws.ts sends a FULL snapshot every 5 s and
// public/lib/store.js assigns each signal a freshly parsed object, so a derive watching
// `waypoint_seq` re-runs on every heartbeat for ever. Folding on the VALUE is what keeps
// that off /status — which walks the ride-log directory and stats every file in it.

console.log("\n4. a new waypoint refreshes the list; a heartbeat carrying the same one does not");

/** One reading of the pair, the way the derive in views/sheet.js takes them. */
function counters(saved: number | null, refused: number | null) {
  return { saved, refused };
}

let memory = blankWaypointMemory();
const first = shouldRefreshOnWaypoint(memory, counters(null, null), true);
memory = first.memory;
check("nothing has arrived yet, so nothing is fetched", first.refresh === false);
const arrived = shouldRefreshOnWaypoint(memory, counters(1, null), true);
memory = arrived.memory;
check("the boot's FIRST waypoint is news, not a baseline", arrived.refresh);
const heartbeat = shouldRefreshOnWaypoint(memory, counters(1, null), true);
memory = heartbeat.memory;
check("the same sequence arriving again fetches nothing", heartbeat.refresh === false);

// ⚠️ THE CASE THE LIST IS FOR. A refusal moves `waypoint_refused_seq` and NOTHING else —
// src/gps/waypoint.ts's refuse() never touches `waypoint_seq` — so a refresh folded on the
// save counter alone leaves the rider holding the switch, seeing one toast go by, and
// finding the list underneath still claiming the older count.
const refusedPress = shouldRefreshOnWaypoint(memory, counters(1, 1), true);
memory = refusedPress.memory;
check("⚠️  a press the bike REFUSED, with the sheet open, is fetched", refusedPress.refresh);
const refusedAgain = shouldRefreshOnWaypoint(memory, counters(1, 1), true);
memory = refusedAgain.memory;
check("…and the heartbeat behind it is not", refusedAgain.refresh === false);

// The sheet is shut: nothing is fetched, but the memory must still move — or the first
// heartbeat after the sheet opens fires a fetch openSheet() has already made redundant.
const whileShut = shouldRefreshOnWaypoint(memory, counters(2, 1), false);
memory = whileShut.memory;
check("a waypoint saved with the sheet shut fetches nothing", whileShut.refresh === false);
const afterOpening = shouldRefreshOnWaypoint(memory, counters(2, 1), true);
memory = afterOpening.memory;
check(
  "…and is not re-fetched by the next heartbeat once it opens — the memory moved anyway",
  afterOpening.refresh === false
);
check(
  "a third waypoint, with the sheet open, is fetched",
  shouldRefreshOnWaypoint(memory, counters(3, 1), true).refresh
);

// --- 5. a position the gate rejects is shown as a fault, never dropped -------

console.log("\n5. an impossible coordinate is drawn as a fault, with the row intact");

const outOfRange = waypointRows([saved(7, 1_760_000_000_000, 91, -0.0015)])[0];
check("the row is still there — not silently dropped", outOfRange.mark === "#7");
check("…marked as a fault", outOfRange.fault);
check("…showing the value the bike sent rather than a clamped one", outOfRange.text.includes("91.000000"));
check("…and still saying when it happened, to the minute", /^\d{2}:\d{2} · /.test(outOfRange.when));
const longitudeOut = waypointRows([saved(8, 1_760_000_000_000, 51.4779, 181)])[0];
check("longitude is gated too, not only latitude", longitudeOut.fault && longitudeOut.text.includes("181.000000"));
const inRange = waypointRows([saved(9, 1_760_000_000_000)])[0];
check("a real position is not a fault", inRange.fault === false && inRange.text === "51.477900, -0.001500");

// --- 6. the words, which are the whole of what a rider gets ------------------

console.log("\n6. every sentence on this list, as the phone words it");

for (const [name, code] of Object.entries(WAYPOINT_REFUSAL)) {
  const row = waypointRows([refused(code, 1_760_000_000_000)])[0];
  check(`${name} (${code}) has a sentence, and it is the banner's own`, row.text === WAYPOINT_REFUSAL_TEXT[code]);
}
check("a refused row is marked as one", waypointRows([refused(6, 1_760_000_000_000)])[0].mark === "refused");
check(
  "⚠️  a refusal the Pi could not date says so, rather than printing a time off a clock it disowns",
  waypointRows([refused(4, 1_760_000_000_000, false)])[0].when === "at an unknown time"
);
check(
  "…while one it could date carries the time of day",
  waypointRows([refused(4, Date.now(), true)])[0].when.includes("just now")
);

const nothing = { events: [], savedTotal: 0, refusedTotal: 0, rowsShown: 0 };
check(
  "an empty list says the bike has not been asked, rather than showing nothing at all",
  waypointListSummary(nothing) === "No waypoints since the bike last started."
);
const plain = [saved(1, 1_000), refused(3, 1_100), saved(2, 1_200)];
check(
  "…and a full one counts both outcomes",
  waypointListSummary({ events: plain, savedTotal: 2, refusedTotal: 1, rowsShown: 3 }) ===
    "2 saved · 1 refused since the bike last started."
);
check(
  "the view's own truncation is named",
  waypointListSummary({ events: plain, savedTotal: 2, refusedTotal: 1, rowsShown: 2 }) ===
    "2 saved · 1 refused since the bike last started · showing the newest 2."
);
check(
  "⚠️  the BIKE's truncation is a different sentence — it dropped refusals, and says so",
  waypointListSummary({ events: plain, savedTotal: 2, refusedTotal: 9, rowsShown: 3 }) ===
    "2 saved · 9 refused since the bike last started · the bike dropped its oldest refusals."
);
check(
  "⚠️  …and when even saves have gone, it says how many places are actually here",
  waypointListSummary({ events: plain, savedTotal: 40, refusedTotal: 1, rowsShown: 3 }) ===
    "40 saved · 1 refused since the bike last started · the bike kept only the newest 2 saves."
);
check(
  "the list says where the history is not, whatever the counts are",
  WAYPOINT_HISTORY_NOTE.includes("restarts") && WAYPOINT_HISTORY_NOTE.includes("ride log")
);
check(
  'a payload with no counts says so, rather than rendering "undefined saved"',
  waypointListSummary({
    events: plain,
    savedTotal: undefined as unknown as number,
    refusedTotal: undefined as unknown as number,
    rowsShown: 3,
  }) === "The bike did not say how many waypoints it has."
);

// --- 7. /status really carries them -----------------------------------------

console.log("\n7. the payload the sheet fetches");

const recorded = recordingResponse();
await handleStatusEndpoint(recorded.res, join(ROOT, "no-such-ride-log-directory"), false);
const payload = JSON.parse(recorded.body) as StatusPayload;
check("it carries every event the log holds", payload.waypointEvents.length === waypointEventsOf(waypointLog).length);
check(
  "…the same ones the log holds, in the same order",
  JSON.stringify(payload.waypointEvents) === JSON.stringify(waypointEventsOf(waypointLog))
);
check(
  "…and both counters beside them",
  payload.waypoints === waypointsSaved() && payload.waypointsRefused === waypointsRefused()
);
check(
  "the list the phone would draw from it starts with the newest",
  waypointRows(payload.waypointEvents)[0].mark === "refused"
);

// --- 8. the two facts a pure function cannot see -----------------------------
//
// Read rather than run, the way scripts/check-arming.ts reads openSheet(): both of these
// need a DOM, and both are the kind of mistake that ships green — a derive created inside a
// binding is dropped at the next re-render, and `.val` here would subscribe the refresh to
// the sheet opening and closing.

console.log("\n8. the refresh derive, read off its own source");

const sheetSource = await readFile(join(ROOT, "public/views/sheet.js"), "utf8");
const appSource = await readFile(join(ROOT, "public/app.js"), "utf8");
const installer = declarationBody(sheetSource, "export function installWaypointRefresh()");
check("views/sheet.js declares the installer at module scope", installer !== "");
check("…and it is what creates the derive", installer.includes("van.derive("));
check(
  "⚠️  it SAMPLES whether the sheet is open — `.val` would subscribe the refresh to every open and close",
  installer.includes("sheetOpen.rawVal") && !installer.includes("sheetOpen.val")
);
check("…and folds rather than fetching on every re-run", installer.includes("shouldRefreshOnWaypoint("));
check(
  "⚠️  it watches BOTH counters — a refusal moves only its own, and is the press this list is for",
  installer.includes('valueOf("waypoint_seq")') && installer.includes('valueOf("waypoint_refused_seq")')
);
check(
  "app.js installs it once, beside the announcements and not from inside a view",
  appSource.includes("installWaypointRefresh();")
);

// ⚠️ And the preview's own /waypoint. It stands in for the Pi, so a handler that bumps
// `STATUS.waypoints` without appending the event makes one tap in the design gate render
// "the bike kept only the newest N saves" — a truncation that never happened, on the screen
// a human is looking at to decide whether this ships. One file since #170 put the harness in
// scripts/preview-harness-*.js; it was two templates carrying a copy each.
const previewHandler = "scripts/preview-harness-pi.js";
const handlerSource = await readFile(join(ROOT, previewHandler), "utf8");
const handlerAt = handlerSource.indexOf('if (path === "/waypoint")');
const handlerBlock = handlerAt === -1 ? null : blockAt(handlerSource, handlerAt);
const handler = handlerBlock === null ? "" : handlerSource.slice(handlerBlock.start, handlerBlock.end + 1);
check(
  `${previewHandler}'s /waypoint appends the event, not just the count`,
  handler.includes("STATUS.waypoints += 1") && handler.includes("STATUS.waypointEvents.push(")
);

if (failures > 0) {
  console.error(`\n✗ ${failures} check${failures === 1 ? "" : "s"} failed`);
  process.exit(1);
}
console.log("\n✓ the waypoint list: the bike's log, the cap, the rows, the words and the refresh");
