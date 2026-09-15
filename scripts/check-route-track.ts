import Database from "better-sqlite3";
import { readFile } from "fs/promises";
import { boundsFor } from "../public/lib/bounds.js";
import { ROUTE_TRACK_INSERT_SQL, buildRouteTrack, routeTrackBuiltAt } from "./route-track.ts";

// The materialised route track, built by the code that ships and then read by the DASHBOARD'S
// OWN SQL, which is lifted out of grafana/dashboards/route-map.json rather than restated here.
//
//   node --experimental-strip-types scripts/check-route-track.ts
//
// What moved: the map used to rebuild the track from 15 M readings on every load, and the
// "GPS points mapped" tile wrapped that same query in a COUNT, so it ran twice. The rules did
// not change — scripts/route-track.ts runs them once at import time instead. This check is
// what says so: the same fixtures that exercise the carry-forward, the per-second collapse
// and the despiker also prove the panel reads the TABLE and not the readings.
// docs/route-map.md §"Materialised once, not per load".

const DASHBOARD = "grafana/dashboards/route-map.json";

/** Not a place. Round synthetic degrees, for the reason docs/route-map.md gives. */
const LATITUDE = 10;
const LONGITUDE = 20;

/** Epoch ms for the fixtures, far from the 2 000 000 000 000 guard every query carries. */
const BASE = 1_700_000_000_000;

/** A step the bike could plausibly take in a second: ~1.1 m at this latitude. */
const STEP_DEG = 0.00001;

interface Row {
  key: string;
  ts: number;
  value: number;
}

interface Target {
  refId: string;
  rawQueryText: string;
}

interface Panel {
  targets?: Target[];
  panels?: Panel[];
}

interface TrackRow {
  ts: number;
  lat: number;
  lon: number;
  speed: number | null;
}

let failures = 0;

const dashboard = JSON.parse(await readFile(DASHBOARD, "utf-8")) as { panels: Panel[] };
const targets = new Map<string, string>();
collectTargets(dashboard.panels);

console.log("1. the rules survive the move");

const straight = straightTrack(40);
const carried = databaseWith([
  { key: "gps_lon", ts: BASE, value: LONGITUDE },
  { key: "gps_lat", ts: BASE + 5_000, value: LATITUDE },
]);
const carriedTrack = trackOf(carried);
check(
  "a latitude logged alone is paired with the longitude carried forward onto it",
  carriedTrack.length === 1 && carriedTrack[0].ts === BASE + 5_000 && carriedTrack[0].lon === LONGITUDE
);

const sameSecond = databaseWith([
  { key: "gps_lat", ts: BASE, value: LATITUDE },
  { key: "gps_lon", ts: BASE, value: LONGITUDE },
  { key: "gps_lat", ts: BASE + 1, value: LATITUDE + STEP_DEG },
  { key: "gps_lon", ts: BASE + 1, value: LONGITUDE + STEP_DEG },
]);
const collapsed = trackOf(sameSecond);
check(
  "two fixes 1 ms apart become ONE point, the last of that second",
  collapsed.length === 1 && collapsed[0].ts === BASE + 1 && collapsed[0].lat === LATITUDE + STEP_DEG
);

// ⚠️ A lone excursion whose NEIGHBOURS AGREE WITH EACH OTHER — the shape test, not a range
// gate: the value is a perfectly legal longitude. docs/route-map.md §"Despiking by shape".
const spiked = straightTrack(40);
const spikeAt = BASE + 20_000;
for (const row of spiked) {
  if (row.ts === spikeAt && row.key === "gps_lon") {
    row.value += 1;
  }
}
const spikedTrack = trackOf(databaseWith(spiked));
check(
  "a lone excursion between two agreeing neighbours is rejected",
  spikedTrack.length === 39 && !spikedTrack.some(point => point.ts === spikeAt)
);

// ⚠️ THE FLOOR, and this fixture is the one that dies without it. Parked, the neighbours
// converge, d(prev, next) approaches zero and ANY ratio is satisfied by ordinary jitter.
const parked: Row[] = [];
for (let index = 0; index < 5; index += 1) {
  const jitter = index === 2 ? 0.0001 : 0;
  parked.push({ key: "gps_lat", ts: BASE + index * 1_000, value: LATITUDE + jitter });
  parked.push({ key: "gps_lon", ts: BASE + index * 1_000, value: LONGITUDE + jitter });
}
const parkedTrack = trackOf(databaseWith(parked));
check(
  "GPS jitter on a parked bike is KEPT — the 220 m floor, not the ratio",
  parkedTrack.length === 5 && parkedTrack.some(point => point.ts === BASE + 2_000)
);

