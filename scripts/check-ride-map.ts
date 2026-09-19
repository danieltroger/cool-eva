import Database from "better-sqlite3";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { buildMapFixture, DEFAULT_SHAPE, FIXTURE_BASE_MS } from "./map-fixture.ts";
import { CHARGE_SESSIONS_SQL, RIDES_SQL, TRACK_SQL, WAYPOINTS_SQL } from "../map/src/lib/server/queries.ts";
import { boundsOfRange, buildTrackGeoJson, bandOf, GAP_MS, type TrackPoint } from "../map/src/lib/track.ts";

// The laptop map viewer's SQL and its track builder, against a synthetic ride log.
//
//   node --experimental-strip-types scripts/check-ride-map.ts
//
// ⚠️ THE QUERIES ARE THE VIEWER'S OWN, imported rather than restated, so a check that passes
// is a check about what the server will actually run — the same argument
// scripts/check-route-map-sql.ts makes for reading Grafana's SQL out of the dashboard JSON.
//
// The fixture is synthetic because the real archive cannot be committed or screenshotted; see
// scripts/map-fixture.ts.

let failures = 0;

function check(what: string, condition: boolean): void {
  if (condition) {
    console.log(`  ✓ ${what}`);
  } else {
    console.error(`  ✗ ${what}`);
    failures += 1;
  }
}

