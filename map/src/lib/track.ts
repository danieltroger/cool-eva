// Turning the materialised `route_track` rows into what MapLibre draws. Pure: rows in,
// GeoJSON out, no I/O and no clock — so it can be checked by replaying synthetic rows, which
// is how the repo tests its decoders (CLAUDE.md §"Keep decoders pure").
//
// ⚠️ WHY LINES AND NOT POINTS, when docs/route-map.md argues the opposite. That argument is
// about Grafana's geomap, whose route layer renders series[0] and discards the rest, so it
// cannot break a line across a gap and draws a straight edge down roads the bike was trailered
// along. We split the line ourselves, so the objection does not transfer. Measured on the real
// archive: 249 151 points as individual circles paint in 1 411 ms; the same points as 17 640
// speed-banded segments paint in 354 ms and carry the same per-point speed colour.

/** One row of `route_track`. `speed` is null where the reading was out of declared bounds. */
export interface TrackPoint {
	ts: number;
	lat: number;
	lon: number;
	speed: number | null;
}

/**
 * A charge session, as the track sees it: an interval, not an instant.
 *
 * ⚠️ Two bugs live here and both were "nothing happens". The first version matched an exact
 * millisecond against a point's `ts`; charge starts come from `mains_a`/`dc_a`/
 * `fast_dc_target_a` rows and track points from per-second GPS, so **0 of 50** charge starts
 * equalled a track timestamp and the break never fired. The second only knew about `startTs`,
 * so the fixes the bike logs WHILE PLUGGED IN were still drawn — **41 of 50** sessions contain
 * some, **17 044 points** of stationary scatter across the archive, which `RIDES_SQL` drops
 * from its ride detection for exactly that reason. An interval fixes both.
 */
export interface ChargeInterval {
	fromTs: number;
	toTs: number;
}

export interface TrackGeoJson {
	type: 'FeatureCollection';
	features: TrackFeature[];
}

export interface TrackFeature {
	type: 'Feature';
	geometry: { type: 'LineString'; coordinates: [number, number][] };
	properties: { band: number; fromTs: number; toTs: number };
}

/**
 * Splits the track into speed-banded segments, breaking wherever the line would otherwise
 * fabricate a path the bike did not ride.
 *
 * Three things start a new segment: a time gap longer than `GAP_MS`, a charge session the
 * caller passes in (the bike is stationary and the hub usually asleep, so the fixes either
 * side are minutes to days apart), and a change of speed band — which is not a correctness
 * break but the only way to colour a line by speed, since `line-color` is per feature and
 * `line-gradient` is a per-layer ramp over `line-progress` that cannot read the data.
 */
export function buildTrackGeoJson(points: TrackPoint[], charges: ChargeInterval[]): TrackGeoJson {
	const features: TrackFeature[] = [];
	const ordered = [...charges].sort((left, right) => left.fromTs - right.fromTs);
	// A stationary hour at a charger is not riding. Dropping these points is the same rule
	// RIDES_SQL applies to ride detection, applied to what gets drawn.
	const ridden = points.filter((point) => !insideAny(ordered, point.ts));
	if (ridden.length === 0) {
		return { type: 'FeatureCollection', features };
	}

	let coordinates: [number, number][] = [[ridden[0].lon, ridden[0].lat]];
	let band = bandOf(ridden[0].speed);
	let fromTs = ridden[0].ts;

	for (let index = 1; index < ridden.length; index += 1) {
		const point = ridden[index];
		const previous = ridden[index - 1];
		// A session between two surviving points breaks the line even when the hole it left is
		// shorter than GAP_MS — a 21-minute stop leaves no 30-minute gap for the gap rule.
		const charged = ordered.some(
			(charge) => charge.fromTs > previous.ts && charge.fromTs <= point.ts
		);
		const hardBreak = charged || point.ts - previous.ts >= GAP_MS;
		const nextBand = bandOf(point.speed);

		if (hardBreak) {
			// The line simply stops. Nothing is drawn across the gap, which is the whole point.
			features.push(featureOf(coordinates, band, fromTs, previous.ts));
			coordinates = [[point.lon, point.lat]];
			band = nextBand;
			fromTs = point.ts;
			continue;
		}
		// A band change shares its boundary point with both segments, so the line stays visually
		// continuous rather than showing a one-pixel hole at every colour change.
		coordinates.push([point.lon, point.lat]);
		if (nextBand !== band) {
			features.push(featureOf(coordinates, band, fromTs, point.ts));
			coordinates = [[point.lon, point.lat]];
			band = nextBand;
			fromTs = point.ts;
		}
	}
	features.push(featureOf(coordinates, band, fromTs, ridden[ridden.length - 1].ts));
	// A single point cannot be a LineString; MapLibre drops such a feature silently, so it is
	// dropped here where the count is still observable.
	return {
		type: 'FeatureCollection',
		features: features.filter((feature) => feature.geometry.coordinates.length > 1)
	};
}

