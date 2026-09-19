// The ride log's own queries, lifted from grafana/dashboards/route-map.json and run UNBOUNDED.
//
// ⚠️ Every `$__from`/`$__to` is gone on purpose: the viewer builds one snapshot over the whole
// archive and slices it in the browser, so there is no window at build time. That removes the
// two window-edge bugs docs/route-map.md derives — a session straddling `$__from` clipped
// rather than excluded, and the despiker's missing neighbour — rather than re-inheriting them.
//
// 🚨 `r.ts < 2000000000000` IS NOW THE ONLY GUARD ON THE 2060 ROWS. A corrupt GPS frame stepped
// the Pi's clock and stamped 49 772 readings in 2060 (README.md §Clock), on exactly the signals
// these queries read. The dashboard excluded them twice — by this guard AND by defaulting to a
// relative `now-90d → now` window that they sort after. Dropping the window drops the second
// guard, so this one is load-bearing and must not be tidied away.

/**
 * Runs of real charging current, with the position each stop inherits.
 *
 * Built from current and not from `charger_enabled`, which is log-on-change and stays at 1 for
 * days after the bike sleeps mid-session. `fast_dc_target_a` is the DC-side current and `dc_a`
 * is not — docs/route-map.md §"`fast_dc_target_a` is the DC current" measures what leaving it
 * out costs. Unlike the dashboard's map query this keeps sessions with NO position: the tiles
 * are supposed to count every stop, and filtering here is what once made them under-report.
 */
export const CHARGE_SESSIONS_SQL = `
WITH evidence AS (
  SELECT r.ts AS ts
  FROM reading r JOIN signal s ON s.id = r.signal_id
  WHERE s.key IN ('mains_a', 'dc_a', 'fast_dc_target_a') AND r.value > 0.5
    AND r.ts < 2000000000000
),
flagged AS (
  SELECT ts, CASE WHEN ts - LAG(ts) OVER (ORDER BY ts) < 1800000 THEN 0 ELSE 1 END AS is_new
  FROM evidence
),
grouped AS (
  SELECT ts, SUM(is_new) OVER (ORDER BY ts ROWS UNBOUNDED PRECEDING) AS g FROM flagged
),
sess AS (
  SELECT MIN(ts) AS start_ts, MAX(ts) AS end_ts
  FROM grouped GROUP BY g
  HAVING MAX(ts) - MIN(ts) >= 300000
),
detail AS (
  SELECT start_ts, end_ts,
         (SELECT MAX(r.value) FROM reading r JOIN signal s ON s.id = r.signal_id
          WHERE s.key = 'fast_dc_target_a'
            AND r.ts BETWEEN sess.start_ts AND sess.end_ts) AS max_fast_dc_a,
         (SELECT MAX(r.value) FROM reading r JOIN signal s ON s.id = r.signal_id
          WHERE s.key = 'mains_a' AND r.ts BETWEEN sess.start_ts AND sess.end_ts) AS max_mains_a,
         ${inheritedFix('gps_lat', 'r.value')} AS lat,
         ${inheritedFix('gps_lon', 'r.value')} AS lon,
         ${inheritedFix('gps_lat', 'r.ts')} AS fix_ts,
         (SELECT r.value FROM reading r JOIN signal s ON s.id = r.signal_id
          WHERE s.key = 'residual_energy_wh' AND r.ts <= sess.end_ts
          ORDER BY r.ts DESC LIMIT 1)
       - (SELECT r.value FROM reading r JOIN signal s ON s.id = r.signal_id
          WHERE s.key = 'residual_energy_wh' AND r.ts <= sess.start_ts
          ORDER BY r.ts DESC LIMIT 1) AS wh_added,
         (SELECT r.value FROM reading r JOIN signal s ON s.id = r.signal_id
          WHERE s.key = 'soc' AND r.ts <= sess.end_ts ORDER BY r.ts DESC LIMIT 1) AS soc_end,
         (SELECT r.value FROM reading r JOIN signal s ON s.id = r.signal_id
          WHERE s.key = 'soc' AND r.ts <= sess.start_ts ORDER BY r.ts DESC LIMIT 1) AS soc_start
  FROM sess
)
SELECT start_ts AS startTs, end_ts AS endTs, lat, lon, fix_ts AS fixTs,
       COALESCE(wh_added, 0) AS whAdded, soc_start AS socStart, soc_end AS socEnd,
       CASE WHEN COALESCE(max_fast_dc_a, 0) > 2 THEN 'DC'
            WHEN COALESCE(max_mains_a, 0) > 0.5 THEN 'AC'
            ELSE '?' END AS chargeType
FROM detail ORDER BY start_ts`;