async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ride-map-check-"));
  const databasePath = join(directory, "fixture.db");
  const db = buildMapFixture(databasePath);
  try {
    checkTheTrackBuilder();
    checkTheQueries(db);
    checkTheYear2060Guard();
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.error(`\n✗ ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\n✓ ride map: track builder, unbounded queries and the 2060 guard");
}

/**
 * The pure part, driven by hand-built points so each rule is exercised on its own.
 *
 * ⚠️ Every assertion below is written to FAIL if the rule it covers is removed — a check whose
 * expectation is derived from the thing under test can never fire. The counts are literals
 * worked out by hand, not read back from `buildTrackGeoJson`.
 */
function checkTheTrackBuilder(): void {
  console.log("track builder");

  // Six points at one-second spacing, all in one speed band: one feature, six vertices.
  const steady = pointsAt([0, 1000, 2000, 3000, 4000, 5000], 30);
  const steadyResult = buildTrackGeoJson(steady, []);
  check("a steady run is one feature", steadyResult.features.length === 1);
  check("and keeps every point", steadyResult.features[0].geometry.coordinates.length === 6);

  // A hole longer than GAP_MS must break the line rather than draw across it.
  const gapped = pointsAt([0, 1000, GAP_MS + 2000, GAP_MS + 3000], 30);
  check("a gap longer than GAP_MS splits the line", buildTrackGeoJson(gapped, []).features.length === 2);
  const notGapped = pointsAt([0, 1000, GAP_MS - 1000, GAP_MS], 30);
  check("a gap shorter than GAP_MS does not", buildTrackGeoJson(notGapped, []).features.length === 1);

  // A charge session breaks it too. ⚠️ THE BREAK FALLS BETWEEN TWO POINTS, which is the only
  // shape that occurs: charge starts come from mains_a/dc_a/fast_dc_target_a rows and track
  // points from per-second GPS, so on the real archive 0 of 50 charge starts equal a track
  // timestamp and 48 of 50 land strictly between two. An earlier version of this check handed
  // the builder a break AT a point's ts — the only case the old exact-match code could catch —
  // so it passed while the feature never fired on real data.
  const acrossCharge = pointsAt([0, 1000, 2000, 3000], 30);
  const between = buildTrackGeoJson(acrossCharge, [{ atTs: 1500, reason: "charge" }]);
  check("a charge stop BETWEEN two points splits the line", between.features.length === 2);
  check(
    "and splits it there",
    between.features[0].geometry.coordinates.length === 2 && between.features[1].geometry.coordinates.length === 2
  );
  const onPoint = buildTrackGeoJson(acrossCharge, [{ atTs: 2000, reason: "charge" }]);
  check("a break exactly on a point still splits", onPoint.features.length === 2);
  check(
    "a break before the first point splits nothing",
    buildTrackGeoJson(acrossCharge, [{ atTs: -5000, reason: "charge" }]).features.length === 1
  );
  check(
    "a break after the last point splits nothing",
    buildTrackGeoJson(acrossCharge, [{ atTs: 99999, reason: "charge" }]).features.length === 1
  );
  check(
    "two breaks in one gap split once, not twice",
    buildTrackGeoJson(acrossCharge, [
      { atTs: 1200, reason: "charge" },
      { atTs: 1800, reason: "charge" },
    ]).features.length === 2
  );

  // Framing a ride cannot go through charge stops: RIDES_SQL drops fixes logged while plugged
  // in and starts a new ride at every charge, so rides and sessions are disjoint BY
  // CONSTRUCTION — 0 of 69 rides on the real archive contain one. The bounds must therefore
  // come from the track itself, and a ride with no stop in it must still frame.
  const ridden = buildTrackGeoJson(pointsAt([0, 1000, 2000, 3000, 4000], 30), []);
  const framed = boundsOfRange(ridden.features, 0, 4000);
  check("a ride with zero charge stops still yields bounds", framed !== null);
  check(
    "and those bounds span the ride's own points",
    framed !== null && framed[0] < framed[2] && framed[1] < framed[3]
  );
  check(
    "a range with nothing in it yields null rather than a bogus box",
    boundsOfRange(ridden.features, 10_000_000, 20_000_000) === null
  );
  check("a segment straddling the range edge counts", boundsOfRange(ridden.features, 3500, 20_000_000) !== null);

  // Crossing a band edge starts a new feature, and the two share the boundary vertex so the
  // drawn line has no hole in it.
  const accelerating: TrackPoint[] = [
    { ts: 0, lat: 1, lon: 1, speed: 10 },
    { ts: 1000, lat: 1.1, lon: 1, speed: 10 },
    { ts: 2000, lat: 1.2, lon: 1, speed: 60 },
    { ts: 3000, lat: 1.3, lon: 1, speed: 60 },
  ];
  const banded = buildTrackGeoJson(accelerating, []);
  check("a band change splits the line", banded.features.length === 2);
  check("the two segments share the boundary vertex", banded.features[0].geometry.coordinates.length === 3);
  check("and carry different bands", banded.features[0].properties.band !== banded.features[1].properties.band);

  // A lone point cannot be a LineString; MapLibre drops such a feature silently.
  const isolated = buildTrackGeoJson(pointsAt([0, GAP_MS * 2], 30), []);
  check("an isolated point is dropped rather than emitted as a one-vertex line", isolated.features.length === 0);
  check(
    "no feature ever has fewer than two vertices",
    [steadyResult, between, onPoint, banded].every(result =>
      result.features.every(feature => feature.geometry.coordinates.length >= 2)
    )
  );

  check("a null speed is its own band", bandOf(null) === -1 && bandOf(0) === 0);
  check("band edges are inclusive at the bottom", bandOf(20) === 1 && bandOf(19.9) === 0);
  check("the top band has no ceiling", bandOf(500) === bandOf(110));
  check("empty input is an empty collection", buildTrackGeoJson([], []).features.length === 0);
}

/** The viewer's own SQL, against the fixture, asserting what the fixture was built to contain. */
function checkTheQueries(db: Database.Database): void {
  console.log("unbounded queries");

  const track = db.prepare(TRACK_SQL).all() as TrackPoint[];
  check(
    "the track query returns every materialised point",
    track.length === DEFAULT_SHAPE.rides * DEFAULT_SHAPE.fixesPerRide
  );
  check(
    "in time order",
    track.every((point, index) => index === 0 || point.ts > track[index - 1].ts)
  );

  const charges = db.prepare(CHARGE_SESSIONS_SQL).all() as {
    startTs: number;
    lat: number | null;
    whAdded: number;
    chargeType: string;
    fixTs: number | null;
  }[];
  check(`finds all ${DEFAULT_SHAPE.charges} charge stops`, charges.length === DEFAULT_SHAPE.charges);
  check(
    "each has energy added",
    charges.every(charge => charge.whAdded > 0)
  );
  check(
    "AC and DC are told apart by fast_dc_target_a",
    charges.filter(c => c.chargeType === "DC").length === 1 && charges.filter(c => c.chargeType === "AC").length === 2
  );
  // The bike logs no GPS while charging, so every stop's position is inherited from before it.
  check(
    "every stop inherits a position from before it",
    charges.every(charge => charge.lat !== null)
  );
  check(
    "and reports how old that fix was",
    charges.every(charge => charge.fixTs !== null && charge.fixTs < charge.startTs)
  );

  const rides = db.prepare(RIDES_SQL).all() as { startTs: number; km: number | null; fixes: number }[];
  check(`splits into ${DEFAULT_SHAPE.rides} rides`, rides.length === DEFAULT_SHAPE.rides);
  check(
    "each carries an odometer distance",
    rides.every(ride => ride.km !== null && ride.km > 0)
  );
  check(
    "and its own fix count",
    rides.every(ride => ride.fixes > 0)
  );

  const waypoints = db.prepare(WAYPOINTS_SQL).all() as { verdict: string; lat: number | null }[];
  check(
    `finds all ${DEFAULT_SHAPE.waypoints + 1} waypoints`,
    waypoints.length === Math.min(DEFAULT_SHAPE.rides, DEFAULT_SHAPE.waypoints) + 1
  );
  check(
    "and refuses exactly the one the track contradicts",
    waypoints.filter(point => point.verdict === "contradicted").length === 1
  );
  check(
    "while corroborating the rest",
    waypoints.filter(point => point.verdict === "on track").length === waypoints.length - 1
  );
}

/**
 * 🚨 The viewer's queries have no `$__to`, so this guard is the ONLY thing excluding the 49 772
 * readings a corrupt GPS frame stamped in 2060. The dashboard had two guards and could afford
 * to lose one; this cannot. A grep is a weak test, so it is paired with a row that proves the
 * predicate actually bites.
 */
function checkTheYear2060Guard(): void {
  console.log("the 2060 guard");
  const queries: [string, string][] = [
    ["charge sessions", CHARGE_SESSIONS_SQL],
    ["rides", RIDES_SQL],
    ["waypoints", WAYPOINTS_SQL],
  ];
  for (const [name, sql] of queries) {
    check(`${name} still guards ts < 2000000000000`, sql.includes("2000000000000"));
  }

  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE signal (id INTEGER PRIMARY KEY, key TEXT UNIQUE, unit TEXT, grp TEXT, source TEXT);
    CREATE TABLE session (id INTEGER PRIMARY KEY, uid TEXT UNIQUE);
    CREATE TABLE reading (ts INTEGER NOT NULL, signal_id INTEGER NOT NULL REFERENCES signal(id),
                          value REAL NOT NULL, session_id INTEGER REFERENCES session(id), seq INTEGER);
    INSERT INTO signal (key) VALUES ('waypoint_seq'), ('waypoint_lat'), ('waypoint_lon'), ('gps_lat'), ('gps_lon');
  `);
  const insert = db.prepare(
    "INSERT INTO reading (ts, signal_id, value) VALUES (?, (SELECT id FROM signal WHERE key = ?), ?)"
  );
  // One ordinary waypoint, and one stamped in 2060 the way the corrupt frame stamped them.
  insert.run(FIXTURE_BASE_MS, "waypoint_seq", 1);
  insert.run(FIXTURE_BASE_MS, "waypoint_lat", 10);
  insert.run(FIXTURE_BASE_MS, "waypoint_lon", 20);
  const year2060 = 2_859_000_000_000;
  insert.run(year2060, "waypoint_seq", 2);
  insert.run(year2060, "waypoint_lat", 10);
  insert.run(year2060, "waypoint_lon", 20);
  const rows = db.prepare(WAYPOINTS_SQL).all() as { ts: number }[];
  check("a 2060-stamped waypoint is excluded by the guard, not merely sorted late", rows.length === 1);
  check("and the real one survives", rows.length === 1 && rows[0].ts === FIXTURE_BASE_MS);
  db.close();
}

function pointsAt(timestamps: number[], speed: number): TrackPoint[] {
  return timestamps.map((ts, index) => ({ ts, lat: 10 + index * 0.001, lon: 20 + index * 0.001, speed }));
}

await main();
