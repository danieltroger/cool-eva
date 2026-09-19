import Database from "better-sqlite3";

// A synthetic ride log shaped exactly like `rides.db`, for the map viewer's check script and
// for the screenshots that go in a pull request.
//
// ⚠️ IT EXISTS BECAUSE THE REAL ARCHIVE CANNOT BE SHOWN. .gitignore says it plainly — "a map
// PNG in a public repo is a published GPS trace" — so every committed image of this viewer is
// rendered from these coordinates and never from Daniel's. The degrees below are round and
// arbitrary, the same convention scripts/check-route-map-sql.ts uses: they are not a place.

/** Not a place. Round synthetic degrees in the middle of nowhere. */
const ORIGIN_LAT = 10;
const ORIGIN_LON = 20;

/** Epoch ms for the fixture — far from the 2060 rows the real queries guard against. */
export const FIXTURE_BASE_MS = 1_700_000_000_000;

export interface FixtureShape {
  /** Rides to synthesise, each a run of one-second fixes. */
  rides: number;
  fixesPerRide: number;
  /** Charge stops, dropped between rides. */
  charges: number;
  waypoints: number;
}

// ⚠️ `fixesPerRide` is 1800 (a 30-minute ride at 1 Hz) and not a round 900, because the two
// thresholds pull in opposite directions. The GPS hole a charge leaves — 2 min + 20–24 min +
// 2 min — must stay UNDER the 30-minute gap rule so that only the charge rule can split these
// rides. But consecutive charge sessions merge when they are under 30 minutes apart, and that
// distance is the ride between them: at 900 fixes they were 19 minutes apart and all three
// stops collapsed into one 103-minute session. 1800 puts them 34 minutes apart.
export const DEFAULT_SHAPE: FixtureShape = { rides: 4, fixesPerRide: 1800, charges: 3, waypoints: 5 };

/**
 * Builds the fixture at `path`, replacing whatever is there.
 *
 * The schema is `src/db.ts`'s, plus the `route_track` table `scripts/route-track.ts`
 * materialises — the viewer reads both, so a fixture missing either would pass a check the
 * real database fails.
 */