/**
 * Runs of GPS fixes, split by a 30-minute hole AND by every charge session.
 *
 * A charge stop ends a ride: before that rule one evening read as a single 281-minute ride
 * with a 21-minute DC stop counted as riding time. `km` is the bike's own odometer delta, so
 * it stays right where reception did not.
 */
export const RIDES_SQL = `
WITH evidence AS (
  SELECT r.ts AS ts
  FROM reading r JOIN signal s ON s.id = r.signal_id
  WHERE s.key IN ('mains_a', 'dc_a', 'fast_dc_target_a') AND r.value > 0.5
    AND r.ts < 2000000000000
),
flagged AS (
  SELECT ts, CASE WHEN ts - LAG(ts) OVER (ORDER BY ts) < 1800000 THEN 0 ELSE 1 END AS is_new
  FROM evidence
),
grouped AS (
  SELECT ts, SUM(is_new) OVER (ORDER BY ts ROWS UNBOUNDED PRECEDING) AS g FROM flagged
),
sess AS (
  SELECT MIN(ts) AS start_ts, MAX(ts) AS end_ts
  FROM grouped GROUP BY g HAVING MAX(ts) - MIN(ts) >= 300000
),
-- Fixes logged while plugged in are dropped outright: a stationary hour at a charger is not
-- riding, and on the sessions where the hub stays awake it would open the next ride with a
-- long motionless prefix.
pts AS (
  SELECT r.ts AS ts
  FROM reading r JOIN signal s ON s.id = r.signal_id
  WHERE s.key = 'gps_lat' AND r.ts < 2000000000000
    AND NOT EXISTS (SELECT 1 FROM sess WHERE r.ts BETWEEN sess.start_ts AND sess.end_ts)
),
stream AS (
  SELECT ts, 0 AS is_charge FROM pts
  UNION ALL
  SELECT start_ts AS ts, 1 AS is_charge FROM sess
),
tagged AS (
  SELECT ts, is_charge,
         MAX(CASE WHEN is_charge = 1 THEN ts END) OVER (ORDER BY ts) AS last_charge_ts
  FROM stream
),
fixes AS (SELECT ts, last_charge_ts FROM tagged WHERE is_charge = 0),
ride_flagged AS (
  SELECT ts,
         CASE WHEN LAG(ts) OVER (ORDER BY ts) IS NULL THEN 1
              WHEN ts - LAG(ts) OVER (ORDER BY ts) >= 1800000 THEN 1
              WHEN last_charge_ts > LAG(ts) OVER (ORDER BY ts) THEN 1
              ELSE 0 END AS is_new
  FROM fixes
),
ride_grouped AS (SELECT ts, SUM(is_new) OVER (ORDER BY ts ROWS UNBOUNDED PRECEDING) AS g FROM ride_flagged),
ride AS (
  SELECT MIN(ts) AS start_ts, MAX(ts) AS end_ts, COUNT(*) AS fixes
  FROM ride_grouped GROUP BY g HAVING MAX(ts) - MIN(ts) >= 300000
)
SELECT start_ts AS startTs, end_ts AS endTs, fixes,
       ROUND((SELECT MAX(r.value) - MIN(r.value) FROM reading r JOIN signal s ON s.id = r.signal_id
              WHERE s.key = 'odometer_can_km' AND r.ts BETWEEN ride.start_ts AND ride.end_ts), 1) AS km,
       ROUND((SELECT MAX(r.value) FROM reading r JOIN signal s ON s.id = r.signal_id
              WHERE s.key = 'gps_speed_kmh' AND r.value BETWEEN 0 AND 300
                AND r.ts BETWEEN ride.start_ts AND ride.end_ts), 0) AS topKmh
FROM ride ORDER BY start_ts`;

/**
 * Every waypoint, with the verdict the surrounding track gives it.
 *
 * Driven by `waypoint_seq` rather than pivoting the three signals: `record()` suppresses a
 * value equal to the last one logged and the coordinates carry no deadband, so a second save
 * from one live fix writes only the sequence, and a pivot would hand the map a NULL position
 * and the table an accusation. docs/waypoints.md has the gate's two constants.
 */
