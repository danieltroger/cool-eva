import Database from "better-sqlite3";
import { writeFile } from "fs/promises";
import { resolve } from "path";
import {
  RECOVERY_OUTCOME,
  distanceKm,
  fireInstant,
  judgeHolds,
  pairPresses,
  type Fix,
  type LogRow,
  type RecoveredPress,
  type RecoveryVerdict,
} from "../src/gps/recover-holds.ts";
import { WAYPOINT_HOLD_MS } from "../src/gps/waypoint.ts";
import { commitRecovered } from "./recover-waypoints-commit.ts";

// Recovering the waypoints a handlebar hold asked for and never got, from a decoded ride
// log on the LAPTOP. Never runs on the Pi, never opens a socket, never transmits.
//
//   node --experimental-strip-types scripts/recover-waypoints.ts --db rides.db \
//     --from 2026-09-07T00:00:00Z --to 2026-09-08T22:14:00Z [--commit] [--gpx out.gpx]
//   node --experimental-strip-types scripts/recover-waypoints.ts --db x.db --validate
//
// ⚠️ --dry-run IS THE DEFAULT and the handle is READ-ONLY until --commit. Opening this DB
// through src/db.ts's initDb() would flip journal_mode to WAL, which is a write, so a dry
// run that used it would not be dry. The rules are in src/gps/recover-holds.ts and are
// pure; this file is the shell. docs/waypoints.md §"Recovering the holds the phone dropped".

/** How far past the release a live waypoint may land and still belong to that press. */
const LIVE_MATCH_TOLERANCE_MS = 200;

/**
 * The beat in force on the days being recovered.
 *
 * ⚠️ NOT imported from src/gestures/runner.ts. That constant is 50 ms today because #197
 * halved it; it was 100 ms while these rides happened, and importing it would silently
 * re-place every recovered point the next time it moves.
 */
const BEAT_MS_ON_THE_RECOVERY_DAYS = 100;

/**
 * The waypoint threshold in force on the days being recovered, before #197 trimmed it.
 *
 * ⚠️ Also NOT imported. WAYPOINT_HOLD_MS is 500 today; these holds were made under 1000, and
 * which of the two a hold cleared is what decides where its point goes (fireInstant()).
 */
const LEGACY_HOLD_MS = 1000;

interface Options {
  dbPath: string;
  fromMs: number;
  toMs: number;
  holdMs: number;
  commit: boolean;
  gpxPath: string | null;
  validate: boolean;
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const db = new Database(options.dbPath, { readonly: true });
  const inputs = {
    cancelRows: readSignal(db, "btn_indicator_cancel", options),
    latitudeRows: readSignal(db, "gps_lat", options),
    longitudeRows: readSignal(db, "gps_lon", options),
    epochRows: readSignal(db, "gps_epoch_s", options),
    waypointRows: readSignal(db, "waypoint_seq", options),
    holdMs: options.holdMs,
    beatMs: BEAT_MS_ON_THE_RECOVERY_DAYS,
    legacyHoldMs: LEGACY_HOLD_MS,
    liveToleranceMs: LIVE_MATCH_TOLERANCE_MS,
  };

  if (options.validate) {
    validateAgainstLiveWaypoints(db, inputs, options);
    db.close();
    return;
  }

  const verdicts = judgeHolds(inputs);
  report(verdicts, options);
  const recovered = verdicts.filter(verdict => verdict.outcome === RECOVERY_OUTCOME.RECOVERED);
  db.close();

  if (options.gpxPath !== null && recovered.length > 0) {
    await writeFile(options.gpxPath, buildGpx(recovered), "utf-8");
    console.log(`\nGPX: ${recovered.length} waypoint(s) → ${options.gpxPath}`);
  }
  if (!options.commit) {
    console.log("\n⚠️  DRY RUN — nothing was written. Pass --commit to insert, after reading the report above.");
    return;
  }
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const result = await commitRecovered(options.dbPath, recovered, runId);
  console.log(
    `\ninserted ${result.insertedRows} rows under session ${result.sessionUid}; ` +
      `undo with: DELETE FROM reading WHERE session_id = (SELECT id FROM session WHERE uid = '${result.sessionUid}')`
  );
}

