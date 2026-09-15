import Database from "better-sqlite3";
import { spawn } from "child_process";
import { access } from "fs/promises";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { buildRouteTrack } from "./route-track.ts";
import { readTrackAge, runImport, type ImportOptions, type SpawnedStages } from "./ride-import.ts";

// One command for "the bike has new rides in it": decrypt the sealed log, put back the
// waypoints a rebuild would otherwise drop, and materialise the map's track.
//
//   node --experimental-strip-types scripts/import-ride-log.ts ~/…/ride-logs --out rides.db
//   node --experimental-strip-types scripts/import-ride-log.ts --materialise-only rides.db
//
// ⚠️ Takes about twenty minutes on a full /dl dump, most of it the decrypt. README.md
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

/** Enough heap for a /dl dump: decrypt-log.ts holds one file's readings in a single array. */
const DEFAULT_HEAP_MB = 8192;

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
    materialiseOnly(options.materialiseOnly);
    return;
  }

  const outPath = resolve(options.outPath);
  const previousTrack = (await exists(outPath)) ? readTrackAge(outPath) : null;
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

/** For "I decrypted by hand, now make the map fast" — the only stage that is safe to re-run alone. */
function materialiseOnly(dbPath: string): void {
  const db = new Database(resolve(dbPath));
  const built = buildRouteTrack(db);
  db.pragma("journal_mode = DELETE");
  db.close();
  console.log(`route_track: ${built.rows} points in ${built.ms.toFixed(0)} ms, built ${built.builtAt}`);
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
    options.heapMb = Number(value);
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

async function exists(path: string): Promise<boolean> {
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

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

await main();
