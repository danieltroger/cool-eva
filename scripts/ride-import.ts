import Database from "better-sqlite3";
import { readdir, rename, rm, stat } from "fs/promises";
import { basename, dirname } from "path";
import { buildRouteTrack, routeTrackBuiltAt, type RouteTrackBuild } from "./route-track.ts";

// The import itself, with the two child processes injected so scripts/check-import-ride-log.ts
// can drive every branch without a 20-minute decrypt. scripts/import-ride-log.ts is the CLI
// that supplies the real ones; this file is where the order and the refusals live.
//
// ⚠️ The order is the argument, the same way it is in recover-waypoints-commit.ts: everything
// happens to a STAGING file, and the live database is not touched until the staging file is
// complete. `decrypt-log.ts` refuses an existing --out, so the only alternative is deleting
// rides.db before a long, OOM-prone operation — which is exactly how 2026-09-13 lost the
// recovered waypoints. docs/waypoints.md §"Not losing the ride log".

/** The two stages that run as their own process, so a check can stand in for them. */
export interface SpawnedStages {
  decrypt(inputs: string[], outPath: string): Promise<number>;
  recover(dbPath: string, fromMs: number, toMs: number | null, commit: boolean): Promise<number>;
}

export interface ImportOptions {
  inputs: string[];
  outPath: string;
  recoverFromMs: number;
  recoverToMs: number;
  allowShrink: boolean;
  runId: string;
}

/** What the archive covers, for the guard that refuses to replace it with less. */
export interface ArchiveSurvey {
  readings: number;
  minTs: number | null;
  maxTs: number | null;
}

export interface ImportOutcome {
  ok: boolean;
  /** Why it stopped, or null when it finished. */
  refusal: string | null;
  stagingPath: string;
  replacedPath: string | null;
  unreadableSegments: boolean;
  before: ArchiveSurvey | null;
  after: ArchiveSurvey | null;
  track: RouteTrackBuild | null;
}

/**
 * Decrypt → recover → materialise → swap, refusing rather than guessing at every edge.
 *
 * Returns rather than throws for a refusal the operator can act on; a genuine fault (a
 * corrupt staging database, a rename that cannot happen) still throws.
 */
export async function runImport(options: ImportOptions, stages: SpawnedStages): Promise<ImportOutcome> {
  const stagingPath = `${options.outPath}.import-${options.runId}`;
  const outcome: ImportOutcome = {
    ok: false,
    refusal: null,
    stagingPath,
    replacedPath: null,
    unreadableSegments: false,
    before: null,
    after: null,
    track: null,
  };
  if (await pathExists(stagingPath)) {
    outcome.refusal = `${stagingPath} already exists — an earlier import stopped here; move it aside first`;
    return outcome;
  }

  console.log(`\n──── 1/4 decrypt → ${stagingPath}`);
  const decryptCode = await stages.decrypt(options.inputs, stagingPath);
  // ⚠️ Exit 2 is NOT a failure: decrypt-log.ts:142 uses it for "N segments could not be
  // decrypted, the rest is intact", and a real /dl dump has some — 63 in the 2026-09-13 file
  // (docs/dc-taper.md). Treating it as fatal would make the normal case unimportable.
  if (decryptCode !== 0 && decryptCode !== 2) {
    outcome.refusal = `decrypt exited ${decryptCode} — ${stagingPath} left in place, nothing was swapped`;
    return outcome;
  }
  outcome.unreadableSegments = decryptCode === 2;

  // The whole archive first, and only reported: it is what says which holds fall OUTSIDE the
  // window the commit runs over, so a cut-off can no longer drop a waypoint silently.
  console.log("\n──── 2/4 waypoint recovery — what the whole archive holds (nothing is written)");
  const surveyCode = await stages.recover(stagingPath, 0, null, false);
  if (surveyCode !== 0) {
    outcome.refusal = `the recovery's dry run exited ${surveyCode} — ${stagingPath} left in place`;
    return outcome;
  }

  console.log(
    `\n──── 3/4 waypoint recovery — committing ${new Date(options.recoverFromMs).toISOString()} → ` +
      `${new Date(options.recoverToMs).toISOString()}`
  );
  const commitCode = await stages.recover(stagingPath, options.recoverFromMs, options.recoverToMs, true);
  if (commitCode !== 0) {
    outcome.refusal = `the recovery's commit exited ${commitCode} — ${stagingPath} left in place`;
    return outcome;
  }
  await removeRecoveryBackups(stagingPath);

  console.log("\n──── 4/4 materialise the route track");
  const staging = new Database(stagingPath);
  outcome.track = buildRouteTrack(staging);
  outcome.after = surveyArchive(staging);
  // ⚠️ LAST, and on the staging copy only. grafana/README.md §"rides.db is in WAL mode, and
  // that silently blanks panels" measured the datasource blanking 3 of 85 queries over a WAL
  // file against 0 of 85 over a rollback one, and names this step as where to set it. The
  // same section measures DELETE as the wrong mode for a file a logger is appending to — 53
  // of 85 — which is why it is set here, on a static file, and never on the Pi's.
  staging.pragma("journal_mode = DELETE");
  staging.close();
  console.log(`route_track: ${outcome.track.rows} points in ${outcome.track.ms.toFixed(0)} ms, journal_mode = delete`);

  if (await pathExists(options.outPath)) {
    const before = surveyExisting(options.outPath);
    outcome.before = before;
    const shrink = judgeCoverage(before, outcome.after, options.allowShrink);
    if (shrink !== null) {
      outcome.refusal = `${shrink} — ${stagingPath} left in place; pass --allow-shrink if that is what you meant`;
      return outcome;
    }
    const walBytes = await sizeOf(`${options.outPath}-wal`);
    if (walBytes !== null && walBytes > 0) {
      outcome.refusal =
        `${options.outPath}-wal holds ${walBytes} bytes — something still has that database open. ` +
        `Close it and re-run; ${stagingPath} is complete and left in place`;
      return outcome;
    }
    outcome.replacedPath = `${options.outPath}.bak-replaced-${options.runId}`;
  }

  const plan = planSwap(options.outPath, stagingPath, outcome.replacedPath, {
    outWal: (await sizeOf(`${options.outPath}-wal`)) !== null,
    outShm: (await sizeOf(`${options.outPath}-shm`)) !== null,
    stagingWal: (await sizeOf(`${stagingPath}-wal`)) !== null,
    stagingShm: (await sizeOf(`${stagingPath}-shm`)) !== null,
  });
  for (const [from, to] of plan) {
    await rename(from, to);
  }
  outcome.ok = true;
  return outcome;
}