/**
 * Everything the report says, and it says what the gates DID rather than what they cover.
 *
 * ⚠️ `jump gate: not judged` is not a pass. implausibleJumpKmh() returns null below
 * MIN_FIX_INTERVAL_MS, and this hub's fixes are mostly closer together than that, so the
 * gate usually declines to look. The bike had the same gate in the same regime — this is
 * faithful, not broken — but printing "cleared" would claim a test that never ran.
 */
function report(verdicts: RecoveryVerdict[], options: Options): void {
  const recovered = verdicts.filter(verdict => verdict.outcome === RECOVERY_OUTCOME.RECOVERED);
  const live = verdicts.filter(verdict => verdict.outcome === RECOVERY_OUTCOME.ALREADY_LIVE);
  const refused = verdicts.filter(verdict => verdict.outcome === RECOVERY_OUTCOME.REFUSED);
  console.log(`window ${new Date(options.fromMs).toISOString()} → ${new Date(options.toMs).toISOString()}`);
  console.log(`hold threshold ${options.holdMs} ms (the beat was ${BEAT_MS_ON_THE_RECOVERY_DAYS} ms on these days)`);
  console.log(`\nholds ≥ ${options.holdMs} ms: ${verdicts.length}`);
  console.log(`  already live : ${live.length}`);
  console.log(`  refused      : ${refused.length}`);
  console.log(`  RECOVERABLE  : ${recovered.length}`);
  if (refused.length > 0) {
    console.log("\nrefused, by gate:");
    for (const verdict of refused) {
      console.log(`  ${new Date(verdict.fireAt).toISOString()}  refusal code ${verdict.refusal}`);
    }
  }
  if (recovered.length > 0) {
    console.log("\nrecoverable:");
    for (const verdict of recovered) {
      const judged = verdict.jumpGateJudged ? "judged" : "NOT judged (fixes closer than the gate's floor)";
      console.log(
        `  ${new Date(verdict.fireAt).toISOString()}  held ${verdict.press.durationMs} ms  ` +
          `position ${verdict.positionAgeMs} ms old  jump gate: ${judged}`
      );
    }
  }
}

/**
 * Replays the rules against waypoints the bike DID save — the only ground truth there is,
 * since each was written from the live fix.
 *
 * ⚠️ TWO DIFFERENT ERRORS, and an earlier version reported only the flattering one.
 * CARRY-BACK fidelity asks "at the instant the bike wrote this, does the last logged row
 * reproduce what it wrote?" — bounded by one deadband and measured at 22 of 28 exact.
 * PLACEMENT asks "does the instant this script would have chosen land in the same place?"
 * — and that one is an order of magnitude larger, because a gesture fires on a beat and
 * the bike's threshold was twice this recovery's. Only the second is the error a recovered
 * point actually carries, so both are printed and the larger one is named as the real bound.
 */
function validateAgainstLiveWaypoints(
  db: Database.Database,
  inputs: Parameters<typeof judgeHolds>[0],
  options: Options
): void {
  const savedLatitudes = readSignal(db, "waypoint_lat", options);
  const savedLongitudes = readSignal(db, "waypoint_lon", options);
  const presses = pairPresses(inputs.cancelRows);
  console.log(`calibrating against ${inputs.waypointRows.length} waypoints the bike saved\n`);
  const carryBackErrors: number[] = [];
  const placementErrors: number[] = [];
  for (const waypoint of inputs.waypointRows) {
    const saved = positionAt(savedLatitudes, savedLongitudes, waypoint.ts);
    const carried = positionAt(inputs.latitudeRows, inputs.longitudeRows, waypoint.ts);
    if (saved === null || carried === null) {
      continue;
    }
    carryBackErrors.push(metresBetween(saved, carried));
    const press = firingPress(presses, waypoint.ts, inputs.liveToleranceMs);
    if (press === null) {
      continue;
    }
    const placed = positionAt(inputs.latitudeRows, inputs.longitudeRows, fireInstant(press, inputs));
    if (placed !== null) {
      placementErrors.push(metresBetween(saved, placed));
    }
  }
  describe("carry-back fidelity, at the instant the bike wrote the waypoint", carryBackErrors);
  describe("placement, at the fire instant this recovery chooses", placementErrors);
  console.log("\nThe second is the error a recovered point carries. The first only says carry-back is exact.");
}

