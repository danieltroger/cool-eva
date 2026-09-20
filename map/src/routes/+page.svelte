<script lang="ts">
	import { onMount } from 'svelte';
	import type { Point } from 'geojson';
	import { LngLatBounds, Map as MapLibreMap, NavigationControl, ScaleControl } from 'maplibre-gl';
	import type { GeoJSONSource } from 'maplibre-gl';
	import { env } from '$env/dynamic/public';
	import {
		addChargeLayer,
		addTrackLayer,
		addWaypointLayer,
		basemapStyle,
		chargeGeoJson,
		setLayerVisible,
		setTrackFilter,
		waypointGeoJson
	} from '$lib/mapLayers';
	import { needsMaptilerLogo, type BasemapKind } from '$lib/basemap';
	import { chargeFlyZoom } from '$lib/chargeFacts';
	import { boundsOfRange, type TrackGeoJson } from '$lib/track';
	import type { ChargeSession, Ride, Waypoint } from '$lib/server/snapshot';
	import type { RideSummary } from '$lib/wire';
	import ChargeTooltip from '$lib/ChargeTooltip.svelte';
	import MapHeader from '$lib/MapHeader.svelte';
	import RideList from '$lib/RideList.svelte';

	let container: HTMLDivElement;
	let map: MapLibreMap | null = null;
	const resizeObservers: ResizeObserver[] = [];
	const teardown: (() => void)[] = [];
	let loadError = $state<string | null>(null);
	let loading = $state<string | null>('Loading rides…');
	let track: TrackGeoJson | null = null;
	let rides = $state<Ride[]>([]);
	let charges = $state<ChargeSession[]>([]);
	let waypoints = $state<Waypoint[]>([]);
	let rangeDays = $state<number | null>(90);
	let panelOpen = $state(false);
	let basemapKind = $state<BasemapKind>('map');
	let showCharges = $state(true);
	let showWaypoints = $state(true);
	let selectedRide = $state<Ride | null>(null);
	let hovered = $state<ChargeSession | null>(null);
	let hoverAt = $state<{ x: number; y: number } | null>(null);
	let mapSize = $state({ width: 390, height: 600 });
	// ⚠️ `$env/dynamic/public`, not `$env/static/public`: the static module only exports what
	// exists at BUILD time, and map.yml builds with no .env — a static import of a missing key
	// fails the build rather than the page. Read once; it never changes at runtime.
	const maptilerKey = env.PUBLIC_MAPTILER_KEY ?? null;

	// The window is a slice of data already in the browser, not a query. `latest` comes from the
	// data rather than from the clock, so the default range still frames the last rides on a
	// laptop opened a week after the bike was last ridden.
	const latest = $derived(
		Math.max(0, ...rides.map((ride) => ride.endTs), ...charges.map((charge) => charge.endTs))
	);
	const fromTs = $derived(rangeDays === null ? 0 : latest - rangeDays * 86400000);
	const visibleRides = $derived(rides.filter((ride) => ride.endTs >= fromTs));
	const visibleCharges = $derived(charges.filter((charge) => charge.endTs >= fromTs));
	const visibleWaypoints = $derived(waypoints.filter((point) => point.ts >= fromTs));
	const distanceKm = $derived(visibleRides.reduce((total, ride) => total + (ride.km ?? 0), 0));
	const energyKwh = $derived(
		visibleCharges.reduce((total, charge) => total + Math.max(0, charge.whAdded), 0) / 1000
	);

	onMount(() => {
		void start();
		return () => {
			for (const observer of resizeObservers) {
				observer.disconnect();
			}
			for (const undo of teardown) {
				undo();
			}
			map?.remove();
		};
	});

	async function start() {
		try {
			// ⚠️ The FIRST load against a fresh archive builds the snapshot, which measured 23 476 ms
			// on the real one. Saying so beats a blank page for twenty-three seconds; every later
			// load reads the cache in about 4 ms and this flicks past.
			loading = 'Building the ride summary — first run on this archive, about 30 s…';
			const summaryResponse = await fetch('/api/summary');
			if (!summaryResponse.ok) {
				throw new Error(`/api/summary returned ${summaryResponse.status}`);
			}
			const summary = (await summaryResponse.json()) as RideSummary;
			rides = summary.rides;
			charges = summary.charges;
			waypoints = summary.waypoints;

			loading = 'Loading the track…';
			const trackResponse = await fetch('/api/track');
			if (!trackResponse.ok) {
				throw new Error(`/api/track returned ${trackResponse.status}`);
			}
			track = (await trackResponse.json()) as TrackGeoJson;
			loading = null;
		} catch (error) {
			// Never swallowed: with no summary the map would draw a track and silently claim
			// there were no rides, charges or waypoints at all.
			loadError = (error as Error).message;
			loading = null;
			console.error('could not load the ride data', error);
			return;
		}
		const darkMode = window.matchMedia('(prefers-color-scheme: dark)');
		map = new MapLibreMap({
			container,
			style: basemapStyle(basemapKind, darkMode.matches, maptilerKey),
			center: [0, 20],
			zoom: 1,
			// ⚠️ MapTiler requires attribution "always visible and readable", with an explicit
			// allowance for a one-tap popup on small screens — so compact ONLY there. MapLibre
			// collapses a compact control on the first drag at any width, which on a desktop
			// would be hiding it rather than adapting to a phone.
			attributionControl: { compact: window.innerWidth < 640 }
		});
		map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
		map.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-left');
		map.on('error', (event) => {
			// MapLibre reports a failed style or tile fetch here and nowhere else; unhandled, an
			// unreachable basemap looks exactly like a slow one.
			console.error('maplibre error', event.error ?? event);
		});
		// ⚠️ MapLibre falls back to 400x300 when its container has no size at construction, and
		// this container is a flex child that has none until the sidebar has laid out. Measured
		// at phone width: a 390x792 container held a 390x300 canvas, so two thirds of the map was
		// blank background. Its own ResizeObserver does eventually fire, but not before the first
		// paint — which is exactly what a screenshot catches. Observing the container ourselves
		// makes the first frame right rather than the second.
		const resizeObserver = new ResizeObserver((entries) => {
			map?.resize();
			const box = entries[0]?.contentRect;
			if (box !== undefined) {
				mapSize = { width: box.width, height: box.height };
			}
		});
		resizeObserver.observe(container);
		resizeObservers.push(resizeObserver);

		// A handle for the check harness and for a human poking at it in devtools. Dev only:
		// `import.meta.env.DEV` is statically replaced, so this disappears from a production build.
		if (import.meta.env.DEV) {
			(window as unknown as { __map: MapLibreMap }).__map = map;
		}

		// ⚠️ `setStyle` throws away every layer AND every layout property we set, so this is the
		// one place map state is built — and it must rebuild ALL of it. An earlier version
		// re-added the three layers here and nothing else, so a theme change at sunset would
		// have silently dropped the marker toggles, the casing and the selected ride.
		map.on('style.load', () => applyMapState());
		map.once('idle', () => fitToData());
		const onThemeChange = (event: MediaQueryListEvent) => {
			// The basemap is a function of (theme, satellite, key) — passing only the theme is
			// how satellite used to get thrown away when macOS flipped to dark.
			map?.setStyle(basemapStyle(basemapKind, event.matches, maptilerKey));
		};
		darkMode.addEventListener('change', onThemeChange);
		teardown.push(() => darkMode.removeEventListener('change', onThemeChange));

		map.on('mousemove', 'charges', (event) => {
			const feature = event.features?.[0];
			const startTs = feature?.properties?.startTs;
			hovered = charges.find((charge) => charge.startTs === startTs) ?? null;
			hoverAt = { x: event.point.x, y: event.point.y };
			if (map !== null) {
				map.getCanvas().style.cursor = 'pointer';
			}
		});
		map.on('mouseleave', 'charges', () => {
			hovered = null;
			hoverAt = null;
			if (map !== null) {
				map.getCanvas().style.cursor = '';
			}
		});
		map.on('click', 'charges', (event) => {
			const startTs = event.features?.[0]?.properties?.startTs;
			const charge = charges.find((entry) => entry.startTs === startTs);
			if (charge !== undefined) {
				flyToCharge(charge);
			}
		});
	}

	/**
	 * Everything `setStyle` destroys, rebuilt in one place.
	 *
	 * ⚠️ Including the SELECTED RIDE. An earlier version said "everything" and restored the
	 * window filter only, so flipping to satellite while looking at one ride silently widened
	 * the track back to the whole range.
	 */
	function applyMapState() {
		if (map === null || track === null) {
			return;
		}
		map.resize();
		addTrackLayer(map, track, basemapKind === 'satellite');
		addChargeLayer(map, charges);
		addWaypointLayer(map, waypoints);
		applyRange();
		setLayerVisible(map, 'charges', showCharges);
		setLayerVisible(map, 'waypoints', showWaypoints);
	}

	function setBasemap(kind: BasemapKind) {
		basemapKind = kind;
		map?.setStyle(
			basemapStyle(kind, window.matchMedia('(prefers-color-scheme: dark)').matches, maptilerKey)
		);
	}

	function toggleCharges() {
		showCharges = !showCharges;
		if (map !== null) {
			setLayerVisible(map, 'charges', showCharges);
		}
	}

	function toggleWaypoints() {
		showWaypoints = !showWaypoints;
		if (map !== null) {
			setLayerVisible(map, 'waypoints', showWaypoints);
		}
	}

	/** A stop's pin is an inherited position, so the zoom matches how old it is. */
	function flyToCharge(charge: ChargeSession) {
		// A stop or a waypoint is a point, not a range. Leaving a per-ride track filter in
		// place would fly to a pin sitting on an empty basemap.
		selectedRide = null;
		applyRange();
		if (map === null || charge.lat === null || charge.lon === null) {
			return;
		}
		map.flyTo({ center: [charge.lon, charge.lat], zoom: chargeFlyZoom(charge), duration: 700 });
		panelOpen = false;
	}

	function flyToWaypoint(point: Waypoint) {
		// A stop or a waypoint is a point, not a range. Leaving a per-ride track filter in
		// place would fly to a pin sitting on an empty basemap.
		selectedRide = null;
		applyRange();
		// Only corroborated waypoints have a position the map will draw; the rest are listed
		// precisely because nothing vouches for where they claim to be.
		if (map === null || point.lat === null || point.lon === null || point.verdict !== 'on track') {
			return;
		}
		map.flyTo({ center: [point.lon, point.lat], zoom: 14, duration: 700 });
		panelOpen = false;
	}

	/**
	 * Frame whatever is in the current window, using the TRACK's geometry.
	 *
	 * ⚠️ Not the charge stops. Rides and charge sessions are disjoint by construction, so a
	 * window can hold plenty of riding and no placeable stop at all.
	 */
	function fitToData() {
		fitTo(fromTs, Number.MAX_SAFE_INTEGER, 48, 13, false);
	}

	function fitTo(
		from: number,
		to: number,
		padding: number,
		maxZoom: number,
		animate: boolean
	): void {
		if (map === null || track === null) {
			return;
		}
		const bounds = boundsOfRange(track.features, from, to);
		if (bounds === null) {
			// Nothing drawn in this range. Leaving the camera alone is the honest answer; moving
			// it somewhere arbitrary is not.
			return;
		}
		map.fitBounds(
			[
				[bounds[0], bounds[1]],
				[bounds[2], bounds[3]]
			],
			{ padding, maxZoom, animate, duration: animate ? 700 : 0 }
		);
	}

	/** A window change is a layer filter and two array slices — no request, no round trip. */
	function applyRange() {
		if (map === null || map.getLayer('track') === undefined) {
			return;
		}
		const ride = selectedRide;
		setTrackFilter(
			map,
			ride === null
				? ['>=', ['get', 'toTs'], fromTs]
				: ['all', ['>=', ['get', 'toTs'], ride.startTs], ['<=', ['get', 'fromTs'], ride.endTs]]
		);
		const chargeSource = map.getSource('charges') as GeoJSONSource | undefined;
		const waypointSource = map.getSource('waypoints') as GeoJSONSource | undefined;
		chargeSource?.setData(chargeGeoJson(visibleCharges));
		waypointSource?.setData(waypointGeoJson(visibleWaypoints));
	}

	function selectRange(days: number | null) {
		rangeDays = days;
		// Picking a window is stepping back out of one ride.
		selectedRide = null;
		applyRange();
		fitToData();
	}

	function flyToRide(ride: Ride) {
		if (map === null) {
			return;
		}
		selectedRide = ride;
		applyRange();
		fitTo(ride.startTs, ride.endTs, 80, 14, true);
		panelOpen = false;
	}
