import { openRideLog } from '$lib/server/database';
import { TRACK_SQL } from '$lib/server/queries';
import { loadSnapshot } from '$lib/server/snapshot';
import { buildTrackGeoJson, type ChargeInterval, type TrackPoint } from '$lib/track';
import type { RequestHandler } from './$types';

// The whole track, once, as plain uncompressed GeoJSON.
//
// ⚠️ Uncompressed is deliberate and measured: over loopback 35 MB `curl`s in 7.7 ms, while
// gzipping it costs 195–242 ms of server time. A delta codec reaches 0.81 MB and is the right
// answer the day this leaves loopback; it is not the right answer today.

export const GET: RequestHandler = async () => {
	// One open, not two: `loadSnapshot` opens the database itself, so reading the track first
	// and asking for the snapshot afterwards used to open the same 4 GB file twice per request.
	const snapshot = await loadSnapshot();
	const open = await openRideLog();
	let points: TrackPoint[];
	try {
		points = open.database.prepare(TRACK_SQL).all() as TrackPoint[];
	} finally {
		open.database.close();
	}
	const geojson = buildTrackGeoJson(points, chargeIntervals(snapshot.charges));

	// ⚠️ The page fetches this once and keeps the parsed FeatureCollection, rather than handing
	// MapLibre the URL. It costs the same request and about the same time (1 053 vs 1 115 ms
	// measured), and it is what lets the client frame a ride from the track's own geometry —
	// see boundsOfRange in $lib/track. Without it there is nothing on the client to fit to.
	return new Response(JSON.stringify(geojson), {
		headers: { 'content-type': 'application/geo+json', 'cache-control': 'no-store' }
	});
};

/** A charge session ends a ride, and the fixes logged inside it are not riding. */
function chargeIntervals(charges: { startTs: number; endTs: number }[]): ChargeInterval[] {
	return charges.map((charge) => ({ fromTs: charge.startTs, toTs: charge.endTs }));
}