/**
 * Which files move where, and in which order.
 *
 * ⚠️ THE `-wal`/`-shm` SIBLINGS MOVE WITH THEIR DATABASE, and that is the whole reason this
 * is a function rather than two `rename` calls. SQLite does not check that a WAL belongs to
 * the file it finds it beside — it replays frames whose checksums chain from the WAL header —
 * so leaving `rides.db-wal` behind while a different inode becomes `rides.db` is silent
 * corruption of the file the import just spent twenty minutes building. Renaming them to the
 * outgoing database's own new name keeps each pair together and recoverable.
 */
export function planSwap(
  outPath: string,
  stagingPath: string,
  replacedPath: string | null,
  present: { outWal: boolean; outShm: boolean; stagingWal: boolean; stagingShm: boolean }
): [string, string][] {
  const moves: [string, string][] = [];
  if (replacedPath !== null) {
    moves.push([outPath, replacedPath]);
    if (present.outWal) {
      moves.push([`${outPath}-wal`, `${replacedPath}-wal`]);
    }
    if (present.outShm) {
      moves.push([`${outPath}-shm`, `${replacedPath}-shm`]);
    }
  }
  moves.push([stagingPath, outPath]);
  if (present.stagingWal) {
    moves.push([`${stagingPath}-wal`, `${outPath}-wal`]);
  }
  if (present.stagingShm) {
    moves.push([`${stagingPath}-shm`, `${outPath}-shm`]);
  }
  return moves;
}

/**
 * Refuses an import that covers less than what it would replace.
 *
 * Point the step at one day file instead of the cumulative dump and the archive becomes one
 * day. The old file survives as `.bak-replaced-…`, but Grafana, `route_track` and the next
 * recovery all run against the truncated one — the 2026-09-13 shape again, one step removed.
 */
export function judgeCoverage(before: ArchiveSurvey, after: ArchiveSurvey, allowShrink: boolean): string | null {
  if (allowShrink) {
    return null;
  }
  const losses: string[] = [];
  if (after.readings < before.readings) {
    losses.push(`${before.readings} readings would become ${after.readings}`);
  }
  if (before.minTs !== null && (after.minTs === null || after.minTs > before.minTs)) {
    losses.push(`the archive would start at ${isoOf(after.minTs)} instead of ${isoOf(before.minTs)}`);
  }
  if (before.maxTs !== null && (after.maxTs === null || after.maxTs < before.maxTs)) {
    losses.push(`the archive would end at ${isoOf(after.maxTs)} instead of ${isoOf(before.maxTs)}`);
  }
  return losses.length === 0
    ? null
    : `this import covers LESS than the database it would replace: ${losses.join("; ")}`;
}

/** Rows and span, excluding the 2060 rows every dashboard excludes by name. */
export function surveyArchive(db: Database.Database): ArchiveSurvey {
  const row = db
    .prepare("SELECT COUNT(*) AS readings, MIN(ts) AS minTs, MAX(ts) AS maxTs FROM reading WHERE ts < 2000000000000")
    .get() as ArchiveSurvey;
  return row;
}

/** When `dbPath`'s track was last built, for the line the import prints before replacing it. */
export function readTrackAge(dbPath: string): string | null {
  const db = new Database(dbPath, { readonly: true });
  try {
    return routeTrackBuiltAt(db);
  } finally {
    db.close();
  }
}

function surveyExisting(dbPath: string): ArchiveSurvey {
  const db = new Database(dbPath, { readonly: true });
  try {
    return surveyArchive(db);
  } finally {
    db.close();
  }
}

/**
 * Deletes the backup `commitRecovered` takes of the STAGING file.
 *
 * It copies the whole database before opening a writable handle, which is right when the
 * target is Daniel's only copy and pure waste when the target is a file this step built
 * minutes ago and is about to rename. The staging prefix is unique per run, so anything
 * matching it was created by the stage that just ran.
 */
async function removeRecoveryBackups(stagingPath: string): Promise<void> {
  const directory = dirname(stagingPath);
  const prefix = `${basename(stagingPath)}.bak-`;
  for (const entry of await readdir(directory)) {
    if (entry.startsWith(prefix)) {
      const path = `${directory}/${entry}`;
      const bytes = await sizeOf(path);
      await rm(path);
      console.log(`removed the recovery's backup of the staging file: ${path} (${bytes} bytes)`);
    }
  }
}

function isoOf(ts: number | null): string {
  return ts === null ? "nothing" : new Date(ts).toISOString();
}

async function sizeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  return (await sizeOf(path)) !== null;
}
