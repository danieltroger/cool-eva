import { BAND_COLOURS, fixAgeClass, FIX_AGE_COLOURS, NO_SPEED_COLOUR } from './format';
import type { FeatureCollection, Point } from 'geojson';
import type { TrackGeoJson } from './track';
import type { Map as MapLibreMap, StyleSpecification } from 'maplibre-gl';
import { satelliteBasemap, vectorStyleUrl, type BasemapKind } from './basemap';
import type { ChargeSession, Waypoint } from './server/snapshot';

// The MapLibre style and the three layers, apart from the component so the component is about
// the page and this is about the map.
//
// ⚠️ maplibre-gl v6 is ESM-only and exports no `default` — `import { Map } from 'maplibre-gl'`.
// It also fetches `maplibre-gl-worker.mjs` as a separate asset, and when that 404s it never
// loads the map and reports NOTHING: no `error` event, no message of its own. Vite handles the
// asset; a hand-copied dist does not. docs/ride-map.md §"Three MapLibre v6 traps".

/**
 * The style for a given basemap choice.
 *
 * Vector is a URL; satellite is a hand-built style with one raster layer, because the imagery
 * has to be UNDER our track and OVER nothing — layering it beneath OpenFreeMap's land fills
 * would simply hide it. `map/src/lib/basemap.ts` carries the licences.
 */
export function basemapStyle(
	kind: BasemapKind,
	dark: boolean,
	maptilerKey: string | null
): string | StyleSpecification {
	if (kind === 'map') {
		return vectorStyleUrl(dark);
	}
	const imagery = satelliteBasemap(maptilerKey);
	return {
		version: 8,
		sources: {
			imagery: {
				type: 'raster',
				tiles: [imagery.styleOrTiles],
				tileSize: 256,
				// Attribution MapLibre cannot read from a bare tile template. Required by both
				// providers; see basemap.ts for the sentence each one demands.
				attribution: imagery.attribution
			}
		},
		layers: [
			{
				id: 'background',
				type: 'background',
				paint: { 'background-color': dark ? '#0b0d11' : '#e9ebef' }
			},
			{ id: 'imagery', type: 'raster', source: 'imagery' }
		]
	};
}

export function addTrackLayer(map: MapLibreMap, track: TrackGeoJson, overImagery: boolean): void {
	// The parsed collection, not the URL: the page already holds it so that a ride can be
	// framed from its own geometry, and fetching it twice to save a structured clone would be
	// the wrong trade.
	map.addSource('track', { type: 'geojson', data: track as unknown as FeatureCollection });
	if (overImagery) {
		// ⚠️ A CASING, because MapLibre has no line halo: `paint_line` in style-spec 26.4.4 has
		// no halo property at all — they exist only on symbols. A wider dark line underneath is
		// the only way to keep a thin coloured track readable over aerial imagery. Dimming the
		// imagery instead would be a "Manipulation Or Modification" of it, which MapTiler's
		// terms §4 treats differently from displaying it.
		map.addLayer({
			id: 'track-casing',
			type: 'line',
			source: 'track',
			layout: { 'line-cap': 'round', 'line-join': 'round' },
			paint: {
				'line-width': ['interpolate', ['linear'], ['zoom'], 5, 3.4, 11, 5.2, 16, 8],
				'line-color': '#05070b',
				'line-layer-opacity': 0.55
			}
		});
	}
	map.addLayer({
		id: 'track',
		type: 'line',
		source: 'track',
		layout: { 'line-cap': 'round', 'line-join': 'round' },
		paint: {
			'line-width': ['interpolate', ['linear'], ['zoom'], 5, 1.6, 11, 2.6, 16, 4.5],
			// ⚠️ line-LAYER-opacity, not line-opacity. The track crosses itself constantly, and
			// per-feature opacity compounds at every crossing into darker knots; this composites
			// the finished layer once.
			'line-layer-opacity': 0.92,
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

/** The two marker layers the toggles hide. `track` is deliberately not one of them. */
export const TOGGLEABLE_LAYERS = { charges: 'charges', waypoints: 'waypoints' } as const;

/**
 * Show or hide a marker layer.
 *
 * ⚠️ Only for the two POINT layers. `setLayoutProperty` marks the source for reload, which is
 * nothing for 50 charge stops or 210 waypoints and would not be nothing for the track's 17 000
 * segments — so the track has no toggle and should not grow one this way.
 */
export function setLayerVisible(map: MapLibreMap, layerId: string, visible: boolean): void {
	if (map.getLayer(layerId) === undefined) {
		return;
	}
	map.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none');
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
	// ⚠️ The SAME function the list dots use. This was a second copy of the 30-minute and
	// 6-hour thresholds, so a map pin and its row could have disagreed about how stale one
	// position was, silently and in two colours.
	return FIX_AGE_COLOURS[fixAgeClass(charge.startTs, charge.fixTs)];
}
