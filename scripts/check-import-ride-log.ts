import Database from "better-sqlite3";
import { access, mkdtemp, readdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { commitRecovered } from "./recover-waypoints-commit.ts";
import { judgeCoverage, planSwap, runImport, type ImportOptions, type SpawnedStages } from "./ride-import.ts";

// The import step's ORCHESTRATION — which is the only part of it that moves gigabytes around,
// and was the only part with nothing testing it.
//
//   node --experimental-strip-types scripts/check-import-ride-log.ts
//
// The two child processes are injected (scripts/ride-import.ts's SpawnedStages), so every
// branch runs here in milliseconds against tiny real SQLite files: exit 2 continuing because
// "some segments were unreadable" is the NORMAL case on a /dl dump, any other non-zero code
// aborting WITHOUT a swap, the staging file surviving an abort so nothing is lost, the
// `-wal`/`-shm` siblings moving with their database, and an import that covers less than what
// it would replace being refused rather than performed.
// docs/waypoints.md §"Not losing the ride log".

/** Enough rows for MIN/MAX to mean something; the point is the file shuffling, not the data. */
const FIXTURE_ROWS = 6;
const BASE = 1_700_000_000_000;

interface Fakes {
  decryptCode: number;
  dryCode: number;
  commitCode: number;
  /** Readings the fake decrypt writes into the staging file. */
  rows?: number;
  /** ms added to every staging timestamp, so coverage can be made to shrink or grow. */
  shift?: number;
  /** Whether the fake recovery leaves a backup of the staging file behind, as the real one does. */
  leavesBackup?: boolean;
}

let failures = 0;
const workspace = await mkdtemp(join(tmpdir(), "cool-eva-import-"));

console.log("1. the exit codes that mean 'carry on' and the ones that mean 'stop'");

const clean = await importInto("clean", { decryptCode: 0, dryCode: 0, commitCode: 0 });
check(
  "a clean run swaps the new database in and keeps the old one as .bak-replaced-…",
  clean.outcome.ok &&
    clean.outcome.replacedPath !== null &&
    (await exists(clean.outcome.replacedPath ?? "")) &&
    !(await exists(clean.outcome.stagingPath))
);
check(
  "the finished file is in rollback journal mode, which is what the datasource wants",
  journalModeOf(clean.outPath) === "delete"
);
check("the materialised track came with it", clean.outcome.track !== null && clean.outcome.track.rows === FIXTURE_ROWS);

// ⚠️ decrypt-log.ts exits 2 for "N segments could not be decrypted, the rest is intact", and a
// real dump has some — 63 in the 2026-09-13 file. Treating that as fatal would make the normal
// case unimportable, so this is the branch that must NOT abort.
const partial = await importInto("partial", { decryptCode: 2, dryCode: 0, commitCode: 0 });
check(
  "exit 2 from the decrypt carries on, and says the archive lost segments",
  partial.outcome.ok && partial.outcome.unreadableSegments
);

for (const [label, fakes] of [
  ["the decrypt fails", { decryptCode: 1, dryCode: 0, commitCode: 0 }],
  ["the recovery's dry run fails", { decryptCode: 0, dryCode: 1, commitCode: 0 }],
  ["the recovery's commit fails", { decryptCode: 0, dryCode: 0, commitCode: 1 }],
] as [string, Fakes][]) {
  const run = await importInto(label.replace(/\W+/g, "-"), fakes);
  check(
    `${label}: REFUSED, the live database is untouched, and the staging file is left to look at`,
    !run.outcome.ok &&
      run.outcome.refusal !== null &&
      (await readingsIn(run.outPath)) === run.originalRows &&
      run.outcome.replacedPath === null &&
      (fakes.decryptCode === 1 || (await exists(run.outcome.stagingPath)))
  );
}

console.log("\n2. the refusals that protect the archive");

const shrunk = await importInto("shrink", { decryptCode: 0, dryCode: 0, commitCode: 0, rows: 2, shift: 60_000 });
check(
  "an import covering LESS than the database it replaces is refused",
  !shrunk.outcome.ok && /covers LESS/.test(shrunk.outcome.refusal ?? "") && (await exists(shrunk.outcome.stagingPath))
);

const allowed = await importInto(
  "shrink-allowed",
  { decryptCode: 0, dryCode: 0, commitCode: 0, rows: 2, shift: 60_000 },
  true
);
check("--allow-shrink is how you say you meant it", allowed.outcome.ok);

const busy = await importInto("busy-wal", { decryptCode: 0, dryCode: 0, commitCode: 0 }, false, async outPath => {
  await writeFile(`${outPath}-wal`, Buffer.alloc(512));
});
check(
  "a non-empty <out>-wal stops the swap — something still has that database open",
  !busy.outcome.ok && /-wal holds 512 bytes/.test(busy.outcome.refusal ?? "")
);

const occupied = join(workspace, "occupied.db");
await writeFile(`${occupied}.import-run-1`, "not a database");
const occupiedOutcome = await runImport(
  optionsFor(occupied, "run-1", false),
  fakeStages({ decryptCode: 0, dryCode: 0, commitCode: 0 })
);
check(
  "a staging file left by an earlier import stops the next one before it does anything",
  !occupiedOutcome.ok && /already exists/.test(occupiedOutcome.refusal ?? "")
);

console.log("\n3. the file shuffling itself");

const withBackup = await importInto("backup", { decryptCode: 0, dryCode: 0, commitCode: 0, leavesBackup: true });
const leftovers = (await readdir(workspace)).filter(entry => entry.includes("backup.db.import-"));
check(
  "the recovery's backup OF THE STAGING FILE is removed — it backs up a file nothing else has yet",
  withBackup.outcome.ok && leftovers.length === 0
);

const moves = planSwap("/tmp/rides.db", "/tmp/rides.db.import-x", "/tmp/rides.db.bak-replaced-x", {
  outWal: true,
  outShm: true,
  stagingWal: false,
  stagingShm: false,
});
// ⚠️ SQLite does not check that a WAL belongs to the database it finds it beside. Leaving
// rides.db-wal behind while a different inode becomes rides.db is silent corruption.
check(
  "the outgoing database's -wal and -shm move WITH it, before the new file takes its name",
  moves.length === 4 &&
    moves[0][0] === "/tmp/rides.db" &&
    moves[1][0] === "/tmp/rides.db-wal" &&
    moves[1][1] === "/tmp/rides.db.bak-replaced-x-wal" &&
    moves[2][0] === "/tmp/rides.db-shm" &&
    moves[3][1] === "/tmp/rides.db"
);
check(
  "a first import, with nothing to replace, is a single move",
  planSwap("/tmp/rides.db", "/tmp/rides.db.import-x", null, {
    outWal: false,
    outShm: false,
    stagingWal: false,
    stagingShm: false,
  }).length === 1
);

const wide = { readings: 10, minTs: 100, maxTs: 900 };
check(
  "coverage is judged on rows AND on both ends of the span",
  judgeCoverage(wide, { readings: 10, minTs: 100, maxTs: 900 }, false) === null &&
    judgeCoverage(wide, { readings: 11, minTs: 100, maxTs: 1000 }, false) === null &&
    judgeCoverage(wide, { readings: 9, minTs: 100, maxTs: 900 }, false) !== null &&
    judgeCoverage(wide, { readings: 10, minTs: 200, maxTs: 900 }, false) !== null &&
    judgeCoverage(wide, { readings: 10, minTs: 100, maxTs: 800 }, false) !== null &&
    judgeCoverage(wide, { readings: 1, minTs: 500, maxTs: 501 }, true) === null
);

console.log("\n4. the precondition the step's no-op depends on");

// recover-waypoints.ts now prints "nothing to commit" and exits 0 rather than reaching this,
// because an import whose window is already recovered is a no-op and not a failure. The throw
// stays as the write path's own guard — and nothing held it to that until here.
const guard = join(workspace, "guard.db");
schemaInto(guard, 1, 0);
let refusedEmpty = false;
try {
  await commitRecovered(guard, [], "check");
} catch (error) {
  refusedEmpty = /nothing to commit/.test((error as Error).message);
}
check("commitRecovered still refuses an empty set of verdicts", refusedEmpty);

await rm(workspace, { recursive: true, force: true });
console.log(
  failures === 0
    ? "\n✓ the import refuses everything that would cost data, and swaps only a complete database"
    : `\n✗ the import step's orchestration — ${failures} failure${failures === 1 ? "" : "s"}`
);
process.exit(failures === 0 ? 0 : 1);

function check(what: string, condition: boolean): void {
  if (condition) {
    console.log(`  ✓ ${what}`);
  } else {
    console.error(`  ✗ ${what}`);
    failures += 1;
  }
}

interface RunResult {
  outcome: Awaited<ReturnType<typeof runImport>>;
  outPath: string;
  originalRows: number;
}

/** Lays down a live database, then imports over it with the given stage outcomes. */
async function importInto(
  name: string,
  fakes: Fakes,
  allowShrink = false,
  before?: (outPath: string) => Promise<void>
): Promise<RunResult> {
  const outPath = join(workspace, `${name}.db`);
  schemaInto(outPath, FIXTURE_ROWS, 0);
  const originalRows = await readingsIn(outPath);
  if (before !== undefined) {
    await before(outPath);
  }
  const outcome = await runImport(optionsFor(outPath, name, allowShrink), fakeStages(fakes));
  return { outcome, outPath, originalRows };
}

function optionsFor(outPath: string, runId: string, allowShrink: boolean): ImportOptions {
  return {
    inputs: ["fixture.celog"],
    outPath,
    recoverFromMs: 0,
    recoverToMs: BASE + 1_000_000,
    allowShrink,
    runId,
  };
}

/** Stands in for the two child processes, writing the files the real ones would write. */
function fakeStages(fakes: Fakes): SpawnedStages {
  return {
    async decrypt(_inputs: string[], outPath: string): Promise<number> {
      if (fakes.decryptCode === 0 || fakes.decryptCode === 2) {
        schemaInto(outPath, fakes.rows ?? FIXTURE_ROWS, fakes.shift ?? 0);
      }
      return fakes.decryptCode;
    },
    async recover(dbPath: string, _fromMs: number, _toMs: number | null, commit: boolean): Promise<number> {
      if (commit && fakes.leavesBackup === true) {
        await writeFile(`${dbPath}.bak-2026-09-15T00-00-00-000Z`, "a 1.77 GB copy, in spirit");
      }
      return commit ? fakes.commitCode : fakes.dryCode;
    },
  };
}

/** src/db.ts's schema with `rows` GPS fixes a second apart, starting `shift` ms after BASE. */
function schemaInto(path: string, rows: number, shift: number): void {
  const db = new Database(path);
  // ⚠️ WAL, because that is what src/db.ts:51 leaves behind and therefore what the decrypt
  // hands this step. A fixture in SQLite's default rollback mode would make the import's
  // `journal_mode = DELETE` untestable: it would already be true before the step ran.
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE signal (id INTEGER PRIMARY KEY, key TEXT UNIQUE, unit TEXT, grp TEXT, source TEXT);
    CREATE TABLE session (id INTEGER PRIMARY KEY, uid TEXT UNIQUE);
    CREATE TABLE reading (
      ts INTEGER NOT NULL, signal_id INTEGER NOT NULL REFERENCES signal(id), value REAL NOT NULL,
      session_id INTEGER REFERENCES session(id), seq INTEGER, clock_trust TEXT
    );
    CREATE INDEX idx_reading_sig_ts ON reading(signal_id, ts);
    CREATE TABLE info (key TEXT PRIMARY KEY, value TEXT, ts INTEGER);
  `);
  const addSignal = db.prepare("INSERT INTO signal (key, unit, grp, source) VALUES (?, '', 'gps', 'stream')");
  for (const key of ["gps_lat", "gps_lon", "gps_speed_kmh", "waypoint_seq", "waypoint_lat", "waypoint_lon"]) {
    addSignal.run(key);
  }
  const addReading = db.prepare(
    "INSERT INTO reading (ts, signal_id, value) VALUES (?, (SELECT id FROM signal WHERE key = ?), ?)"
  );
  const fill = db.transaction(() => {
    for (let index = 0; index < rows; index += 1) {
      addReading.run(BASE + shift + index * 1_000, "gps_lat", 10 + index * 0.00001);
      addReading.run(BASE + shift + index * 1_000, "gps_lon", 20 + index * 0.00001);
    }
  });
  fill();
  db.close();
}

function journalModeOf(path: string): string {
  const db = new Database(path, { readonly: true });
  try {
    return String((db.pragma("journal_mode", { simple: true }) as string).toLowerCase());
  } finally {
    db.close();
  }
}

async function readingsIn(path: string): Promise<number> {
  if (!(await exists(path))) {
    return -1;
  }
  const db = new Database(path, { readonly: true });
  try {
    return (db.prepare("SELECT COUNT(*) AS n FROM reading").get() as { n: number }).n;
  } finally {
    db.close();
  }
}

async function exists(path: string): Promise<boolean> {
  if (path === "") {
    return false;
  }
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
