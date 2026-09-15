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

/** One rename the swap performs. `optional` marks a sibling that may legitimately vanish. */
export interface SwapMove {
  from: string;
  to: string;
  optional: boolean;
}

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
  const orphanedStaging = await leftoverStagingFiles(options.outPath);
  if (orphanedStaging.length > 0) {
    // ⚠️ Globbed, not compared against this run's own path. `runId` is a fresh ISO instant, so
    // two runs cannot collide and a guard on THIS name could never fire — an assertion that
    // cannot fail. What is real is the multi-GB file every refusal deliberately leaves behind,
    // which nothing else ever mentions again.
    outcome.refusal =
      `an earlier import left ${orphanedStaging.length} staging file(s) beside ${options.outPath}:\n` +
      orphanedStaging.map(file => `     ${file.path} (${file.bytes} bytes)`).join("\n") +
      "\n   Look at them, then delete or move them aside and re-run.";
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
    // Its backup of the staging file is stranded too — it is taken BEFORE the write — and it is
    // the same size again, so the refusal names both rather than only the one.
    const stranded = await removeRecoveryBackups(stagingPath);
    outcome.refusal =
      `the recovery's commit exited ${commitCode} — ${stagingPath} left in place` +
      (stranded.length > 0 ? `, and its backup ${stranded.join(", ")} removed` : "");
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

  const outDbPresent = await pathExists(options.outPath);
  if (outDbPresent) {
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
  }

  // ⚠️ PROBED WHETHER OR NOT `<out>` ITSELF IS THERE, and that is the whole of this block. An
  // orphan `<out>-wal` — what `rm rides.db` leaves, since it takes only the database — is
  // replayed into whatever next takes that name, so it silently REPLACES the database this
  // step just built with the remains of a different one. Measured: a 500-point import came
  // back as the donor's two rows and no route_track, reported as success. `journal_mode =
  // DELETE` does not immunise the file; that was measured too.
  const outSiblings = await siblingsOf(options.outPath);
  const stagingSiblings = await siblingsOf(stagingPath);
  if (outDbPresent) {
    outcome.replacedPath = `${options.outPath}.bak-replaced-${options.runId}`;
  } else if (outSiblings.length > 0) {
    outcome.replacedPath = `${options.outPath}.bak-orphan-${options.runId}`;
    console.log(
      `⚠️  ${outSiblings.map(suffix => options.outPath + suffix).join(", ")} sit beside no database — ` +
        `moving them to ${outcome.replacedPath}* rather than letting them be replayed into the new one`
    );
  }

  const plan = planSwap(options.outPath, stagingPath, outcome.replacedPath, {
    outDb: outDbPresent,
    outSiblings,
    stagingSiblings,
  });
  const failure = await applySwap(plan);
  if (failure !== null) {
    outcome.refusal =
      `${failure} — ⚠️ the swap was interrupted part-way. The COMPLETE database is at ${stagingPath}; ` +
      `rename it to ${options.outPath} by hand once you have looked at what is there`;
    return outcome;
  }
  outcome.ok = true;
  return outcome;
}

/**
 * The renames, in order, tolerating a sibling that disappeared under us.
 *
 * ⚠️ A `-wal` can be removed by the connection that was holding it between the probe and the
 * rename, and that is the GOOD case — there is nothing left to strand. Treating it as a fault
 * left no database at `<out>` at all and an unhandled ENOENT where the message saying where the
 * finished file went should have been. The database moves themselves are never optional.
 */
async function applySwap(plan: SwapMove[]): Promise<string | null> {
  for (const move of plan) {
    try {
      await rename(move.from, move.to);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (move.optional && code === "ENOENT") {
        console.log(`${move.from} was gone by the time the swap reached it — nothing to move`);
        continue;
      }
      return `renaming ${move.from} → ${move.to} failed: ${(error as Error).message}`;
    }
  }
  return null;
}

/**
 * Which files move where, and in which order.
 *
 * ⚠️ THE SIBLINGS MOVE WITH THEIR DATABASE — and, when there is no database left, they move
 * anyway. SQLite does not check that a journal belongs to the file it finds it beside: it
 * replays a WAL whose checksums chain from its own header, so `rides.db-wal` left next to a
 * different inode that has just taken the name `rides.db` silently replaces it. Measured on
 * this code: a 500-point import came back as a donor database's two rows, reported as success.
 * `journal_mode = DELETE` does not immunise the file against it.
 */
export function planSwap(
  outPath: string,
  stagingPath: string,
  asidePath: string | null,
  present: { outDb: boolean; outSiblings: string[]; stagingSiblings: string[] }
): SwapMove[] {
  const moves: SwapMove[] = [];
  if (asidePath !== null) {
    if (present.outDb) {
      moves.push({ from: outPath, to: asidePath, optional: false });
    }
    for (const suffix of present.outSiblings) {
      moves.push({ from: `${outPath}${suffix}`, to: `${asidePath}${suffix}`, optional: true });
    }
  }
  moves.push({ from: stagingPath, to: outPath, optional: false });
  for (const suffix of present.stagingSiblings) {
    moves.push({ from: `${stagingPath}${suffix}`, to: `${outPath}${suffix}`, optional: true });
  }
  return moves;
}

/**
 * Every file SQLite will read from beside a database of this name.
 *
 * ⚠️ `-journal` is in the set although this step's own output never has one: a rollback-mode
 * database is exactly what it produces, and a writer that dies mid-transaction leaves that
 * file rather than a `-wal`. Whether SQLite replays a stranded `-journal` into a foreign
 * database has NOT been measured here — it is the same hazard class as the WAL, and moving it
 * costs one array entry, which is cheaper than being right about it.
 */
const SIBLING_SUFFIXES = ["-wal", "-shm", "-journal"];

/** Which of those exist right now, as suffixes. */
async function siblingsOf(dbPath: string): Promise<string[]> {
  const present: string[] = [];
  for (const suffix of SIBLING_SUFFIXES) {
    if (await pathExists(`${dbPath}${suffix}`)) {
      present.push(suffix);
    }
  }
  return present;
}

/** Staging files any earlier run left beside `<out>`, which are multi-GB and easy to forget. */
async function leftoverStagingFiles(outPath: string): Promise<{ path: string; bytes: number }[]> {
  const directory = dirname(outPath);
  const prefix = `${basename(outPath)}.import-`;
  const found: { path: string; bytes: number }[] = [];
  for (const entry of await readdir(directory)) {
    if (entry.startsWith(prefix)) {
      const path = `${directory}/${entry}`;
      found.push({ path, bytes: (await sizeOf(path)) ?? 0 });
    }
  }
  return found;
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
async function removeRecoveryBackups(stagingPath: string): Promise<string[]> {
  const directory = dirname(stagingPath);
  const prefix = `${basename(stagingPath)}.bak-`;
  const removed: string[] = [];
  for (const entry of await readdir(directory)) {
    if (entry.startsWith(prefix)) {
      const path = `${directory}/${entry}`;
      const bytes = await sizeOf(path);
      // force, because a backup that vanished between the listing and here is already gone —
      // and throwing over it AFTER a successful commit would be the worst possible moment.
      await rm(path, { force: true });
      removed.push(path);
      console.log(`removed the recovery's backup of the staging file: ${path} (${bytes} bytes)`);
    }
  }
  return removed;
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

export async function pathExists(path: string): Promise<boolean> {
  return (await sizeOf(path)) !== null;
}
