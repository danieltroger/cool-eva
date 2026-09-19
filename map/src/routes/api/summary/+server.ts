import { json } from '@sveltejs/kit';
import { loadSnapshot } from '$lib/server/snapshot';
import type { RequestHandler } from './$types';

// Rides, charge stops and waypoints — everything but the track — from the persisted snapshot.
// One endpoint rather than three because they come from one cache and are kilobytes together.

export const GET: RequestHandler = async () => {
	const snapshot = await loadSnapshot();
	return json({
		builtAtIso: snapshot.builtAtIso,
		buildMs: snapshot.buildMs,
		rides: snapshot.rides,
		charges: snapshot.charges,
		waypoints: snapshot.waypoints
	});
};