export const WAYPOINTS_SQL = `
WITH wp AS (
  SELECT r.ts AS ts, r.value AS seq,
         CASE WHEN sess.uid LIKE 'recovered-%' THEN 'recovered' ELSE 'live' END AS provenance
  FROM reading r JOIN signal s ON s.id = r.signal_id
       LEFT JOIN session sess ON sess.id = r.session_id
  WHERE s.key = 'waypoint_seq' AND r.ts < 2000000000000
),
placed AS (
  SELECT ts, seq, provenance,
         ${lastValueAtOrBefore('waypoint_lat')} AS lat,
         ${lastValueAtOrBefore('waypoint_lon')} AS lon
  FROM wp
),
witnessed AS (
  SELECT ts, seq, provenance, lat, lon,
         ${witness('gps_lat', 'before')} AS lat_before,
         ${witness('gps_lat', 'after')} AS lat_after,
         ${witness('gps_lon', 'before')} AS lon_before,
         ${witness('gps_lon', 'after')} AS lon_after
  FROM placed
)
SELECT ts, seq, provenance, lat, lon,
       CASE
         WHEN lat IS NULL OR lon IS NULL THEN 'no position logged'
         WHEN lat NOT BETWEEN -90 AND 90 OR lon NOT BETWEEN -180 AND 180 THEN 'off the planet'
         WHEN ABS(COALESCE(lat_before, lat) - lat) > 0.5 OR ABS(COALESCE(lat_after, lat) - lat) > 0.5
           OR ABS(COALESCE(lon_before, lon) - lon) > 0.5 OR ABS(COALESCE(lon_after, lon) - lon) > 0.5
           THEN 'contradicted'
         WHEN (lat_before IS NULL AND lat_after IS NULL)
           OR (lon_before IS NULL AND lon_after IS NULL)
           THEN 'no witness'
         ELSE 'on track'
       END AS verdict
FROM witnessed ORDER BY ts`;

/** The whole materialised track, in time order. */
export const TRACK_SQL = `SELECT ts, lat, lon, speed FROM route_track ORDER BY ts`;

/**
 * The newest row of `key` at or before a session start that nothing within ±2 s contradicts.
 *
 * ⚠️ `IS`, never `=`, on the session: the predicate sits inside `NOT EXISTS`, so an unknown
 * comparison selects nothing, `NOT EXISTS` is satisfied and the row is never marked. Measured
 * over the archive, `=` marks 0 rows where `IS` marks 57 — it switches the gate off silently.
 */
function inheritedFix(key: string, projection: string): string {
	return `(SELECT ${projection} FROM reading r JOIN signal s ON s.id = r.signal_id
          WHERE s.key = '${key}' AND r.ts <= sess.start_ts AND r.ts < 2000000000000
            AND NOT EXISTS (
              SELECT 1 FROM reading r2 JOIN signal s2 ON s2.id = r2.signal_id
              WHERE s2.key = '${key}' AND r2.ts BETWEEN r.ts - 2000 AND r.ts + 2000
                AND r2.session_id IS r.session_id
                AND ABS(r2.value - r.value) > 0.002)
          ORDER BY r.ts DESC LIMIT 1)`;
}

function lastValueAtOrBefore(key: string): string {
	return `(SELECT r.value FROM reading r JOIN signal s ON s.id = r.signal_id
           WHERE s.key = '${key}' AND r.ts <= wp.ts AND r.ts < 2000000000000
           ORDER BY r.ts DESC LIMIT 1)`;
}

/**
 * The nearest fix on one side, at least 5 s and at most 30 min away.
 *
 * The skew is the whole gate: a waypoint copies liveState and the GPS signals carry a 3 m
 * deadband, so the fix logged immediately before a waypoint IS the fix it copied, and
 * comparing the two proves nothing.
 */
function witness(key: string, side: 'before' | 'after'): string {
	const window =
		side === 'before'
			? 'BETWEEN placed.ts - 1800000 AND placed.ts - 5000'
			: 'BETWEEN placed.ts + 5000 AND placed.ts + 1800000';
	const order = side === 'before' ? 'DESC' : 'ASC';
	return `(SELECT r.value FROM reading r JOIN signal s ON s.id = r.signal_id
           WHERE s.key = '${key}' AND r.ts ${window}
             AND r.ts < 2000000000000 ORDER BY r.ts ${order} LIMIT 1)`;
}