const future = straightTrack(10);
future.push({ key: "gps_lat", ts: 2_840_000_000_000, value: LATITUDE + 50 });
future.push({ key: "gps_lon", ts: 2_840_000_000_000, value: LONGITUDE + 50 });
const futureTrack = trackOf(databaseWith(future));
check(
  "a row stamped 2060 never reaches the table",
  futureTrack.length === 10 && !futureTrack.some(point => point.ts > 2_000_000_000_000)
);

// The out-of-range sample comes FIRST, so nothing can carry a good value over it: at BASE the
// only speed ever logged is 999, and the point must still be drawn, colourless.
const speeds = straightTrack(3);
speeds.push({ key: "gps_speed_kmh", ts: BASE, value: 999 });
speeds.push({ key: "gps_speed_kmh", ts: BASE + 1_000, value: 42 });
const speedTrack = trackOf(databaseWith(speeds));
check(
  "a speed outside public/lib/bounds.js's range is NULL, never clamped into something plausible",
  speedTrack.length === 3 &&
    speedTrack[0].speed === null &&
    speedTrack[1].speed === 42 &&
    speedTrack[2].speed === 42 &&
    !speedTrack.some(point => point.speed === 999)
);

// ⚠️ This cannot catch the bound MOVING — both sides read the same declaration, by design.
// What it catches is the literal coming back: the SQL carried a hand-written `BETWEEN 0 AND
// 300` for as long as it lived in dashboard JSON, which cannot import, and inherited it into
// TypeScript along with a comment claiming it was the declared range.
const declaredSpeed = boundsFor("gps_speed_kmh", "km/h", "gps");
check(
  `the speed gate is built from the declared bound (${declaredSpeed?.join("…")}), not a literal`,
  declaredSpeed !== null &&
    declaredSpeed !== undefined &&
    ROUTE_TRACK_INSERT_SQL.includes(`BETWEEN ${declaredSpeed[0]} AND ${declaredSpeed[1]}`)
);

console.log("\n2. the collapse is enforced, not merely performed");

const enforced = databaseWith(straightTrack(3));
buildRouteTrack(enforced);
let secondRejected = false;
try {
  enforced
    .prepare("INSERT INTO route_track (ts, lat, lon, speed) VALUES (?, ?, ?, NULL)")
    .run(BASE + 500, LATITUDE, LONGITUDE);
} catch (error) {
  secondRejected = /route_track_second|UNIQUE/.test((error as Error).message);
}
// ⚠️ The PRIMARY KEY cannot do this. `ts` is MILLISECONDS, so two rows in one second are two
// legal rowids — an assertion that could never fire. The unique index on `ts / 1000` can.
check("a second point inside an existing second is refused by route_track_second", secondRejected);

const firstStamp = routeTrackBuiltAt(enforced);
const rebuilt = buildRouteTrack(enforced);
check(
  "the build stamps info.route_track_built_at and a rebuild refreshes it",
  firstStamp !== null && routeTrackBuiltAt(enforced) === rebuilt.builtAt && rebuilt.rows === 3
);

console.log("\n3. what the dashboard actually runs");

const windowFrom = BASE + 5_000;
const windowTo = BASE + 25_000;
const dashboardDb = databaseWith(straight);
buildRouteTrack(dashboardDb);
const drawn = dashboardDb.prepare(sqlFor("A", windowFrom, windowTo)).all() as { time: number }[];
const inWindow = dashboardDb
  .prepare("SELECT ts FROM route_track WHERE ts >= ? AND ts <= ? ORDER BY ts")
  .all(windowFrom, windowTo) as { ts: number }[];
check(
  `A draws exactly the table's rows in the window (${inWindow.length})`,
  drawn.length === inWindow.length && drawn.every((point, index) => point.time * 1000 === inWindow[index].ts)
);

const counted = dashboardDb.prepare(sqlFor("F", windowFrom, windowTo)).get() as Record<string, number>;
check(`F counts what A draws (${drawn.length})`, Object.values(counted)[0] === drawn.length && drawn.length > 0);

// ⚠️ THE ASSERTION THE WHOLE CHANGE RESTS ON, and the one a careless fixture cannot make.
// Everything above would pass just as well if A still carried the six-CTE pipeline over
// `reading`, because it would read the same fixtures and reach the same points. This row is
// in `reading` and NOT in `route_track`: the old query draws it, the new one cannot see it.
dashboardDb
  .prepare("INSERT INTO reading (ts, signal_id, value) VALUES (?, (SELECT id FROM signal WHERE key = ?), ?)")
  .run(windowFrom + 500, "gps_lat", LATITUDE + STEP_DEG * 100);
dashboardDb
  .prepare("INSERT INTO reading (ts, signal_id, value) VALUES (?, (SELECT id FROM signal WHERE key = ?), ?)")
  .run(windowFrom + 500, "gps_lon", LONGITUDE + STEP_DEG * 100);
