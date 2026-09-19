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
	import { BAND_EDGES_KMH } from '$lib/track';
	import { bandLabel, BAND_COLOURS, formatDate, formatDateTime, formatDuration } from '$lib/format';
	import type { ChargeSession, Ride, Waypoint } from '$lib/server/snapshot';
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
	let loadError = $state<string | null>(null);
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
			map?.remove();
		};
	});

	async function start() {
		try {
			const response = await fetch('/api/summary');
			if (!response.ok) {
				throw new Error(`/api/summary returned ${response.status}`);
			}
			const summary = await response.json();
			rides = summary.rides;
			charges = summary.charges;
			waypoints = summary.waypoints;
		} catch (error) {
			// Never swallowed: with no summary the map would draw a track and silently claim
			// there were no rides, charges or waypoints at all.
			loadError = (error as Error).message;
			console.error('could not load the ride summary', error);
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
			addTrackLayer(map, '/api/track');
			addChargeLayer(map, charges);
			addWaypointLayer(map, waypoints);
			applyRange();
		});
		map.once('idle', () => fitToData());
		darkMode.addEventListener('change', (event) => {
			map?.setStyle(basemapStyleUrl(event.matches));
		});
	}

	function fitToData() {
		if (map === null) {
			return;
		}
		const bounds = new LngLatBounds();
		let any = false;
		for (const feature of chargeGeoJson(visibleCharges).features) {
			bounds.extend((feature.geometry as Point).coordinates as [number, number]);
			any = true;
		}
		for (const feature of waypointGeoJson(visibleWaypoints).features) {
			bounds.extend((feature.geometry as Point).coordinates as [number, number]);
			any = true;
		}
		// The track itself is the better extent, but its features live in the worker; querying
		// the rendered ones only sees the current viewport, so the stops and waypoints are what
		// frame the first view. They span the same riding.
		if (any) {
			map.fitBounds(bounds, { padding: 48, maxZoom: 13, animate: false });
		}
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
		const stops = visibleCharges.filter(
			(charge) =>
				charge.startTs >= ride.startTs && charge.endTs <= ride.endTs && charge.lat !== null
		);
		const bounds = new LngLatBounds();
		let any = false;
		for (const stop of stops) {
			bounds.extend([stop.lon as number, stop.lat as number]);
			any = true;
		}
		// With no stop inside the ride there is nothing on the client to frame it by, so the
		// track filter is narrowed to the ride and the view left where it is rather than flying
		// somewhere wrong.
		map.setFilter('track', [
			'all',
			['>=', ['get', 'toTs'], ride.startTs],
			['<=', ['get', 'fromTs'], ride.endTs]
		]);
		if (any) {
			map.fitBounds(bounds, { padding: 80, maxZoom: 12, duration: 700 });
		}
		panelOpen = false;
	}
</script>

<svelte:head><title>Cool Eva — ride map</title></svelte:head>

<div class="flex h-screen w-screen flex-col-reverse md:flex-row">
	<aside
		class="flex shrink-0 flex-col overflow-hidden border-t md:w-96 md:border-t-0 md:border-r"
		style="background: var(--surface-raised); border-color: var(--border); {panelOpen
			? 'height: 62vh;'
			: ''}"
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
	<div bind:this={container} class="min-h-0 flex-1"></div>
</div>
