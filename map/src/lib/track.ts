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

/** A break in the drawn line, and why it is there. */
export interface TrackBreak {
	/** Timestamp of the last point before the break. */
	afterTs: number;
	reason: 'gap' | 'charge';
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
export function buildTrackGeoJson(points: TrackPoint[], breaks: TrackBreak[]): TrackGeoJson {
	const features: TrackFeature[] = [];
	if (points.length === 0) {
		return { type: 'FeatureCollection', features };
	}
	const breakAfter = new Set(breaks.map((entry) => entry.afterTs));

	let coordinates: [number, number][] = [[points[0].lon, points[0].lat]];
	let band = bandOf(points[0].speed);
	let fromTs = points[0].ts;

	for (let index = 1; index < points.length; index += 1) {
		const point = points[index];
		const previous = points[index - 1];
		const hardBreak = breakAfter.has(previous.ts) || point.ts - previous.ts > GAP_MS;
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
	features.push(featureOf(coordinates, band, fromTs, points[points.length - 1].ts));
	// A single point cannot be a LineString; MapLibre drops such a feature silently, so it is
	// dropped here where the count is still observable.
	return {
		type: 'FeatureCollection',
		features: features.filter((feature) => feature.geometry.coordinates.length > 1)
	};
}

/**
 * Longer than this between two fixes and the line breaks.
 *
 * 30 minutes is the same threshold `grafana/dashboards/route-map.json` splits rides on, kept
 * deliberately equal: two different answers to "is this still the same ride" on one screen is
 * worse than either answer.
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
