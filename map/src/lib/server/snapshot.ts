import { createHash } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { identityOf, identityUnchanged, openRideLog, type FileIdentity } from './database';
import { CHARGE_SESSIONS_SQL, RIDES_SQL, WAYPOINTS_SQL } from './queries';

// Everything the viewer shows except the track itself, computed once and kept beside the
// database. Measured: building it takes 16–22 s against the real archive, and reading it back
// takes 0.2 ms for ~72 KB — so it is persisted, not rebuilt per start. docs/ride-map.md
// §"The startup snapshot, and why it is persisted" has the numbers.

export interface ChargeSession {
	startTs: number;
	endTs: number;
	lat: number | null;
	lon: number | null;
	fixTs: number | null;
	whAdded: number;
	socStart: number | null;
	socEnd: number | null;
	chargeType: string;
}

export interface Ride {
	startTs: number;
	endTs: number;
	fixes: number;
	km: number | null;
	topKmh: number | null;
}

export interface Waypoint {
	ts: number;
	seq: number;
	provenance: string;
	lat: number | null;
	lon: number | null;
	verdict: string;
}

export interface Snapshot {
	/** Which exact file this was computed from. The cache is void if any field moves. */
	identity: FileIdentity;
	/** Which queries produced it — see `QUERY_FINGERPRINT`. */
	queryFingerprint: string;
	builtAtIso: string;
	buildMs: number;
	charges: ChargeSession[];
	rides: Ride[];
	waypoints: Waypoint[];
}

/**
 * The snapshot for this database, from cache when it is still valid and rebuilt when not.
 *
 * ⚠️ The validity test is `inode + size + mtime + query fingerprint`, and the inode is the one
 * that matters. `scripts/ride-import.ts` replaces the archive by `rename()`, so a new import
 * is a new inode and a cache written against the old one can never match — every failure is a
 * rebuild rather than a silent stale serve. The fingerprint is there because phase 1 edits
 * these queries daily and the database does not change when they do.
 */
export async function loadSnapshot(databasePath?: string): Promise<Snapshot> {
	const open = await openRideLog(databasePath);
	const cachePath = cachePathFor(open.path);
	try {
		const cached = await readCache(cachePath);
		if (cached !== null && isValidFor(cached, open.identity)) {
			return cached;
		}
		const snapshot = await build(open.database, open.identity);
		// ⚠️ Re-stat AFTER the queries: better-sqlite3 exposes no file descriptor, so there is
		// no fstat to make "these rows came from this file" atomic. If the archive was replaced
		// while we read it, our rows came from the old inode and writing the cache would key
		// stale data to a file that no longer holds it. Publishing nothing is the right answer;
		// the next start rebuilds.
		if (await identityUnchanged(open)) {
			await writeCache(cachePath, snapshot);
		} else {
			console.warn(`${open.path} was replaced while the snapshot was building — not caching it`);
		}
		return snapshot;
	} finally {
		open.database.close();
	}
}

/** `<database>.mapcache`, which `.gitignore`'s `rides.db*` already covers. */
export function cachePathFor(databasePath: string): string {
	// ⚠️ Extensionless on purpose. Measured: `prettier --write .` leaves `rides.db.mapcache`
	// alone and REWRITES `rides.db.mapcache.json`, which would corrupt a cache in place.
	return `${databasePath}.mapcache`;
}

/**
 * Changes whenever the SQL does, so an edited query invalidates the cache the database cannot.
 */
export const QUERY_FINGERPRINT = createHash('sha256')
	.update(CHARGE_SESSIONS_SQL)
	.update(RIDES_SQL)
	.update(WAYPOINTS_SQL)
	.digest('hex')
	.slice(0, 16);

function isValidFor(snapshot: Snapshot, identity: FileIdentity): boolean {
	return (
		snapshot.queryFingerprint === QUERY_FINGERPRINT &&
		snapshot.identity.inode === identity.inode &&
		snapshot.identity.sizeBytes === identity.sizeBytes &&
		snapshot.identity.mtimeMs === identity.mtimeMs
	);
}

async function build(
	database: import('better-sqlite3').Database,
	identity: FileIdentity
): Promise<Snapshot> {
	const startedAt = performance.now();
	const charges = database.prepare(CHARGE_SESSIONS_SQL).all() as ChargeSession[];
	const rides = database.prepare(RIDES_SQL).all() as Ride[];
	const waypoints = database.prepare(WAYPOINTS_SQL).all() as Waypoint[];
	return {
		identity,
		queryFingerprint: QUERY_FINGERPRINT,
		builtAtIso: new Date().toISOString(),
		buildMs: Math.round(performance.now() - startedAt),
		charges,
		rides,
		waypoints
	};
}

async function readCache(cachePath: string): Promise<Snapshot | null> {
	try {
		return JSON.parse(await readFile(cachePath, 'utf8')) as Snapshot;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== 'ENOENT') {
			// A truncated or hand-edited cache is recoverable — rebuild — but never silently:
			// this is the file that would otherwise serve wrong answers for weeks.
			console.warn(`ignoring unreadable snapshot cache ${cachePath}: ${(error as Error).message}`);
		}
		return null;
	}
}

/** Write to a unique temporary name and `rename` into place, so a reader never sees a partial file. */
async function writeCache(cachePath: string, snapshot: Snapshot): Promise<void> {
	const temporaryPath = `${cachePath}.tmp-${process.pid}-${Date.now()}`;
	try {
		await writeFile(temporaryPath, JSON.stringify(snapshot), 'utf8');
		await rename(temporaryPath, cachePath);
	} catch (error) {
		console.warn(`could not write snapshot cache ${cachePath}: ${(error as Error).message}`);
		await unlink(temporaryPath).catch((cleanupError) => {
			console.warn(`and could not remove ${temporaryPath}: ${(cleanupError as Error).message}`);
		});
	}
}

export { identityOf };
