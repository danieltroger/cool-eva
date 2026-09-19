// Which basemap to show, and what each one legally requires.
//
// ⚠️ EVERY LICENCE CLAIM HERE WAS READ FROM THE SOURCE IT NAMES, and the first version of this
// was wrong in a way worth recording: it rejected EOX on the grounds that a licence page would
// not load, when the hostname it tried (`docs.eox.at`) does not exist at all — NXDOMAIN. A
// check of nothing reported as evidence. docs/ride-map.md §"The satellite terms" has what the
// real sources say.

export type BasemapKind = 'map' | 'satellite';

export interface Basemap {
	styleOrTiles: string;
	/** Attribution MapLibre cannot derive for itself, as plain text. */
	attribution?: string;
	/** True when the imagery is coarse enough that the track needs a casing under it. */
	imagery: boolean;
}

/**
 * OpenFreeMap's public instance for the vector map: no key, commercial use allowed, attribution
 * added by MapLibre automatically, tiles to z14.
 */
export function vectorStyleUrl(dark: boolean): string {
	return dark
		? 'https://tiles.openfreemap.org/styles/dark'
		: 'https://tiles.openfreemap.org/styles/positron';
}

/**
 * EOX Sentinel-2 cloudless — the DEFAULT satellite, because it needs no key at all.
 *
 * From the service's own `WMTSCapabilities.xml` (keyless, HTTP 200): the `s2cloudless-*` layers
 * are *"released under Creative Commons BY-NC-SA 4.0"* and `ows:AccessConstraints` reads
 * *"Proper attribution is required for any usage."* Non-commercial covers one person looking at
 * where their own motorcycle went, and ShareAlike does not reach a viewer that redistributes no
 * derivative — we display tiles, we do not publish a modified dataset.
 *
 * ⚠️ 10 m Sentinel-2, so it overzooms into mush past roughly z14. That is the reason, and the
 * only reason, to prefer MapTiler when a key exists.
 */
export const EOX_TILES =
	'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg';

/** The attribution the capabilities document publishes for that layer, carried verbatim. */
export const EOX_ATTRIBUTION =
	'<a href="https://cloudless.eox.at">EOxCloudless</a> by EOX IT Services GmbH ' +
	'(Contains modified Copernicus Sentinel data 2024) released under ' +
	'<a rel="license" href="https://creativecommons.org/licenses/by-nc-sa/4.0/">CC BY-NC-SA 4.0</a>';

/**
 * MapTiler satellite, used INSTEAD of EOX when a key is present, because it keeps resolving
 * where Sentinel-2 stops.
 *
 * Their terms, read: a free account may use the service *"up to the quota allowed under the
 * free tiers"*, the free plan is *"Suitable for testing, personal or non-commercial use"*, and
 * overrun degrades rather than bills — *"service will pause until the next month"*.
 *
 * ⚠️ Raster is quota-hungry by their own figure — *"10-16 requests for raster tiles with 256px
 * size"* per map view, against 4 for vector — which is why satellite is opt-in and is not
 * remembered across reloads.
 *
 * ⚠️ A FREE account must show the MapTiler LOGO, not just the text: *"the Customer is required
 * to add '© MapTiler' (with Free Account the MapTiler logo)"*. MapLibre renders no TileJSON
 * logo, so the page adds that element itself when this path is in use.
 */
export function maptilerTiles(key: string): string {
	return `https://api.maptiler.com/tiles/satellite-v2/{z}/{x}/{y}.jpg?key=${encodeURIComponent(key)}`;
}

export const MAPTILER_ATTRIBUTION =
	'<a href="https://www.maptiler.com/copyright/">&copy; MapTiler</a> ' +
	'<a href="https://www.openstreetmap.org/copyright">&copy; OpenStreetMap contributors</a>';

/** Which imagery a given key situation gets. */
export function satelliteBasemap(maptilerKey: string | null): Basemap {
	if (maptilerKey !== null && maptilerKey !== '') {
		return {
			styleOrTiles: maptilerTiles(maptilerKey),
			attribution: MAPTILER_ATTRIBUTION,
			imagery: true
		};
	}
	return { styleOrTiles: EOX_TILES, attribution: EOX_ATTRIBUTION, imagery: true };
}

/** True when the MapTiler logo has to be on screen. */
export function needsMaptilerLogo(kind: BasemapKind, maptilerKey: string | null): boolean {
	return kind === 'satellite' && maptilerKey !== null && maptilerKey !== '';
}
