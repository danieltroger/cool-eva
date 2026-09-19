<script lang="ts">
	import { fixAgeClass, FIX_AGE_COLOURS, formatDateTime, formatDuration } from './format';
	import type { ChargeSession, Ride, Waypoint } from './server/snapshot';

	interface Props {
		rides: Ride[];
		charges: ChargeSession[];
		waypoints: Waypoint[];
		onSelect: (ride: Ride) => void;
	}
	let { rides, charges, waypoints, onSelect }: Props = $props();

	type TabName = 'rides' | 'charges' | 'waypoints';
	let tab = $state<TabName>('rides');

	const newestFirst = $derived([...rides].sort((left, right) => right.startTs - left.startTs));
	const chargesNewestFirst = $derived(
		[...charges].sort((left, right) => right.startTs - left.startTs)
	);
	const waypointsNewestFirst = $derived([...waypoints].sort((left, right) => right.ts - left.ts));
	// The tiles count every stop; the map can only draw the ones with a position. Saying so is
	// the honest version — an earlier Grafana panel silently under-reported by exactly these.
	const unplaceable = $derived(charges.filter((charge) => charge.lat === null).length);
</script>

<nav class="flex gap-1 px-3 pb-2 text-xs">
	{#each [['rides', `Rides ${rides.length}`], ['charges', `Charges ${charges.length}`], ['waypoints', `Waypoints ${waypoints.length}`]] as [name, label] (name)}
		<button
			class="rounded px-2 py-1"
			style="background: {tab === name ? 'var(--surface-sunken)' : 'transparent'}"
			onclick={() => (tab = name as TabName)}>{label}</button
		>
	{/each}
</nav>

<div class="min-h-0 flex-1 overflow-y-auto px-2 pb-3 text-sm">
	{#if tab === 'rides'}
		{#each newestFirst as ride (ride.startTs)}
			<button
				class="mb-1 block w-full rounded px-2 py-1.5 text-left hover:opacity-80"
				style="background: var(--surface-sunken)"
				onclick={() => onSelect(ride)}
			>
				<div class="flex justify-between gap-2">
					<span>{formatDateTime(ride.startTs)}</span>
					<span class="font-semibold">{ride.km === null ? '—' : `${ride.km} km`}</span>
				</div>
				<div class="text-xs" style="color: var(--text-dim)">
					{formatDuration(ride.endTs - ride.startTs)} · {ride.fixes} fixes{ride.topKmh === null
						? ''
						: ` · top ${ride.topKmh} km/h`}
				</div>
			</button>
		{:else}
			<p class="px-2 py-3 text-xs" style="color: var(--text-dim)">No rides in this range.</p>
		{/each}
	{:else if tab === 'charges'}
		{#if unplaceable > 0}
			<p class="px-2 pb-2 text-xs" style="color: var(--text-dim)">
				{unplaceable} of these have no known position and are not drawn — the bike logs almost no GPS
				while charging.
			</p>
		{/if}
		{#each chargesNewestFirst as charge (charge.startTs)}
			<div class="mb-1 rounded px-2 py-1.5" style="background: var(--surface-sunken)">
				<div class="flex justify-between gap-2">
					<span>{formatDateTime(charge.startTs)}</span>
					<span class="font-semibold">{(charge.whAdded / 1000).toFixed(2)} kWh</span>
				</div>
				<div class="flex items-center gap-1.5 text-xs" style="color: var(--text-dim)">
					<span
						class="inline-block h-2 w-2 rounded-full"
						style="background: {FIX_AGE_COLOURS[fixAgeClass(charge.startTs, charge.fixTs)]}"
					></span>
					{charge.chargeType} · {formatDuration(charge.endTs - charge.startTs)}
					{#if charge.socStart !== null && charge.socEnd !== null}
						· {Math.round(charge.socStart)}→{Math.round(charge.socEnd)} %
					{/if}
					{#if charge.fixTs !== null}
						· fix {formatDuration(charge.startTs - charge.fixTs)} old
					{:else}
						· no position
					{/if}
				</div>
			</div>
		{:else}
			<p class="px-2 py-3 text-xs" style="color: var(--text-dim)">No charge stops in this range.</p>
		{/each}
	{:else}
		{#each waypointsNewestFirst as point (point.ts)}
			<div class="mb-1 rounded px-2 py-1.5" style="background: var(--surface-sunken)">
				<div class="flex justify-between gap-2">
					<span>#{point.seq} · {formatDateTime(point.ts)}</span>
					<span
						class="text-xs"
						style="color: {point.verdict === 'on track' ? 'var(--text-dim)' : '#e0523f'}"
						>{point.verdict}</span
					>
				</div>
				{#if point.verdict !== 'on track'}
					<div class="text-xs" style="color: var(--text-dim)">
						Listed but not drawn: the surrounding track does not back this position up.
					</div>
				{/if}
				{#if point.provenance === 'recovered'}
					<div class="text-xs" style="color: var(--text-dim)">recovered (#192)</div>
				{/if}
			</div>
		{:else}
			<p class="px-2 py-3 text-xs" style="color: var(--text-dim)">No waypoints in this range.</p>
		{/each}
	{/if}
</div>