export function buildMapFixture(path: string, shape: FixtureShape = DEFAULT_SHAPE): Database.Database {
  const db = new Database(path);
  db.exec(`
    DROP TABLE IF EXISTS reading; DROP TABLE IF EXISTS signal;
    DROP TABLE IF EXISTS session; DROP TABLE IF EXISTS route_track; DROP TABLE IF EXISTS info;
    CREATE TABLE signal (id INTEGER PRIMARY KEY, key TEXT UNIQUE, unit TEXT, grp TEXT, source TEXT);
    CREATE TABLE session (id INTEGER PRIMARY KEY, uid TEXT UNIQUE);
    CREATE TABLE reading (ts INTEGER NOT NULL, signal_id INTEGER NOT NULL REFERENCES signal(id),
                          value REAL NOT NULL, session_id INTEGER REFERENCES session(id), seq INTEGER);
    CREATE INDEX idx_reading_sig_ts ON reading(signal_id, ts);
    CREATE TABLE info (key TEXT PRIMARY KEY, value TEXT, ts INTEGER);
    CREATE TABLE route_track (ts INTEGER PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL, speed REAL);
    CREATE UNIQUE INDEX route_track_second ON route_track (ts / 1000);
  `);

  const signalId = new Map<string, number>();
  const insertSignal = db.prepare("INSERT INTO signal (key, unit, grp, source) VALUES (?, '', 'fixture', 'fixture')");
  for (const key of SIGNAL_KEYS) {
    signalId.set(key, Number(insertSignal.run(key).lastInsertRowid));
  }
  const sessionId = Number(db.prepare("INSERT INTO session (uid) VALUES ('fixture-run')").run().lastInsertRowid);
  const insertReading = db.prepare("INSERT INTO reading (ts, signal_id, value, session_id) VALUES (?, ?, ?, ?)");
  const insertTrack = db.prepare("INSERT INTO route_track (ts, lat, lon, speed) VALUES (?, ?, ?, ?)");

  const plan = db.transaction(() => {
    let ts = FIXTURE_BASE_MS;
    let lat = ORIGIN_LAT;
    let lon = ORIGIN_LON;
    let odometer = 1000;
    let energyWh = 12000;
    let stateOfCharge = 80;
    let waypointsWritten = 0;

    for (let ride = 0; ride < shape.rides; ride += 1) {
      for (let step = 0; step < shape.fixesPerRide; step += 1) {
        // A speed profile that crosses every band, so the banded colouring is exercised.
        const speed = 10 + 55 * (1 + Math.sin((step / shape.fixesPerRide) * Math.PI * 3)) * 0.9;
        lat += (speed / 3.6 / 111320) * Math.cos(step / 90);
        lon += (speed / 3.6 / 111320) * Math.sin(step / 90);
        odometer += speed / 3600;
        insertTrack.run(ts, lat, lon, speed);
        insertReading.run(ts, signalId.get("gps_lat"), lat, sessionId);
        insertReading.run(ts, signalId.get("gps_lon"), lon, sessionId);
        insertReading.run(ts, signalId.get("gps_speed_kmh"), speed, sessionId);
        if (step % 60 === 0) {
          insertReading.run(ts, signalId.get("odometer_can_km"), odometer, sessionId);
        }
        if (
          waypointsWritten < shape.waypoints &&
          step === Math.floor(shape.fixesPerRide / 2) &&
          ride < shape.waypoints
        ) {
          waypointsWritten += 1;
          insertReading.run(ts, signalId.get("waypoint_seq"), waypointsWritten, sessionId);
          insertReading.run(ts, signalId.get("waypoint_lat"), lat, sessionId);
          insertReading.run(ts, signalId.get("waypoint_lon"), lon, sessionId);
        }
        ts += 1000;
      }
      // A charge stop between rides: current flows, energy and SOC rise, no GPS is logged —
      // which is what makes the stop inherit the last fix from before it, as the real bike does.
      //
      // ⚠️ THE SURROUNDING GAPS ARE DELIBERATELY SHORT. 2 min + 20–24 min + 2 min keeps every
      // charge-shaped hole in the GPS under the 30-minute gap rule, so the ONLY thing that can
      // split these rides is the charge rule itself. An earlier fixture left 35 minutes after the
      // stop, the gap rule split them regardless, and scripts/check-ride-map.ts's ride count
      // passed with the charge-split clause deleted — an assertion that could not fail.
      if (ride < shape.charges) {
        ts += 2 * 60 * 1000;
        const direct = ride % 2 === 1;
        const minutes = 20 + ride * 2;
        for (let minute = 0; minute < minutes; minute += 1) {
          const key = direct ? "fast_dc_target_a" : "mains_a";
          insertReading.run(ts, signalId.get(key), direct ? 60 : 12, sessionId);
          energyWh += direct ? 900 : 200;
          stateOfCharge = Math.min(100, stateOfCharge + (direct ? 1.4 : 0.3));
          insertReading.run(ts, signalId.get("residual_energy_wh"), energyWh, sessionId);
          insertReading.run(ts, signalId.get("soc"), stateOfCharge, sessionId);
          ts += 60 * 1000;
        }
        ts += 2 * 60 * 1000;
      } else {
        ts += 45 * 60 * 1000;
      }
    }

    // One waypoint the track contradicts, so the "listed but not drawn" path is exercised by
    // the check and visible in a screenshot. 3° away is far past the 0.5° gate.
    const strayTs = ts + 60 * 60 * 1000;
    insertReading.run(strayTs, signalId.get("gps_lat"), lat, sessionId);
    insertReading.run(strayTs, signalId.get("gps_lon"), lon, sessionId);
    insertReading.run(strayTs + 10_000, signalId.get("waypoint_seq"), shape.waypoints + 1, sessionId);
    insertReading.run(strayTs + 10_000, signalId.get("waypoint_lat"), lat + 3, sessionId);
    insertReading.run(strayTs + 10_000, signalId.get("waypoint_lon"), lon + 3, sessionId);
    insertReading.run(strayTs + 20_000, signalId.get("gps_lat"), lat, sessionId);
    insertReading.run(strayTs + 20_000, signalId.get("gps_lon"), lon, sessionId);

    db.prepare("INSERT INTO info (key, value, ts) VALUES ('route_track_built_at', ?, ?)").run(
      new Date(FIXTURE_BASE_MS).toISOString(),
      FIXTURE_BASE_MS
    );
  });
  plan();
  return db;
}

const SIGNAL_KEYS = [
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
];
