import { json } from '@sveltejs/kit';
import { identityUnchanged, openRideLog } from '$lib/server/database';
import type { RequestHandler } from './$types';

// Proves the one thing the whole data path rests on: that a native module can be opened and
// queried from inside a SvelteKit server route. #296 listed this as the open item that could
// INVALIDATE the design rather than merely slow it, so it is answered by running it rather
// than by reasoning about `ssr.external`. Delete this route once real endpoints cover it.

export const GET: RequestHandler = async () => {
	const startedAt = performance.now();
	const open = await openRideLog();
	const openedMs = performance.now() - startedAt;

	const queriedAt = performance.now();
	const readings = open.database.prepare('SELECT COUNT(*) AS n FROM reading').get() as {
		n: number;
	};
	const trackPoints = open.database.prepare('SELECT COUNT(*) AS n FROM route_track').get() as {
		n: number;
	};
	const queriedMs = performance.now() - queriedAt;

	const unchanged = await identityUnchanged(open);
	open.database.close();

	return json({
		path: open.path,
		readings: readings.n,
		trackPoints: trackPoints.n,
		identity: open.identity,
		identityUnchanged: unchanged,
		openedMs: Math.round(openedMs * 10) / 10,
		queriedMs: Math.round(queriedMs * 10) / 10
	});
};
