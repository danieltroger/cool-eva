// Display helpers. Kept apart from the components so a wrong unit is one edit and one test.

/** `4 h 12 min`, `47 min`, `38 s` — the coarsest unit that still says something. */
export function formatDuration(milliseconds: number): string {
	const totalMinutes = Math.round(milliseconds / 60000);
	if (totalMinutes < 1) {
		return `${Math.round(milliseconds / 1000)} s`;
	}
	if (totalMinutes < 60) {
		return `${totalMinutes} min`;
	}
	return `${Math.floor(totalMinutes / 60)} h ${String(totalMinutes % 60).padStart(2, '0')} min`;
}

export function formatDateTime(epochMs: number): string {
	return new Date(epochMs).toLocaleString(undefined, {
		year: 'numeric',
		month: 'short',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit'
	});
}

export function formatDate(epochMs: number): string {
	return new Date(epochMs).toLocaleDateString(undefined, {
		year: 'numeric',
		month: 'short',
		day: '2-digit'
	});
}

/**
 * How stale a charge stop's inherited position is, as a class rather than a number.
 *
 * ⚠️ This is the dashboard's `Fix age (min)` colour and NOT the charge duration — the Grafana
 * legend shows the three classes without naming the field, which is how a brief came to
 * describe these dots as coloured by how long the bike charged. The bike logs almost no GPS
 * while charging, so a stop is drawn at the last fix from BEFORE it was plugged in, and this
 * says how much to trust that pin.
 */
export function fixAgeClass(
	startTs: number,
	fixTs: number | null
): 'fresh' | 'stale' | 'ancient' | 'unknown' {
	if (fixTs === null) {
		return 'unknown';
	}
	const minutes = (startTs - fixTs) / 60000;
	if (minutes < 30) {
		return 'fresh';
	}
	if (minutes < 360) {
		return 'stale';
	}
	return 'ancient';
}

export const FIX_AGE_COLOURS: Record<string, string> = {
	fresh: '#2fae63',
	stale: '#eab839',
	ancient: '#e0523f',
	unknown: '#8a8f98'
};

/** The speed-band ramp, matching src/lib/track.ts's BAND_EDGES_KMH. Index -1 is "no reading". */
export const BAND_COLOURS = ['#4a90d9', '#4fbfa8', '#e8d44d', '#ef9234', '#e0523f'];
export const NO_SPEED_COLOUR = '#8a8f98';

export function bandLabel(band: number, edges: number[]): string {
	if (band < 0) {
		return 'no reading';
	}
	if (band === 0) {
		return `< ${edges[0]} km/h`;
	}
	if (band >= edges.length) {
		return `${edges[edges.length - 1]}+ km/h`;
	}
	return `${edges[band - 1]}–${edges[band]} km/h`;
}