const afterInsert = dashboardDb.prepare(sqlFor("A", windowFrom, windowTo)).all() as { time: number }[];
check(
  "a fix added to `reading` after the build is NOT drawn — A reads the table, not the readings",
  afterInsert.length === drawn.length && !afterInsert.some(point => point.time * 1000 === windowFrom + 500)
);

const bodyOfA = targets.get("A") ?? "";
const wrapperF = targets.get("F") ?? "";
check(
  "F still contains A's body verbatim, so an edit to A cannot leave the count behind",
  bodyOfA.length > 0 && wrapperF.includes(bodyOfA)
);
check(
  "neither A nor F rebuilds the pipeline — no per_second / neighbours / clean CTE survives",
  !/\b(per_second|neighbours|clean)\b/.test(bodyOfA) && !/\b(per_second|neighbours|clean)\b/.test(wrapperF)
);

console.log("\n4. the render budget still binds, and it is the window's own");

const bigDb = databaseWith(straightTrack(24_001));
buildRouteTrack(bigDb);
const thinned = bigDb.prepare(sqlFor("A", BASE, BASE + 24_001_000)).all() as { time: number }[];
check(
  `24 001 points thin to at most 12 000 (drew ${thinned.length}) and keep the first`,
  thinned.length > 0 && thinned.length <= 12_000 && thinned[0].time * 1000 === BASE
);

console.log(
  failures === 0
    ? "\n✓ the track is materialised once, the rules are unchanged, and the map reads the table"
    : `\n✗ the materialised route track — ${failures} failure${failures === 1 ? "" : "s"}`
);
process.exit(failures === 0 ? 0 : 1);

function check(what: string, condition: boolean): void {
  if (condition) {
    console.log(`  ✓ ${what}`);
  } else {
    console.error(`  ✗ ${what}`);
    failures += 1;
  }
}

function collectTargets(panels: Panel[]): void {
  for (const panel of panels) {
    for (const target of panel.targets ?? []) {
      targets.set(target.refId, target.rawQueryText);
    }
    if (panel.panels) {
      collectTargets(panel.panels);
    }
  }
}

function sqlFor(refId: string, fromMs: number, toMs: number): string {
  const sql = targets.get(refId);
  if (sql === undefined) {
    throw new Error(`${DASHBOARD} has no target ${refId} — the dashboard changed shape`);
  }
  return sql.replaceAll("$__from", String(fromMs)).replaceAll("$__to", String(toMs));
}

/** A bike going gently in a straight line, one fix a second: nothing here is a spike. */
function straightTrack(seconds: number): Row[] {
  const rows: Row[] = [];
  for (let index = 0; index < seconds; index += 1) {
    rows.push({ key: "gps_lat", ts: BASE + index * 1_000, value: LATITUDE + index * STEP_DEG });
    rows.push({ key: "gps_lon", ts: BASE + index * 1_000, value: LONGITUDE + index * STEP_DEG });
  }
  return rows;
}

/** src/db.ts's schema and nothing else, so the build runs against what decrypt-log.ts writes. */
function databaseWith(rows: Row[]): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE signal (id INTEGER PRIMARY KEY, key TEXT UNIQUE, unit TEXT, grp TEXT, source TEXT);
    CREATE TABLE session (id INTEGER PRIMARY KEY, uid TEXT UNIQUE);
    CREATE TABLE reading (
      ts INTEGER NOT NULL, signal_id INTEGER NOT NULL REFERENCES signal(id), value REAL NOT NULL,
      session_id INTEGER REFERENCES session(id), seq INTEGER, clock_trust TEXT
    );
    CREATE INDEX idx_reading_sig_ts ON reading(signal_id, ts);
    CREATE TABLE info (key TEXT PRIMARY KEY, value TEXT, ts INTEGER);
  `);
  const addSignal = db.prepare("INSERT INTO signal (key, unit, grp, source) VALUES (?, '', 'gps', 'stream')");
  for (const key of ["gps_lat", "gps_lon", "gps_speed_kmh"]) {
    addSignal.run(key);
  }
  const addReading = db.prepare(
    "INSERT INTO reading (ts, signal_id, value) VALUES (?, (SELECT id FROM signal WHERE key = ?), ?)"
  );
  const insert = db.transaction((all: Row[]) => {
    for (const row of all) {
      addReading.run(row.ts, row.key, row.value);
    }
  });
  insert(rows);
  return db;
}

/** Build, then read the table back in order. */
function trackOf(db: Database.Database): TrackRow[] {
  buildRouteTrack(db);
  return db.prepare("SELECT ts, lat, lon, speed FROM route_track ORDER BY ts").all() as TrackRow[];
}
