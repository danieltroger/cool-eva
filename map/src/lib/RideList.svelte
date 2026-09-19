<script lang="ts">
	import { chargeFacts } from './chargeFacts';
	import { formatDateTime, formatDuration } from './format';
	import type { ChargeSession, Ride, Waypoint } from './server/snapshot';

	interface Props {
		rides: Ride[];
		charges: ChargeSession[];
		waypoints: Waypoint[];
		onSelect: (ride: Ride) => void;
		onSelectCharge: (charge: ChargeSession) => void;
		onSelectWaypoint: (point: Waypoint) => void;
	}
	let { rides, charges, waypoints, onSelect, onSelectCharge, onSelectWaypoint }: Props = $props();

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
			{@const facts = chargeFacts(charge)}
			<!-- ⚠️ Only a placeable stop is a button. 2 of 50 on the real archive have no position
			     at all — the hub sleeps while charging — and a row that flies nowhere when clicked
			     reads as broken rather than as honest. The same six fields as the map tooltip,
			     from the same chargeFacts(). -->
			<button
				class="mb-1 block w-full rounded px-2 py-1.5 text-left enabled:hover:opacity-80"
				style="background: var(--surface-sunken)"
				disabled={!facts.placeable}
				title={facts.placeable ? 'Show on the map' : 'No position was logged for this stop'}
				onclick={() => onSelectCharge(charge)}
			>
				<div class="flex justify-between gap-2">
					<span>{facts.startedAt}</span>
					<span class="font-semibold">{facts.kwh}</span>
				</div>
				<div class="flex items-center gap-1.5 text-xs" style="color: var(--text-dim)">
					<span class="inline-block h-2 w-2 rounded-full" style="background: {facts.colour}"></span>
					{facts.chargeType} · {facts.duration}{facts.socDelta === null
						? ''
						: ` · ${facts.socDelta}`} ·
					{facts.fixAge}
				</div>
			</button>
		{:else}
			<p class="px-2 py-3 text-xs" style="color: var(--text-dim)">No charge stops in this range.</p>
		{/each}
	{:else}
		{#each waypointsNewestFirst as point (point.ts)}
			{@const drawn = point.verdict === 'on track' && point.lat !== null && point.lon !== null}
			<!-- A disabled button rather than a div: "this row cannot be actioned" is exactly what
			     `disabled` means, and screen readers and keyboard focus get it for free. -->
			<button
				class="mb-1 block w-full rounded px-2 py-1.5 text-left enabled:hover:opacity-80"
				style="background: var(--surface-sunken)"
				disabled={!drawn}
				title={drawn ? 'Show on the map' : 'Not drawn: the surrounding track does not back this up'}
				onclick={() => onSelectWaypoint(point)}
			>
				<div class="flex justify-between gap-2">
					<span>#{point.seq} · {formatDateTime(point.ts)}</span>
					<span
						class="text-xs"
						style="color: {point.verdict === 'on track' ? 'var(--text-dim)' : '#e0523f'}"
						>{point.verdict}</span
					>
				</div>
				{#if !drawn}
					<div class="text-xs" style="color: var(--text-dim)">
						Listed but not drawn: the surrounding track does not back this position up.
					</div>
				{/if}
				{#if point.provenance === 'recovered'}
					<div class="text-xs" style="color: var(--text-dim)">recovered (#192)</div>
				{/if}
			</button>
		{:else}
			<p class="px-2 py-3 text-xs" style="color: var(--text-dim)">No waypoints in this range.</p>
		{/each}
	{/if}
</div>