</script>

<svelte:head><title>Cool Eva — ride map</title></svelte:head>

<div class="flex h-screen w-screen flex-col-reverse md:flex-row">
	<aside
		class="flex shrink-0 flex-col overflow-hidden border-t md:w-96 md:border-t-0 md:border-r"
		style="background: var(--surface-raised); border-color: var(--border);"
		class:max-md:h-[62vh]={panelOpen}
		class:max-md:h-13={!panelOpen}
	>
		<MapHeader
			{rangeDays}
			{basemapKind}
			{showCharges}
			{showWaypoints}
			{distanceKm}
			chargeCount={visibleCharges.length}
			{energyKwh}
			onRange={selectRange}
			onBasemap={setBasemap}
			onToggleCharges={toggleCharges}
			onToggleWaypoints={toggleWaypoints}
			onTogglePanel={() => (panelOpen = !panelOpen)}
			{panelOpen}
		/>

		{#if loadError !== null}
			<p class="px-3 py-2 text-sm" style="color: #e0523f">
				Could not load the ride summary: {loadError}
			</p>
		{/if}

		<RideList
			rides={visibleRides}
			charges={visibleCharges}
			waypoints={visibleWaypoints}
			onSelect={flyToRide}
			onSelectCharge={flyToCharge}
			onSelectWaypoint={flyToWaypoint}
		/>
	</aside>

	<!-- ⚠️ No `absolute inset-0` wrapper here, and that is load-bearing. MapLibre adds its own
	     `maplibregl-map` class to the container, and that rule sets `position: relative` — which
	     beats Tailwind's `absolute` on source order, so `inset-0` stops applying and the element
	     collapses to height 0. Measured at phone width: the container was 0 px tall inside a
	     792 px parent and the canvas sat at MapLibre's 400x300 fallback, leaving two thirds of
	     the map blank. Sizing it as a plain flex child has nothing to override. -->
	<div class="relative min-h-0 flex-1">
		<div bind:this={container} class="h-full w-full"></div>

		<ChargeTooltip charge={hovered} at={hoverAt} within={mapSize} />

		{#if needsMaptilerLogo(basemapKind, maptilerKey)}
			<!-- ⚠️ Required, and MapLibre will not do it: a FREE MapTiler account must display the
			     LOGO, not just the text, and MapLibre renders no TileJSON `logo` — its own
			     LogoControl is the MapLibre mark. -->
			<a
				class="absolute right-2 bottom-8 z-20 rounded bg-white/85 px-1.5 py-0.5"
				href="https://www.maptiler.com/"
				target="_blank"
				rel="noopener"
			>
				<img src="https://api.maptiler.com/resources/logo.svg" alt="MapTiler" class="h-4" />
			</a>
		{/if}

		{#if loading !== null}
			<!-- Over the map, not in the sidebar: on a phone the panel is collapsed to its header
			     and a message inside it would sit below the fold for the whole 23 s. -->
			<p
				class="pointer-events-none absolute top-3 left-1/2 z-10 -translate-x-1/2 rounded px-3 py-1.5 text-xs shadow"
				style="background: var(--surface-raised); color: var(--text-dim)"
			>
				{loading}
			</p>
		{/if}
	</div>
</div>
