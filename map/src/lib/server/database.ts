import Database from 'better-sqlite3';
import { stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Read-only access to the ride log. Everything this viewer draws comes from here and nothing
// ever writes to it: the file is opened `readonly`, and `query_only` makes that a property of
// the connection rather than of our own discipline.
//
// ⚠️ `better-sqlite3` is synchronous, which CLAUDE.md bans everywhere else. It is the repo's
// one standing exception, and it is safe here for a reason that does not hold on the Pi: this
// process serves one person on a laptop and has no CAN handler or WebSocket to stall.

/** Where the ride log lives, and the identity of the exact file we opened. */
export interface OpenRideLog {
	database: Database.Database;
	path: string;
	identity: FileIdentity;
}

/**
 * What the snapshot cache is keyed on.
 *
 * ⚠️ `inode` is the load-bearing field, not `mtimeMs`. `scripts/ride-import.ts` replaces the
 * database by `rename()` (its `applySwap`), so a new archive is a NEW INODE and the old one
 * survives under `.bak-replaced-<runId>` — measured on this machine at 147212349 against the
 * displaced 146216728. Keying on the inode means a cache written against a file that has since
 * been replaced can never match, so every failure mode is a rebuild rather than a silent stale
 * serve. mtime and size are kept beside it to catch an in-place write, which the import does
 * not do today but nothing prevents.
 */
export interface FileIdentity {
	inode: number;
	sizeBytes: number;
	mtimeMs: number;
}

/**
 * Opens the ride log read-only and records which file it actually is.
 *
 * ⚠️ The identity is read AFTER the open, and the caller must read it again after finishing its
 * queries and discard the result if the two disagree — see `identityUnchanged`. `better-sqlite3`
 * exposes no file descriptor (its `Database` carries exactly `name`, `open`, `inTransaction`,
 * `readonly`, `memory`, and nothing descriptor-shaped on the prototype), so there is no `fstat`
 * to make this atomic. Stat-open-stat is the substitute, and the inode in the key is what makes
 * the residual race self-healing instead of silent.
 */
export async function openRideLog(explicitPath?: string): Promise<OpenRideLog> {
	const path = explicitPath ?? defaultRideLogPath();
	const database = new Database(path, { readonly: true, fileMustExist: true });
	database.pragma('query_only = 1');
	return { database, path, identity: await identityOf(path) };
}

/** True when the path still refers to the same file we opened. */
export async function identityUnchanged(open: OpenRideLog): Promise<boolean> {
	const now = await identityOf(open.path);
	return (
		now.inode === open.identity.inode &&
		now.sizeBytes === open.identity.sizeBytes &&
		now.mtimeMs === open.identity.mtimeMs
	);
}

export async function identityOf(path: string): Promise<FileIdentity> {
	const stats = await stat(path);
	return { inode: stats.ino, sizeBytes: stats.size, mtimeMs: stats.mtimeMs };
}

/**
 * `rides.db` beside the repo root, which is where README.md §Grafana and the Docker datasource
 * both expect it. `RIDES_DB` overrides it, which is how this runs against a copy — or from a
 * git worktree, where the real archive is over in the main checkout.
 */
export function defaultRideLogPath(): string {
	const fromEnvironment = process.env.RIDES_DB;
	if (fromEnvironment !== undefined && fromEnvironment !== '') {
		return resolve(fromEnvironment);
	}
	return resolve(dirname(fileURLToPath(import.meta.url)), '../../../..', 'rides.db');
}
