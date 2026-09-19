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
    checkTheInheritedFixGate();
    checkThePluggedInDrop();
    checkTheWitnessSkew();
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

  // A charge session breaks the line AND removes the fixes logged inside it. ⚠️ Two bugs lived
  // here, both "nothing happens". The break used to be an exact millisecond match against a
  // point's ts — on the real archive 0 of 50 charge starts equal a track timestamp and 48 of 50
  // fall strictly between two points, so it never fired; and the session's own fixes were still
  // drawn, 41 of 50 sessions and 17 044 points of stationary scatter. An earlier version of THIS
  // CHECK handed the builder a break at a point's ts — the one case the broken code caught — so
  // it passed while the feature did nothing on real data.
  const acrossCharge = pointsAt([0, 1000, 2000, 3000], 30);
  const between = buildTrackGeoJson(acrossCharge, [{ fromTs: 1400, toTs: 1600 }]);
  check("a charge session BETWEEN two points splits the line", between.features.length === 2);
  check(
    "and splits it there",
    between.features[0].geometry.coordinates.length === 2 && between.features[1].geometry.coordinates.length === 2
  );
  // Five points, not four: the fix at 2000 is INSIDE this session and is dropped, so with only
  // four the tail would be a single vertex and get filtered — one feature, for the right reason
  // but not the reason under test.
  const onPoint = buildTrackGeoJson(pointsAt([0, 1000, 2000, 3000, 4000], 30), [{ fromTs: 2000, toTs: 2000 }]);
  check("a session starting exactly on a point still splits", onPoint.features.length === 2);
  check(
    "and that point is dropped, not drawn as riding",
    onPoint.features.every(feature => feature.properties.fromTs !== 2000 && feature.properties.toTs !== 2000)
  );
  check(
    "every fix logged inside a session is dropped",
    buildTrackGeoJson(pointsAt([0, 1000, 2000, 3000, 4000], 30), [{ fromTs: 900, toTs: 3100 }]).features.every(
      feature => feature.geometry.coordinates.length === 2
    )
  );
  check(
    "a session covering everything leaves nothing to draw",
    buildTrackGeoJson(acrossCharge, [{ fromTs: -1, toTs: 99999 }]).features.length === 0
  );
  check(
    "a session before the first fix splits nothing",
    buildTrackGeoJson(acrossCharge, [{ fromTs: -9000, toTs: -5000 }]).features.length === 1
  );
  check(
    "a session after the last fix splits nothing",
    buildTrackGeoJson(acrossCharge, [{ fromTs: 90000, toTs: 99999 }]).features.length === 1
  );
  check(
    "two sessions in one gap split once each, not twice",
    buildTrackGeoJson(pointsAt([0, 1000, 2000, 3000], 30), [
      { fromTs: 1100, toTs: 1200 },
      { fromTs: 1300, toTs: 1400 },
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
  // ⚠️ NOT asserted behaviourally, on purpose: `route_track.ts` is the INTEGER PRIMARY KEY, so
  // SQLite returns these rows in ts order whether or not the query says so, and an assertion
  // on the returned order survives deleting the ORDER BY. The clause still belongs in the SQL
  // — the builder depends on it and a future WHERE could change the plan — so what is checked
  // is that it is still written down.
  check("the track query still orders by ts", TRACK_SQL.includes("ORDER BY ts"));

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
  const expectedWaypoints = Math.min(DEFAULT_SHAPE.rides, DEFAULT_SHAPE.waypoints) + 1;
  check(`finds all ${expectedWaypoints} waypoints`, waypoints.length === expectedWaypoints);
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
    // ⚠️ The track query was missing from this list AND from the guard. It reads route_track,
    // which scripts/route-track.ts already filters, so nothing was wrong today — but the loop
    // that proves the claim skipped the one query the claim was false about.
    ["track", TRACK_SQL],
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

/** A database with src/db.ts's schema and the signals these queries read. */
function emptyRideLog(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE signal (id INTEGER PRIMARY KEY, key TEXT UNIQUE, unit TEXT, grp TEXT, source TEXT);
    CREATE TABLE session (id INTEGER PRIMARY KEY, uid TEXT UNIQUE);
    CREATE TABLE reading (ts INTEGER NOT NULL, signal_id INTEGER NOT NULL REFERENCES signal(id),
                          value REAL NOT NULL, session_id INTEGER REFERENCES session(id), seq INTEGER);
    CREATE INDEX idx_reading_sig_ts ON reading(signal_id, ts);
    CREATE TABLE route_track (ts INTEGER PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL, speed REAL);
  `);
  for (const key of [
    "gps_lat",
    "gps_lon",
    "gps_speed_kmh",
    "odometer_can_km",
    "mains_a",
    "dc_a",
    "fast_dc_target_a",
    "residual_energy_wh",
    "soc",
    "waypoint_seq",
    "waypoint_lat",
    "waypoint_lon",
  ]) {
    db.prepare("INSERT INTO signal (key) VALUES (?)").run(key);
  }
  return db;
}

function plant(db: Database.Database, key: string, ts: number, value: number, sessionId: number | null): void {
  db.prepare(
    "INSERT INTO reading (ts, signal_id, value, session_id) VALUES (?, (SELECT id FROM signal WHERE key = ?), ?, ?)"
  ).run(ts, key, value, sessionId);
}

/**
 * 🚨 `IS`, NEVER `=`, on the session in the inherited-fix gate.
 *
 * The predicate sits inside `NOT EXISTS`, so an unknown comparison selects nothing, `NOT EXISTS`
 * is satisfied, and the corrupt row is never marked. `=` does not over-reject the GPS rows that
 * carry no session — it switches the gate OFF over them, silently. Measured over the real
 * archive: 57 rows marked under `IS`, 0 under `=`. Both rows below carry a NULL session, which
 * is the case that distinguishes them.
 */
function checkTheInheritedFixGate(): void {
  console.log("the inherited-fix gate");
  const db = emptyRideLog();
  const base = FIXTURE_BASE_MS;
  // ⚠️ The good rows sit SIX seconds back, not beside the corrupt one. The gate rejects any row
  // that another row within ±2 s disagrees with by >0.002°, so a candidate that merely sits
  // near the excursion is rejected too — which is the "up to two rows back" cost the archive
  // measures. A first version of this fixture put all three rows inside 800 ms, every one was
  // contradicted, and the query correctly returned NULL. Real GPS rows land ~550 ms apart and
  // an excursion lasts one row, so there is always a clean row a few seconds earlier.
  // ⚠️ THE CORRUPT ROW IS THE NEWEST ONE BEFORE PLUG-IN, and that is what makes this assertion
  // able to fail. A first version put a good row after the excursion, so the gate being OFF
  // still returned a good value and `=` survived the mutation — the assertion agreed with both
  // the working and the broken query. It is the last row before the charge that the gate has
  // to reject.
  plant(db, "gps_lat", base - 6000, 10.0, null);
  plant(db, "gps_lon", base - 6000, 20.0, null);
  plant(db, "gps_lat", base - 5000, 10.0, null);
  plant(db, "gps_lon", base - 5000, 20.0, null);
  plant(db, "gps_lat", base - 800, 10.0, null);
  plant(db, "gps_lon", base - 800, 20.0, null);
  plant(db, "gps_lat", base, 12.5, null);
  plant(db, "gps_lon", base, 20.0, null);
  for (let minute = 0; minute < 10; minute += 1) {
    plant(db, "mains_a", base + 2000 + minute * 60_000, 12, null);
  }
  const rows = db.prepare(CHARGE_SESSIONS_SQL).all() as { lat: number | null }[];
  check("the session is found", rows.length === 1);
  check(
    "and inherits the fix nothing contradicts, not the corrupt newest row",
    rows.length === 1 && rows[0].lat !== null && Math.abs(rows[0].lat - 10.0) < 0.0001
  );
  check(
    "which is NOT the corrupt value — `=` in place of `IS` would return it",
    rows.length === 1 && Math.abs((rows[0].lat ?? 0) - 12.5) > 0.5
  );
  db.close();
}

/**
 * Fixes logged WHILE PLUGGED IN are dropped outright.
 *
 * A stationary hour at a charger is not riding, and on the sessions where the hub stays awake
 * it would otherwise open the next ride with a long motionless prefix. The fixes below sit
 * inside the session, so the ride must end before it starts.
 */
function checkThePluggedInDrop(): void {
  console.log("fixes logged while plugged in");
  const db = emptyRideLog();
  const base = FIXTURE_BASE_MS;
  const rideEnd = base + 600_000;
  for (let second = 0; second <= 600; second += 1) {
    plant(db, "gps_lat", base + second * 1000, 10 + second * 0.0001, null);
  }
  const chargeStart = rideEnd + 60_000;
  for (let minute = 0; minute < 10; minute += 1) {
    plant(db, "mains_a", chargeStart + minute * 60_000, 12, null);
    // The hub stayed awake: fixes keep arriving through the whole session.
    plant(db, "gps_lat", chargeStart + minute * 60_000 + 1000, 10.06, null);
  }
  plant(db, "odometer_can_km", base, 1000, null);
  plant(db, "odometer_can_km", rideEnd, 1020, null);
  const rides = db.prepare(RIDES_SQL).all() as { startTs: number; endTs: number }[];
  check("one ride, not one that swallows the charge", rides.length === 1);
  check("and it ends before the session starts", rides.length === 1 && rides[0].endTs <= chargeStart);
  db.close();
}

/**
 * The 5-second skew is the whole waypoint gate.
 *
 * A waypoint copies liveState and `gps_lat`/`gps_lon` carry a 3 m deadband, so the fix logged
 * immediately before a waypoint IS the fix it copied — comparing against it proves nothing. A
 * witness closer than the skew must therefore not count as a witness at all.
 */
function checkTheWitnessSkew(): void {
  console.log("the waypoint witness skew");
  const db = emptyRideLog();
  const base = FIXTURE_BASE_MS;
  // The only nearby fixes are 1 s away — inside the skew — so nothing can vouch for this.
  plant(db, "gps_lat", base - 1000, 10.0, null);
  plant(db, "gps_lon", base - 1000, 20.0, null);
  plant(db, "waypoint_seq", base, 1, null);
  plant(db, "waypoint_lat", base, 10.0, null);
  plant(db, "waypoint_lon", base, 20.0, null);
  const tooClose = db.prepare(WAYPOINTS_SQL).all() as { verdict: string }[];
  check(
    "a witness inside the 5 s skew does not vouch for a waypoint",
    tooClose.length === 1 && tooClose[0].verdict === "no witness"
  );

  // Now a witness 10 s away that agrees: corroborated.
  plant(db, "gps_lat", base - 10_000, 10.0, null);
  plant(db, "gps_lon", base - 10_000, 20.0, null);
  plant(db, "gps_lat", base + 10_000, 10.0, null);
  plant(db, "gps_lon", base + 10_000, 20.0, null);
  const witnessed = db.prepare(WAYPOINTS_SQL).all() as { verdict: string }[];
  check("a witness outside it does", witnessed.length === 1 && witnessed[0].verdict === "on track");

  // And one that disagrees by more than 0.5°: contradicted.
  const other = emptyRideLog();
  plant(other, "gps_lat", base - 10_000, 13.0, null);
  plant(other, "gps_lon", base - 10_000, 20.0, null);
  plant(other, "waypoint_seq", base, 1, null);
  plant(other, "waypoint_lat", base, 10.0, null);
  plant(other, "waypoint_lon", base, 20.0, null);
  plant(other, "gps_lat", base + 10_000, 13.0, null);
  plant(other, "gps_lon", base + 10_000, 20.0, null);
  const contradicted = other.prepare(WAYPOINTS_SQL).all() as { verdict: string }[];
  check(
    "a witness that disagrees by more than 0.5 degrees contradicts it",
    contradicted.length === 1 && contradicted[0].verdict === "contradicted"
  );
  other.close();
  db.close();
}

function pointsAt(timestamps: number[], speed: number): TrackPoint[] {
  return timestamps.map((ts, index) => ({ ts, lat: 10 + index * 0.001, lon: 20 + index * 0.001, speed }));
}

await main();
