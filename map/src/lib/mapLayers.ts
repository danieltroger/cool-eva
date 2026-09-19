import { BAND_COLOURS, NO_SPEED_COLOUR } from './format';
import type { FeatureCollection, Point } from 'geojson';
import type { TrackGeoJson } from './track';
import type { Map as MapLibreMap, StyleSpecification } from 'maplibre-gl';
import type { ChargeSession, Waypoint } from './server/snapshot';

// The MapLibre style and the three layers, apart from the component so the component is about
// the page and this is about the map.
//
// ⚠️ maplibre-gl v6 is ESM-only and exports no `default` — `import { Map } from 'maplibre-gl'`.
// It also fetches `maplibre-gl-worker.mjs` as a separate asset, and when that 404s it never
// loads the map and reports NOTHING: no `error` event, no message of its own. Vite handles the
// asset; a hand-copied dist does not. docs/ride-map.md §"Three MapLibre v6 traps".

/**
 * OpenFreeMap's public instance: no key, no registration, commercial use allowed, attribution
 * added by MapLibre automatically. Its tiles stop at z14, so past that the basemap overzooms
 * while the track — a client-side source, not a tiled one — stays at full resolution.
 *
 * Two styles, because one is a defect in the other's theme: a dark sidebar beside a pale green
 * basemap is what the first screenshot of this page showed. `positron` is also deliberately
 * muted rather than `liberty`, so the basemap does not compete with the speed colours it is
 * underneath — the track is the data, the map is context.
 */
export function basemapStyleUrl(dark: boolean): string {
	return dark
		? 'https://tiles.openfreemap.org/styles/dark'
		: 'https://tiles.openfreemap.org/styles/positron';
}

/** A style with no basemap at all, for the offline case and for deterministic screenshots. */
export function blankStyle(background: string): StyleSpecification {
	return {
		version: 8,
		sources: {},
		layers: [{ id: 'background', type: 'background', paint: { 'background-color': background } }]
	};
}

export function addTrackLayer(map: MapLibreMap, track: TrackGeoJson): void {
	// The parsed collection, not the URL: the page already holds it so that a ride can be
	// framed from its own geometry, and fetching it twice to save a structured clone would be
	// the wrong trade.
	map.addSource('track', { type: 'geojson', data: track as unknown as FeatureCollection });
	map.addLayer({
		id: 'track',
		type: 'line',
		source: 'track',
		layout: { 'line-cap': 'round', 'line-join': 'round' },
		paint: {
			'line-width': ['interpolate', ['linear'], ['zoom'], 5, 1.6, 11, 2.6, 16, 4.5],
			'line-opacity': 0.92,
			// Per feature, because `line-gradient` is a per-layer ramp over `line-progress` and
			// cannot read the data. This is why the track is split into speed bands at all.
			'line-color': [
				'match',
				['get', 'band'],
				0,
				BAND_COLOURS[0],
				1,
				BAND_COLOURS[1],
				2,
				BAND_COLOURS[2],
				3,
				BAND_COLOURS[3],
				4,
				BAND_COLOURS[4],
				NO_SPEED_COLOUR
			]
		}
	});
}

export function addChargeLayer(map: MapLibreMap, charges: ChargeSession[]): void {
	map.addSource('charges', { type: 'geojson', data: chargeGeoJson(charges) });
	map.addLayer({
		id: 'charges',
		type: 'circle',
		source: 'charges',
		paint: {
			// Sized by energy added and coloured by how stale the inherited position is — the
			// dashboard's own encoding, kept.
			'circle-radius': ['interpolate', ['linear'], ['get', 'kwh'], 0, 5, 5, 9, 12, 15],
			'circle-color': ['get', 'colour'],
			'circle-opacity': 0.85,
			'circle-stroke-width': 1.5,
			'circle-stroke-color': '#11131a'
		}
	});
}

export function addWaypointLayer(map: MapLibreMap, waypoints: Waypoint[]): void {
	map.addSource('waypoints', { type: 'geojson', data: waypointGeoJson(waypoints) });
	map.addLayer({
		id: 'waypoints',
		type: 'circle',
		source: 'waypoints',
		paint: {
			'circle-radius': 6,
			'circle-color': '#a855f7',
			'circle-stroke-width': 2,
			'circle-stroke-color': '#ffffff',
			'circle-opacity': 0.95
		}
	});
}

/** Only placeable stops reach the map; the unplaceable ones stay in the table, counted. */
export function chargeGeoJson(charges: ChargeSession[]): FeatureCollection {
	const features = charges
		.filter((charge) => charge.lat !== null && charge.lon !== null)
		.map((charge) => ({
			type: 'Feature' as const,
			geometry: {
				type: 'Point' as const,
				coordinates: [charge.lon as number, charge.lat as number]
			},
			properties: {
				startTs: charge.startTs,
				kwh: charge.whAdded / 1000,
				colour: chargeColour(charge)
			}
		}));
	return { type: 'FeatureCollection', features };
}

/**
 * ⚠️ Only `on track` waypoints are drawn. Everything else is listed with its verdict instead:
 * one uncorroborated marker on another continent reframes the whole map, and a waypoint
 * nothing can vouch for is not worth that.
 */
export function waypointGeoJson(waypoints: Waypoint[]): FeatureCollection {
	const features = waypoints
		.filter((point) => point.verdict === 'on track' && point.lat !== null && point.lon !== null)
		.map((point) => ({
			type: 'Feature' as const,
			geometry: { type: 'Point' as const, coordinates: [point.lon as number, point.lat as number] },
			properties: { seq: point.seq, ts: point.ts, provenance: point.provenance }
		}));
	return { type: 'FeatureCollection', features };
}

function chargeColour(charge: ChargeSession): string {
	if (charge.fixTs === null) {
		return '#8a8f98';
	}
	const minutes = (charge.startTs - charge.fixTs) / 60000;
	if (minutes < 30) {
		return '#2fae63';
	}
	if (minutes < 360) {
		return '#eab839';
	}
	return '#e0523f';
}
