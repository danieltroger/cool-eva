<script lang="ts">
	import { bandLabel, BAND_COLOURS, NO_SPEED_COLOUR } from './format';
	import { BAND_EDGES_KMH } from './track';
	import type { BasemapKind } from './basemap';

	// The sidebar's head: range, basemap and marker chips, the three tiles and the speed legend.
	// Split out of +page.svelte when that passed 400 lines (CLAUDE.md §"Split files early") —
	// this is the part that is about presenting controls, and the page is the part that owns
	// the map. Everything here is props in, callbacks out; it holds no state of its own.

	interface Props {
		rangeDays: number | null;
		basemapKind: BasemapKind;
		showCharges: boolean;
		showWaypoints: boolean;
		distanceKm: number;
		chargeCount: number;
		energyKwh: number;
		panelOpen: boolean;
		onRange: (days: number | null) => void;
		onBasemap: (kind: BasemapKind) => void;
		onToggleCharges: () => void;
		onToggleWaypoints: () => void;
		onTogglePanel: () => void;
	}
	let {
		rangeDays,
		basemapKind,
		showCharges,
		showWaypoints,
		distanceKm,
		chargeCount,
		energyKwh,
		panelOpen,
		onRange,
		onBasemap,
		onToggleCharges,
		onToggleWaypoints,
		onTogglePanel
	}: Props = $props();

	const RANGES = [
		{ label: 'All', days: null },
		{ label: '90 d', days: 90 },
		{ label: '30 d', days: 30 },
		{ label: '7 d', days: 7 }
	];
</script>

<!-- flex-wrap, not overflow-hidden: three more chips do not fit on one 390 px row, and
	     clipping them would hide a control rather than move it. -->
<header class="flex flex-wrap items-center gap-2 px-3 py-2" style="border-color: var(--border)">
	<button
		class="rounded px-2 py-1 text-sm md:hidden"
		style="background: var(--surface-sunken)"
		onclick={onTogglePanel}
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
					: 'var(--surface-sunken)'}; color: {rangeDays === range.days ? '#fff' : 'var(--text)'}"
				onclick={() => onRange(range.days)}>{range.label}</button
			>
		{/each}
	</div>
	<div class="flex w-full flex-wrap gap-1">
		<button
			class="rounded px-2 py-1 text-xs"
			style="background: {basemapKind === 'satellite'
				? 'var(--accent)'
				: 'var(--surface-sunken)'}; color: {basemapKind === 'satellite' ? '#fff' : 'var(--text)'}"
			aria-pressed={basemapKind === 'satellite'}
			onclick={() => onBasemap(basemapKind === 'satellite' ? 'map' : 'satellite')}>Satellite</button
		>
		<!-- ⚠️ A filled vs hollow bullet, not just opacity. Dimming alone reads as "this control
		     is disabled" rather than "this layer is hidden", and all three chips then look
		     alike — which is how a reviewer read the first version. -->
		<button
			class="rounded px-2 py-1 text-xs"
			style="background: var(--surface-sunken); opacity: {showCharges ? 1 : 0.6}"
			aria-pressed={showCharges}
			onclick={onToggleCharges}>{showCharges ? '●' : '○'} Charges</button
		>
		<button
			class="rounded px-2 py-1 text-xs"
			style="background: var(--surface-sunken); opacity: {showWaypoints ? 1 : 0.6}"
			aria-pressed={showWaypoints}
			onclick={onToggleWaypoints}>{showWaypoints ? '●' : '○'} Waypoints</button
		>
	</div>
</header>

<div class="grid grid-cols-3 gap-px px-3 pb-2 text-center">
	<div>
		<div class="text-lg font-semibold">{distanceKm.toFixed(0)}</div>
		<div class="text-xs" style="color: var(--text-dim)">km</div>
	</div>
	<div>
		<div class="text-lg font-semibold">{chargeCount}</div>
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
