import Database from 'better-sqlite3';
import { access, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

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
	if (!(await pathExists(path))) {
		// better-sqlite3's own message is `unable to open database file`, which names neither the
		// path it tried nor the way to fix it.
		throw new Error(
			`no ride log at ${path} — run this from map/ with rides.db at the repo root, ` +
				`or point RIDES_DB at one (RIDES_DB=/path/to/rides.db npm run dev)`
		);
	}
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
 * `rides.db` one level above the working directory — the repo root, since this package is run
 * from `map/`. `RIDES_DB` overrides it, which is how it runs against a copy, a fixture, or a
 * git worktree where the real archive lives in the main checkout.
 *
 * ⚠️ DERIVED FROM `process.cwd()`, NOT FROM `import.meta.url`, and that is the whole point. The
 * first version walked four directories up from this module, which is the repo root under
 * `vite dev` — and `map/` in the adapter-node build, because the bundler emits this code to
 * `build/server/chunks/chunks/`, one level deeper. Measured: the built server answered
 * `/api/summary` with 500 and `SqliteError: unable to open database file` while dev was fine.
 * A path that depends on how the bundler happened to nest its output is not a path.
 */
export function defaultRideLogPath(): string {
	const fromEnvironment = process.env.RIDES_DB;
	if (fromEnvironment !== undefined && fromEnvironment !== '') {
		return resolve(fromEnvironment);
	}
	return resolve(process.cwd(), '..', 'rides.db');
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch (error) {
		// ENOENT is the expected answer here and says nothing worth logging; anything else —
		// a permission problem, a broken symlink — is worth saying out loud before we report
		// the file as simply missing.
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== 'ENOENT') {
			console.warn(`could not stat ${path}: ${(error as Error).message}`);
		}
		return false;
	}
}
