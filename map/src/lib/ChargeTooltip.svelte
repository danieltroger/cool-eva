<script lang="ts">
	import { chargeFacts } from './chargeFacts';
	import type { ChargeSession } from './server/snapshot';

	// The hover card on a charge dot. Every field comes from chargeFacts(), which is also what
	// the list row renders — the two surfaces cannot drift because there is one function.

	interface Props {
		charge: ChargeSession | null;
		at: { x: number; y: number } | null;
		/** The map's own box, so the card can be kept inside it on both axes. */
		within: { width: number; height: number };
	}
	let { charge, at, within }: Props = $props();
</script>

{#if charge !== null && at !== null}
	{@const facts = chargeFacts(charge)}
	<!-- Clamped on BOTH axes against the map's own size. A bare `Math.min(x, 240)` put the
		     tooltip off the bottom of a phone whenever the dot was low in the viewport. -->
	<div
		class="pointer-events-none absolute z-20 w-48 rounded px-2.5 py-1.5 text-xs shadow-lg"
		style="left: {Math.max(4, Math.min(at.x + 14, within.width - 200))}px; top: {Math.max(
			4,
			Math.min(at.y + 14, within.height - 90)
		)}px; background: var(--surface-raised); color: var(--text); border: 1px solid var(--border)"
	>
		<div class="flex items-center gap-1.5 font-semibold">
			<span class="inline-block h-2 w-2 rounded-full" style="background: {facts.colour}"></span>
			{facts.startedAt}
		</div>
		<div style="color: var(--text-dim)">
			{facts.chargeType} · {facts.duration} · {facts.kwh}{facts.socDelta === null
				? ''
				: ` · ${facts.socDelta}`}
		</div>
		<div style="color: var(--text-dim)">{facts.fixAge}</div>
	</div>
{/if}
