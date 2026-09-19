import type { ChargeSession } from './server/snapshot.ts';
import { fixAgeClass, FIX_AGE_COLOURS, formatDateTime, formatDuration } from './format.ts';

// What a charge stop says about itself, in one place.
//
// ⚠️ Relative imports here carry an explicit `.ts`, unlike the rest of `map/`. That is not a
// style choice: scripts/check-ride-map.ts imports this module under plain Node ESM, which does
// not guess extensions, and a module the check cannot load is a module the check cannot cover.
//
// ⚠️ The list row and the map tooltip show the same six fields, and the whole reason this
// module exists is that they must not be able to disagree. `chargeColour()` was a second copy
// of the fix-age thresholds once already, so a pin and its row could have coloured the same
// staleness differently. Anything the two surfaces both display is derived here.

export interface ChargeFacts {
	startedAt: string;
	duration: string;
	kwh: string;
	/** `62 → 91 %`, or null where the pack did not report either end. */
	socDelta: string | null;
	/** `AC`, `DC`, or `?` where the session predates the discriminator. */
	chargeType: string;
	/** How stale the inherited position is, in words — or that there is none. */
	fixAge: string;
	colour: string;
	placeable: boolean;
}

export function chargeFacts(charge: ChargeSession): ChargeFacts {
	return {
		startedAt: formatDateTime(charge.startTs),
		duration: formatDuration(charge.endTs - charge.startTs),
		kwh: `${(charge.whAdded / 1000).toFixed(2)} kWh`,
		socDelta:
			charge.socStart === null || charge.socEnd === null
				? null
				: `${Math.round(charge.socStart)} → ${Math.round(charge.socEnd)} %`,
		chargeType: charge.chargeType,
		// A stop is drawn at the last fix from BEFORE the bike was plugged in, because the hub
		// sleeps while charging. Saying how old that is, in the same words in both places, is
		// what keeps a ten-day-old pin from reading as a measurement.
		fixAge:
			charge.fixTs === null
				? 'no position logged'
				: `fix ${formatDuration(charge.startTs - charge.fixTs)} old`,
		colour: FIX_AGE_COLOURS[fixAgeClass(charge.startTs, charge.fixTs)],
		placeable: charge.lat !== null && charge.lon !== null
	};
}

/**
 * How far to zoom when flying to a stop.
 *
 * ⚠️ Not a constant. The position is inherited from before plug-in and can be days old, so
 * zooming to street level on a pin whose own `fixAge` says "14 h old" would claim a precision
 * `fixAgeClass` explicitly refuses to. The zoom matches the confidence.
 */
export function chargeFlyZoom(charge: ChargeSession): number {
	const staleness = fixAgeClass(charge.startTs, charge.fixTs);
	if (staleness === 'fresh') {
		return 14;
	}
	if (staleness === 'stale') {
		return 12;
	}
	return 9;
}