function insideAny(charges: ChargeInterval[], ts: number): boolean {
	for (const charge of charges) {
		if (ts >= charge.fromTs && ts <= charge.toTs) {
			return true;
		}
	}
	return false;
}

/**
 * Longer than this between two fixes and the line breaks.
 *
 * 30 minutes is the same threshold the ride and charge-session SQL uses, kept deliberately
 * equal: two different answers to "is this still the same ride" on one screen is worse than
 * either answer.
 *
 * ⚠️ The comparison matches too. The SQL splits on `ts - LAG(ts) >= 1800000`, so a hole of
 * EXACTLY 30 minutes is a split there; this used to be `> GAP_MS`, which kept it joined, under
 * a comment claiming the two agreed. One sample in the whole archive could land on it, and
 * finding out why the map and the ride list disagreed about a single ride would have cost far
 * more than the `=` does.
 */
export const GAP_MS = 30 * 60 * 1000;

/**
 * Speed band edges in km/h, and therefore the colours.
 *
 * Five bands measured against the archive at 17 640 segments; three gives 15 254 and nine
 * gives 34 455, so this buys resolution cheaply. It is a display choice and nothing downstream
 * depends on the exact edges.
 */
export const BAND_EDGES_KMH = [20, 50, 80, 110];

/** Band index, or -1 where the speed reading was rejected by its declared bounds upstream. */
export function bandOf(speedKmh: number | null): number {
	if (speedKmh === null) {
		return -1;
	}
	let index = 0;
	while (index < BAND_EDGES_KMH.length && speedKmh >= BAND_EDGES_KMH[index]) {
		index += 1;
	}
	return index;
}

function featureOf(
	coordinates: [number, number][],
	band: number,
	fromTs: number,
	toTs: number
): TrackFeature {
	return {
		type: 'Feature',
		geometry: { type: 'LineString', coordinates },
		properties: { band, fromTs, toTs }
	};
}

/** West, south, east, north — or null when nothing in the range has a position. */
export type TrackBounds = [number, number, number, number];

/**
 * The extent of every segment overlapping `[fromTs, toTs]`.
 *
 * ⚠️ This exists because framing a ride by its charge stops cannot work: `RIDES_SQL` drops
 * fixes logged while plugged in and starts a new ride at every charge, so rides and charge
 * sessions are disjoint BY CONSTRUCTION — measured on the real archive, **0 of 69** rides
 * contain a stop. The first version of "fly to this ride" fitted bounds to the stops inside it,
 * found none, and silently left the camera where it was.
 */
export function boundsOfRange(
	features: TrackFeature[],
	fromTs: number,
	toTs: number
): TrackBounds | null {
	let west = Infinity;
	let south = Infinity;
	let east = -Infinity;
	let north = -Infinity;
	for (const feature of features) {
		// Overlap, not containment: a segment straddling either edge is part of what happened.
		if (feature.properties.toTs < fromTs || feature.properties.fromTs > toTs) {
			continue;
		}
		for (const [lon, lat] of feature.geometry.coordinates) {
			west = Math.min(west, lon);
			south = Math.min(south, lat);
			east = Math.max(east, lon);
			north = Math.max(north, lat);
		}
	}
	return west === Infinity ? null : [west, south, east, north];
}
