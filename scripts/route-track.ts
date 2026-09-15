import type Database from "better-sqlite3";

// The route map's track, computed once at import time instead of on every dashboard load.
//
// grafana/dashboards/route-map.json used to carry this whole pipeline in its `A` target, and
// `F` ("GPS points mapped") wrapped `A` verbatim to count its rows — so a load rebuilt the
// track from 15 M readings twice. Measured on the 2026-09-12 archive: A 5 152 ms, F 4 474 ms
// cold, against 78 ms and 66 ms reading this table. The rules are unchanged; only where they
// run moved. Every argument behind them — the carry-forward, the per-second collapse, the
// shape despiker and its 220 m floor — is derived in docs/route-map.md, which the blocks
// below point at rather than restate.
//
// ⚠️ WHAT MOVING IT CHANGES, stated because it is not nothing: the dashboard's query reached
// 10 minutes either side of its window to seed the carry-forward and to give the despiker a
// neighbour at each edge. Built over the whole archive there is no window, so the despiker
// now tests every point except the archive's own first and last — stronger — and the
// carry-forward is no longer truncated at the window edge, so a narrow window draws a few
// more points than it used to. docs/route-map.md §"Materialised once, not per load" has the
// per-window measurements.

/** What a build did, for the caller to print. */
export interface RouteTrackBuild {
  rows: number;
  ms: number;
  builtAt: string;
}

/** The `info` key holding when this table was last rebuilt, so a stale one can be spotted. */
export const ROUTE_TRACK_BUILT_AT = "route_track_built_at";

/**
 * Rebuilds `route_track` from `reading`, in one transaction.
 *
 * ⚠️ DROP and rebuild rather than append: the track is a pure function of the readings, and
 * an incremental build would have to reason about which points a new fix un-spikes. The
 * whole archive costs ~5 s, which is nothing beside the decrypt it follows.
 */
export function buildRouteTrack(db: Database.Database): RouteTrackBuild {
  const startedAt = process.hrtime.bigint();
  const builtAt = new Date().toISOString();
  let rows = 0;
  const rebuild = db.transaction(() => {
    db.exec("DROP TABLE IF EXISTS route_track");
    db.exec(CREATE_TABLE_SQL);
    db.exec(CREATE_SECOND_INDEX_SQL);
    rows = db.prepare(INSERT_SQL).run().changes;
    db.prepare(
      "INSERT INTO info (key, value, ts) VALUES (?, ?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, ts = excluded.ts"
    ).run(ROUTE_TRACK_BUILT_AT, builtAt, Date.now());
  });
  rebuild();
  return { rows, ms: Number(process.hrtime.bigint() - startedAt) / 1e6, builtAt };
}