function describe(what: string, metres: number[]): void {
  if (metres.length === 0) {
    console.log(`${what}: nothing to measure`);
    return;
  }
  const sorted = [...metres].sort((left, right) => left - right);
  const exact = sorted.filter(value => value < 0.05).length;
  console.log(
    `${what}:\n  n=${sorted.length}  exact ${exact}  median ${sorted[sorted.length >> 1].toFixed(1)} m  ` +
      `worst ${sorted[sorted.length - 1].toFixed(1)} m`
  );
}

/** The press a waypoint fired from: it began before the waypoint and was still down. */
function firingPress(presses: RecoveredPress[], at: number, toleranceMs: number): RecoveredPress | null {
  let best: RecoveredPress | null = null;
  let bestDelay = Number.POSITIVE_INFINITY;
  for (const press of presses) {
    const delay = at - press.startedAt;
    if (delay > 0 && delay <= press.durationMs + toleranceMs && delay < bestDelay) {
      bestDelay = delay;
      best = press;
    }
  }
  return best;
}

function positionAt(latitudes: LogRow[], longitudes: LogRow[], at: number): Fix | null {
  const latitude = lastAtOrBefore(latitudes, at);
  const longitude = lastAtOrBefore(longitudes, at);
  return latitude === null || longitude === null
    ? null
    : { latitudeDeg: latitude.value, longitudeDeg: longitude.value, at };
}

function metresBetween(from: Fix, to: Fix): number {
  return distanceKm(from, to) * 1000;
}

function lastAtOrBefore(rows: LogRow[], at: number): LogRow | null {
  let found: LogRow | null = null;
  for (const row of rows) {
    if (row.ts > at) {
      break;
    }
    found = row;
  }
  return found;
}

function readSignal(db: Database.Database, key: string, options: Options): LogRow[] {
  const statement = db.prepare(
    "SELECT r.ts AS ts, r.value AS value, r.session_id AS sessionId, r.seq AS seq " +
      "FROM reading r JOIN signal s ON s.id = r.signal_id " +
      "WHERE s.key = ? AND r.ts >= ? AND r.ts < ? ORDER BY r.ts"
  );
  return statement.all(key, options.fromMs, options.toMs) as LogRow[];
}

/** No coordinates are printed anywhere but here and the DB — docs/route-map.md's rule. */
function buildGpx(verdicts: RecoveryVerdict[]): string {
  const points = verdicts
    .map(verdict => {
      const when = new Date(verdict.fireAt).toISOString();
      return (
        `  <wpt lat="${verdict.latitudeDeg}" lon="${verdict.longitudeDeg}">\n` +
        `    <time>${when}</time>\n` +
        `    <name>recovered ${when}</name>\n` +
        `    <desc>held ${verdict.press.durationMs} ms; position row ${verdict.positionAgeMs} ms old</desc>\n` +
        `  </wpt>`
      );
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="cool-eva recover-waypoints">\n${points}\n</gpx>\n`;
}

function parseArguments(argv: string[]): Options {
  const read = (flag: string): string | null => {
    const at = argv.indexOf(flag);
    return at >= 0 && at + 1 < argv.length ? argv[at + 1] : null;
  };
  const dbPath = read("--db");
  if (dbPath === null) {
    console.error("usage: recover-waypoints.ts --db <rides.db> [--from ISO] [--to ISO] [--commit] [--gpx path]");
    process.exit(2);
  }
  const from = read("--from");
  const to = read("--to");
  const hold = read("--hold-ms");
  return {
    dbPath: resolve(dbPath),
    fromMs: from === null ? 0 : Date.parse(from),
    toMs: to === null ? Number.MAX_SAFE_INTEGER : Date.parse(to),
    holdMs: hold === null ? WAYPOINT_HOLD_MS : Number(hold),
    commit: argv.includes("--commit"),
    gpxPath: read("--gpx"),
    validate: argv.includes("--validate"),
  };
}

await main();
