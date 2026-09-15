import Database from "better-sqlite3";
import { spawn } from "child_process";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { buildRouteTrack } from "./route-track.ts";
import { pathExists, readTrackAge, runImport, type ImportOptions, type SpawnedStages } from "./ride-import.ts";

// One command for "the bike has new rides in it": decrypt the sealed log, put back the
// waypoints a rebuild would otherwise drop, and materialise the map's track.
//
//   node --experimental-strip-types scripts/import-ride-log.ts ~/…/ride-logs --out rides.db
//   node --experimental-strip-types scripts/import-ride-log.ts --materialise-only rides.db
//
// ⚠️ Measured at 3 min 55 s for 26 inputs and 45 921 309 readings: ~113 s to decrypt and
// judge, ~118 s for the recovery's commit (it copies and checksums the whole database), and
// 1.7 s to materialise. It scales with the ARCHIVE, not with what is new. README.md
// §Grafana has the recipe and which files to point it at; scripts/ride-import.ts has the
// order and the refusals; docs/waypoints.md §"Not losing the ride log" has why it exists.

/**
 * The instant the bike stopped running the beat `recover-waypoints.ts` models.
 *
 * ⚠️ Its `BEAT_MS_ON_THE_RECOVERY_DAYS = 100` and `LEGACY_HOLD_MS = 1000` are historical
 * FACTS about days already ridden, not policy, and `fireInstant()` places a point with both.
 * #197 (`9b6970a`) set the beat to 50 ms and the threshold to 500 ms at this instant, so a
 * hold judged after it would be placed by a machine that no longer exists. The DEPLOY to the
 * Pi is later than the commit, so this errs towards judging too little rather than too much —
 * and the step reports every hold it left outside the window instead of dropping it quietly.
 */
const LEGACY_BEAT_ERA_END_ISO = "2026-09-10T21:55:06Z";

/**
 * Heap for the decrypt, which is the one stage that can run out of it.
 *
 * ⚠️ `decrypt-log.ts` holds ONE FILE'S readings in a single array, and a /dl dump is every day
 * file concatenated — so this scales with the archive, not with what is new. The 2026-09-13
 * dump rebuilds to 39 258 150 readings and dies at 8 GB; 24 GB carried it. It is a ceiling
 * and not a reservation, so a machine with less simply fails where it would have failed
 * anyway. Pass --heap-mb when a future dump outgrows this, and see docs/dc-taper.md.
 */
const DEFAULT_HEAP_MB = 24576;

interface Options {
  inputs: string[];
  outPath: string;
  heapMb: number;
  recoverFromMs: number;
  recoverToMs: number;
  allowShrink: boolean;
  materialiseOnly: string | null;
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (options.materialiseOnly !== null) {
    await materialiseOnly(options.materialiseOnly);
    return;
  }

  const outPath = resolve(options.outPath);
  const previousTrack = (await pathExists(outPath)) ? readTrackAge(outPath) : null;
  console.log(`importing ${options.inputs.length} input(s) → ${outPath}`);
  console.log(
    previousTrack === null
      ? "the database being replaced has no materialised route track"
      : `the database being replaced has a route track built ${previousTrack}`
  );

  const importOptions: ImportOptions = {
    inputs: options.inputs,
    outPath,
    recoverFromMs: options.recoverFromMs,
    recoverToMs: options.recoverToMs,
    allowShrink: options.allowShrink,
    runId: new Date().toISOString().replace(/[:.]/g, "-"),
  };
  const outcome = await runImport(importOptions, spawnedStages(options.heapMb));