/** When this database's track was last built, or null if it has never been. */
export function routeTrackBuiltAt(db: Database.Database): string | null {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'route_track'").get();
  if (table === undefined) {
    return null;
  }
  const row = db.prepare("SELECT value FROM info WHERE key = ?").get(ROUTE_TRACK_BUILT_AT) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

// `ts INTEGER PRIMARY KEY` is the rowid, so the dashboard's `WHERE ts BETWEEN` is a rowid
// range scan (`SEARCH route_track USING INTEGER PRIMARY KEY`) rather than an index lookup.
// lat/lon are NOT NULL because `paired` below joins them into existence; speed is nullable
// because an out-of-bounds reading becomes NULL rather than a clamped value.
const CREATE_TABLE_SQL = `CREATE TABLE route_track (
  ts    INTEGER PRIMARY KEY,
  lat   REAL NOT NULL,
  lon   REAL NOT NULL,
  speed REAL
)`;

// ⚠️ This index is the per-second collapse's only enforcement, and the PRIMARY KEY above is
// NOT a substitute: `ts` is milliseconds, so three rows in one second are three legal rowids
// and the constraint could never fire. Indexing `ts / 1000` makes "one point per second" a
// thing the build fails on rather than a thing the query is trusted to have done.
const CREATE_SECOND_INDEX_SQL = `CREATE UNIQUE INDEX route_track_second ON route_track (ts / 1000)`;

const INSERT_SQL = `INSERT INTO route_track (ts, lat, lon, speed)
-- gps_lat and gps_lon are SEPARATE log-on-change signals with independent deadbands: they
-- share a millisecond when a fix moves both, and a heading that moves one logs only that one.
-- An inner join on equal ts drops ~17.5 % of the track, so each is carried forward onto the
-- other's timestamps instead. docs/route-map.md §"Reconstructing a track from two independent
-- signals" has the row counts and §"The track is points, not a line" the rest.
WITH raw AS (
  SELECT r.ts AS ts,
         MAX(CASE WHEN s.key = 'gps_lat'       THEN r.value END) AS lat,
         MAX(CASE WHEN s.key = 'gps_lon'       THEN r.value END) AS lon,
         -- Gated to public/lib/bounds.js's declared range for this signal: out of range
         -- becomes NULL (no colour), never a clamped value that looks plausible.
         MAX(CASE WHEN s.key = 'gps_speed_kmh' AND r.value BETWEEN 0 AND 300
                  THEN r.value END) AS speed
  FROM reading r JOIN signal s ON s.id = r.signal_id
  WHERE s.key IN ('gps_lat', 'gps_lon', 'gps_speed_kmh')
    -- The 49 772 rows a corrupt GPS frame stamped 2060 (README.md §Clock) are not positions
    -- in any window, and every query in the dashboard guards against them by name.
    AND r.ts < 2000000000000
  GROUP BY r.ts
),
-- SQLite has no IGNORE NULLS, so carry-forward is "the timestamp of the last non-null",
-- joined back to the row that holds it.
held AS (
  SELECT ts,
         MAX(CASE WHEN lat   IS NOT NULL THEN ts END) OVER (ORDER BY ts) AS lat_ts,
         MAX(CASE WHEN lon   IS NOT NULL THEN ts END) OVER (ORDER BY ts) AS lon_ts,
         MAX(CASE WHEN speed IS NOT NULL THEN ts END) OVER (ORDER BY ts) AS speed_ts
  FROM raw
),
paired AS (
  SELECT h.ts AS ts, la.lat AS lat, lo.lon AS lon, sp.speed AS speed
  FROM held h
  JOIN raw la ON la.ts = h.lat_ts
  JOIN raw lo ON lo.ts = h.lon_ts
  LEFT JOIN raw sp ON sp.ts = h.speed_ts
),
-- One point per second, keeping the exact last sample of each second. Without it the
-- per-millisecond pivot emits a row at each signal's own timestamp, so a lat row and a lon
-- row 1 ms apart become two points metres apart -- a staircase that makes every implied
-- speed nonsense (7 m in 1 ms reads as 25 000 km/h) and destroys any speed-based outlier
-- test. docs/route-map.md §"One point per second, and why it matters more than it sounds".
per_second AS (
  SELECT ts, lat, lon, speed FROM (
    SELECT ts, lat, lon, speed,
           ROW_NUMBER() OVER (PARTITION BY ts / 1000 ORDER BY ts DESC) AS rn
    FROM paired
  ) WHERE rn = 1
),
neighbours AS (
  SELECT ts, lat, lon, speed,
         lat - LAG(lat)  OVER (ORDER BY ts)                AS dlat_prev,
         lon - LAG(lon)  OVER (ORDER BY ts)                AS dlon_prev,
         LEAD(lat) OVER (ORDER BY ts) - lat                AS dlat_next,
         LEAD(lon) OVER (ORDER BY ts) - lon                AS dlon_next,
         LEAD(lat) OVER (ORDER BY ts) - LAG(lat) OVER (ORDER BY ts) AS dlat_span,
         LEAD(lon) OVER (ORDER BY ts) - LAG(lon) OVER (ORDER BY ts) AS dlon_span
  FROM per_second
),
-- Spike rejection by SHAPE, deliberately not by coordinate range: the bad decode produces a
-- longitude with an extra leading digit, which is still a valid longitude, so a range test is
-- really a geography test and would bake this bike's region into a committed file. A spike is
-- a point far from both neighbours WHILE THE NEIGHBOURS AGREE WITH EACH OTHER -- so a bike
-- genuinely carried between two fixes is kept, because then the neighbours disagree too.
-- Scale-free (5x) rather than a tuned distance, and squared in degrees so nothing depends on
-- SQLITE_ENABLE_MATH_FUNCTIONS. The 0.000004 floor (220 m squared) is not a redundant belt:
-- the ratio degenerates where the neighbours converge, which is every second the bike sits
-- still. Measured over 65 481 points: ratio alone rejects 280, with the floor 17, and the 263
-- it saves are parked GPS jitter. Full derivation, and the two corrupt fixes that a time-step
-- gate let through, in docs/route-map.md §"Despiking by shape, not by speed and not by
-- coordinate range".
clean AS (
  SELECT ts, lat, lon, speed
  FROM neighbours
  WHERE NOT (dlat_prev IS NOT NULL AND dlat_next IS NOT NULL
             AND (dlat_prev * dlat_prev + dlon_prev * dlon_prev)
                 > 25 * (dlat_span * dlat_span + dlon_span * dlon_span)
             AND (dlat_next * dlat_next + dlon_next * dlon_next)
                 > 25 * (dlat_span * dlat_span + dlon_span * dlon_span)
             AND (dlat_prev * dlat_prev + dlon_prev * dlon_prev) > 0.000004
             AND (dlat_next * dlat_next + dlon_next * dlon_next) > 0.000004)
)
SELECT ts, lat, lon, speed FROM clean ORDER BY ts`;
