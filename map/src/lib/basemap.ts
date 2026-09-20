// Which basemap to show, and what each one legally requires.
//
// ⚠️ EVERY LICENCE CLAIM HERE WAS READ FROM THE SOURCE IT NAMES, and the first version of this
// was wrong in a way worth recording: it rejected EOX on the grounds that a licence page would
// not load, when the hostname it tried (`docs.eox.at`) does not exist at all — NXDOMAIN. A
// check of nothing reported as evidence. docs/ride-map.md §"The satellite terms" has what the
// real sources say.

export type BasemapKind = 'map' | 'satellite';

export interface Basemap {
	tiles: string;
	/** Attribution MapLibre cannot derive from a bare tile template. */
	attribution: string;
	/**
	 * The deepest zoom the service actually has tiles for.
	 *
	 * ⚠️ Not decoration, and not the same for both. MapLibre defaults a raster source to 22 and
	 * EOX serves to **18** — measured, z18 → 200 and z19 → 404 — so without this, zooming past
	 * 18 leaves holes in the imagery and logs a failed request per tile per pan. Its
	 * capabilities advertise more matrices than it will serve. MapTiler's satellite goes to 22.
	 */
	maxzoom: number;
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

/**
 * The attribution EOX publishes for this layer.
 *
 * ⚠️ Carried whole, including the commercial-use sentence and both required links. An earlier
 * version called itself "verbatim" while abbreviating the licence name and dropping
 * "For commercial usage please see…" — and `ows:AccessConstraints` asks for links to
 * `maps.eox.at/#data` and `eox.at`, which that version did not carry either. Attribution is a
 * licence obligation, so the shortest safe edit is none.
 */
export const EOX_ATTRIBUTION =
	'<a href="https://cloudless.eox.at">EOxCloudless</a> by ' +
	'<a href="https://eox.at">EOX IT Services GmbH</a> (Contains modified Copernicus Sentinel ' +
	'data 2024) released under <a rel="license" ' +
	'href="https://creativecommons.org/licenses/by-nc-sa/4.0/">Creative Commons ' +
	'Attribution-NonCommercial-ShareAlike 4.0 International</a>. For commercial usage please ' +
	'see <a href="https://cloudless.eox.at">cloudless.eox.at</a>. Data ' +
	'<a href="https://maps.eox.at/#data">&copy; EOX and others</a>.';

/** EOX serves z0–z18. Measured: z18 → 200, z19 → 404, whatever the capabilities advertise. */
export const EOX_MAXZOOM = 18;

/** MapTiler's satellite tileset goes to 22, per their tileset page. */
export const MAPTILER_MAXZOOM = 22;

/**
 * MapTiler satellite, used INSTEAD of EOX when a key is present, because Sentinel-2 stops
 * resolving where this keeps going.
 *
 * ⚠️ A FREE account must show the MapTiler LOGO, not only the text, and MapLibre renders no
 * TileJSON `logo` — the page adds that element itself. Quota, attribution wording and why
 * raster costs several times a vector view: docs/ride-map.md §"The satellite terms".
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
			tiles: maptilerTiles(maptilerKey),
			attribution: MAPTILER_ATTRIBUTION,
			maxzoom: MAPTILER_MAXZOOM
		};
	}
	return { tiles: EOX_TILES, attribution: EOX_ATTRIBUTION, maxzoom: EOX_MAXZOOM };
}

/** True when the MapTiler logo has to be on screen. */
export function needsMaptilerLogo(kind: BasemapKind, maptilerKey: string | null): boolean {
	return kind === 'satellite' && maptilerKey !== null && maptilerKey !== '';
}