  if (!outcome.ok) {
    console.error(`\n✗ REFUSED — ${outcome.refusal}`);
    if (outcome.refusal?.includes("decrypt exited -1") === true) {
      // -1 is a signalled child, and on this stage it is nearly always V8 aborting on a heap
      // it could not grow. The message the child printed scrolls past inside a stack trace.
      console.error(`   A signalled decrypt is usually a V8 heap OOM. Retry with --heap-mb ${options.heapMb * 2}.`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`\n✓ ${outPath} rebuilt`);
  if (outcome.before !== null && outcome.after !== null) {
    console.log(`  readings ${outcome.before.readings} → ${outcome.after.readings}`);
  }
  if (outcome.replacedPath !== null) {
    console.log(`  the database it replaced is at ${outcome.replacedPath} — delete it once Grafana looks right`);
  }
  if (outcome.unreadableSegments) {
    console.log("  ⚠️ some segments could not be decrypted (see the decrypt step above); that data is lost");
  }
}

/** The two stages that are their own process, so each gets its own heap and its own exit code. */
function spawnedStages(heapMb: number): SpawnedStages {
  return {
    decrypt(inputs: string[], outPath: string): Promise<number> {
      // ⚠️ --max-old-space-size is not optional on a real dump: decrypt-log.ts holds a whole
      // file's readings in one array and dies with a V8 OOM at the ~4.3 GB default heap
      // (docs/dc-taper.md). Spawning is what lets this step set it for him.
      return runNode(["--max-old-space-size=" + heapMb], "decrypt-log.ts", [...inputs, "--out", outPath]);
    },
    recover(dbPath: string, fromMs: number, toMs: number | null, commit: boolean): Promise<number> {
      const args = ["--db", dbPath, "--from", new Date(fromMs).toISOString()];
      if (toMs !== null) {
        args.push("--to", new Date(toMs).toISOString());
      }
      if (commit) {
        args.push("--commit");
      }
      return runNode([], "recover-waypoints.ts", args);
    },
  };
}

function runNode(nodeFlags: string[], script: string, args: string[]): Promise<number> {
  const scriptPath = join(dirname(fileURLToPath(import.meta.url)), script);
  const child = spawn(process.execPath, ["--experimental-strip-types", ...nodeFlags, scriptPath, ...args], {
    stdio: "inherit",
  });
  return new Promise((settle, reject) => {
    child.on("error", reject);
    // A signalled child reports null for the code; report it as a failure rather than as a 0.
    child.on("close", code => settle(code ?? -1));
  });
}

/**
 * For "I decrypted by hand, now make the map fast" — the only stage safe to re-run alone.
 *
 * ⚠️ It also leaves the file in rollback journal mode, for the reason the full step does
 * (grafana/README.md §"`rides.db` is in WAL mode, and that silently blanks panels"). That is
 * right for a laptop-side archive Grafana reads and WRONG for a database something is
 * appending to — the same section measures 53 of 85 queries failing in that case — so this is
 * not a command to point at a Pi's live file.
 */
async function materialiseOnly(dbPath: string): Promise<void> {
  const path = resolve(dbPath);
  if (!(await pathExists(path))) {
    // better-sqlite3 would CREATE it, so a mistyped path otherwise leaves an empty database
    // behind and then fails on `no such table: reading`.
    fail(`${path} does not exist — --materialise-only works on a database you already have`);
  }
  const db = new Database(path);
  const built = buildRouteTrack(db);
  const mode = db.pragma("journal_mode = DELETE", { simple: true });
  db.close();
  console.log(`route_track: ${built.rows} points in ${built.ms.toFixed(0)} ms, built ${built.builtAt}`);
  console.log(`journal_mode is now ${String(mode)}`);
}

function parseArguments(argv: string[]): Options {
  const options: Options = {
    inputs: [],
    outPath: "rides.db",
    heapMb: DEFAULT_HEAP_MB,
    recoverFromMs: 0,
    recoverToMs: Date.parse(LEGACY_BEAT_ERA_END_ISO),
    allowShrink: false,
    materialiseOnly: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = argv[index + 1];
    if (argument === "--allow-shrink") {
      options.allowShrink = true;
    } else if (argument.startsWith("--")) {
      if (next === undefined || next.startsWith("--")) {
        fail(`${argument} needs a value`);
      }
      index += 1;
      applyFlag(options, argument, next);
    } else {
      options.inputs.push(argument);
    }
  }
  if (options.materialiseOnly === null && options.inputs.length === 0) {
    fail(
      "usage: import-ride-log.ts <dir-or-file…> [--out rides.db] [--heap-mb N]\n" +
        "                        [--recover-from ISO] [--recover-to ISO] [--allow-shrink]\n" +
        "       import-ride-log.ts --materialise-only <rides.db>"
    );
  }
  return options;
}

function applyFlag(options: Options, flag: string, value: string): void {
  if (flag === "--out") {
    options.outPath = value;
  } else if (flag === "--heap-mb") {
    // Unvalidated, `--heap-mb 24gb` reached the child as --max-old-space-size=NaN, which node
    // refuses outright — and the OOM hint then suggested --heap-mb NaN.
    const megabytes = Number(value);
    if (!Number.isInteger(megabytes) || megabytes < 512) {
      fail(`--heap-mb needs a whole number of megabytes, at least 512, not ${value}`);
    }
    options.heapMb = megabytes;
  } else if (flag === "--recover-from") {
    options.recoverFromMs = parseInstant(flag, value);
  } else if (flag === "--recover-to") {
    options.recoverToMs = parseInstant(flag, value);
  } else if (flag === "--materialise-only") {
    options.materialiseOnly = value;
  } else {
    fail(`unknown option ${flag}`);
  }
}

function parseInstant(flag: string, value: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    fail(`${flag} needs an ISO instant, not ${value}`);
  }
  return ms;
}

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

await main();
