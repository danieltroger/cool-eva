<script lang="ts">
	import { onMount } from 'svelte';
	import type { Point } from 'geojson';
	import { LngLatBounds, Map as MapLibreMap, NavigationControl, ScaleControl } from 'maplibre-gl';
	import type { GeoJSONSource } from 'maplibre-gl';
	import {
		addChargeLayer,
		addTrackLayer,
		addWaypointLayer,
		basemapStyleUrl,
		chargeGeoJson,
		waypointGeoJson
	} from '$lib/mapLayers';
	import { BAND_EDGES_KMH, boundsOfRange, type TrackGeoJson } from '$lib/track';
	import { bandLabel, BAND_COLOURS, NO_SPEED_COLOUR } from '$lib/format';
	import type { ChargeSession, Ride, Waypoint } from '$lib/server/snapshot';
	import type { RideSummary } from '$lib/wire';
	import RideList from '$lib/RideList.svelte';

	const RANGES = [
		{ label: 'All', days: null },
		{ label: '90 d', days: 90 },
		{ label: '30 d', days: 30 },
		{ label: '7 d', days: 7 }
	];

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
			style: basemapStyleUrl(darkMode.matches),
			center: [0, 20],
			zoom: 1,
			attributionControl: { compact: true }
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
		const resizeObserver = new ResizeObserver(() => map?.resize());
		resizeObserver.observe(container);
		resizeObservers.push(resizeObserver);

		// A handle for the check harness and for a human poking at it in devtools. Dev only:
		// `import.meta.env.DEV` is statically replaced, so this disappears from a production build.
		if (import.meta.env.DEV) {
			(window as unknown as { __map: MapLibreMap }).__map = map;
		}

		// `setStyle` throws away every layer we added, so they are re-added on `style.load`
		// rather than only once — which is also what makes the theme switch work at all.
		map.on('style.load', () => {
			if (map === null) {
				return;
			}
			map.resize();
			if (track !== null) {
				addTrackLayer(map, track);
			}
			addChargeLayer(map, charges);
			addWaypointLayer(map, waypoints);
			applyRange();
		});
		map.once('idle', () => fitToData());
		const onThemeChange = (event: MediaQueryListEvent) => {
			map?.setStyle(basemapStyleUrl(event.matches));
		};
		darkMode.addEventListener('change', onThemeChange);
		teardown.push(() => darkMode.removeEventListener('change', onThemeChange));
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
		map.setFilter('track', ['>=', ['get', 'toTs'], fromTs]);
		const chargeSource = map.getSource('charges') as GeoJSONSource | undefined;
		const waypointSource = map.getSource('waypoints') as GeoJSONSource | undefined;
		chargeSource?.setData(chargeGeoJson(visibleCharges));
		waypointSource?.setData(waypointGeoJson(visibleWaypoints));
	}

	function selectRange(days: number | null) {
		rangeDays = days;
		applyRange();
		fitToData();
	}

	function flyToRide(ride: Ride) {
		if (map === null) {
			return;
		}
		map.setFilter('track', [
			'all',
			['>=', ['get', 'toTs'], ride.startTs],
			['<=', ['get', 'fromTs'], ride.endTs]
		]);
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
		<header class="flex items-center gap-2 px-3 py-2" style="border-color: var(--border)">
			<button
				class="rounded px-2 py-1 text-sm md:hidden"
				style="background: var(--surface-sunken)"
				onclick={() => (panelOpen = !panelOpen)}
				aria-expanded={panelOpen}
			>
				{panelOpen ? '▾' : '▴'}
			</button>
			<h1 class="text-sm font-semibold">Ride map</h1>
			<div class="ml-auto flex gap-1">
				{#each RANGES as range (range.label)}
					<button
						class="rounded px-2 py-1 text-xs"
						style="background: {rangeDays === range.days
							? 'var(--accent)'
							: 'var(--surface-sunken)'}; color: {rangeDays === range.days
							? '#fff'
							: 'var(--text)'}"
						onclick={() => selectRange(range.days)}>{range.label}</button
					>
				{/each}
			</div>
		</header>

		<div class="grid grid-cols-3 gap-px px-3 pb-2 text-center">
			<div>
				<div class="text-lg font-semibold">{distanceKm.toFixed(0)}</div>
				<div class="text-xs" style="color: var(--text-dim)">km</div>
			</div>
			<div>
				<div class="text-lg font-semibold">{visibleCharges.length}</div>
				<div class="text-xs" style="color: var(--text-dim)">charge stops</div>
			</div>
			<div>
				<div class="text-lg font-semibold">{energyKwh.toFixed(1)}</div>
				<div class="text-xs" style="color: var(--text-dim)">kWh charged</div>
			</div>
		</div>

		<div class="flex flex-wrap gap-2 px-3 pb-2 text-[10px]" style="color: var(--text-dim)">
			{#each BAND_COLOURS as colour, band (band)}
				<span class="flex items-center gap-1">
					<span class="inline-block h-2 w-4 rounded" style="background: {colour}"></span>
					{bandLabel(band, BAND_EDGES_KMH)}
				</span>
			{/each}
			<!-- Band -1 is drawn too, in grey: an out-of-range speed becomes NULL upstream rather
			     than a clamped value, and a legend that omits it leaves grey track unexplained. -->
			<span class="flex items-center gap-1">
				<span class="inline-block h-2 w-4 rounded" style="background: {NO_SPEED_COLOUR}"></span>
				{bandLabel(-1, BAND_EDGES_KMH)}
			</span>
		</div>

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
