import Database from "better-sqlite3";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { closeDb, flushNow, initDb, recordReading } from "../src/db.ts";
import { SIGNALS } from "../src/can/registry.ts";
import { decodeFrame } from "../src/can/decode.ts";

// The ride-summary dashboard's "Brake" lane, run against a database rather than read.
//
//   node --experimental-strip-types scripts/check-brake-lane.ts
//
// `brake` (front OR rear) was deleted on 2026-08-30 for being computed from two signals
// the log already holds — see docs/can-decode-findings.md §"Why `brake` was removed". The
// lane that selected it by name now has to do the OR itself, and that is the part of the
// removal that can go quietly wrong: BOTH halves are log-on-change, so a row exists only
// where one of them moved, and the OR has to be taken over each series' carried-forward
// last value rather than over the rows. The obvious spelling — a running MAX() over ROWS
// UNBOUNDED PRECEDING — latches to `yes` on the first application and never comes back
// down, which on a state timeline looks like a plausible lane and is not one.
//
// So this runs the SHIPPED query, pulled out of the dashboard JSON rather than restated
// here, against a database built by the real src/db.ts writer, over a series with the
// cases that separate a correct carry-forward from a wrong one.

const DASHBOARD = new URL("../grafana/dashboards/ride-summary.json", import.meta.url);

/** Grafana's own macro substitution: the panel's time window, as epoch ms. */
const WINDOW_FROM = 500;
const WINDOW_TO = 50_000;

interface LanePoint {
  time: number;
  state: string;
}

/**
 * The series the fixture writes, and what the lane must show for it.
 *
 * Written out rather than computed from the halves: a check that carried the values
 * forward with its own copy of the rule would agree with any rule at all, including the
 * latching one. Every timestamp below is inside the window except where it says otherwise.
 */
const LEGACY_BRAKE_ROWS: [number, number][] = [
  [100, 1], // BEFORE the window — must not reach the lane
  [1000, 1],
  [2000, 0],
  [3000, 1],
  [4000, 0],
  // Two rows from the overlap: front_brake / rear_brake started logging on 2026-08-19 and
  // `brake` kept logging until 2026-08-30, so eleven days of rides.db carry both. The
  // legacy arm has to stop at the first half-row or these are read twice — and this pair
  // says "no" while both halves are down, so a double read is visibly wrong, not merely
  // redundant.
  [6500, 0],
  [6600, 0],
];

const HALF_ROWS: [number, "front_brake" | "rear_brake", number][] = [
  [5000, "front_brake", 1], // the split: everything from here is computed
  [6000, "rear_brake", 1], // both down
  [7000, "front_brake", 0], // front released, rear still down — the case that needs the carry-forward
  [8000, "rear_brake", 0],
  [9000, "rear_brake", 1], // rear alone
  [10_000, "rear_brake", 0],
  [11_000, "front_brake", 1], // both halves change in the SAME millisecond
  [11_000, "rear_brake", 1],
  [12_000, "front_brake", 0],
  [12_000, "rear_brake", 0],
  [99_000, "front_brake", 1], // AFTER the window — must not reach the lane
];

/** What the lane must read, once repeated values are merged as the panel merges them. */
const EXPECTED_LANE: LanePoint[] = [
  { time: 1, state: "yes" },
  { time: 2, state: "no" },
  { time: 3, state: "yes" },
  { time: 4, state: "no" },
  { time: 5, state: "yes" },
  { time: 8, state: "no" },
  { time: 9, state: "yes" },
  { time: 10, state: "no" },
  { time: 11, state: "yes" },
  { time: 12, state: "no" },
];

const failures: string[] = [];
const dashboard = JSON.parse(await readFile(DASHBOARD, "utf8"));
const query = brakeQuery(dashboard);

// 1. The keys the query names must be keys that exist — with `brake` the one deliberate
//    exception, since the whole point of its arm is to read a signal nothing writes any
//    more. A rename that missed this file would empty the lane in silence.
const registered = new Set(SIGNALS.map(signal => signal.key));
// Only the signal keys, not every quoted literal: the lane's own 'yes' and 'no' are in
// there too, and a check that treated those as signal names would be unfirable noise.
const namedKeys = [...query.matchAll(/\bkey\s*=\s*'([a-z_]+)'/g)].map(match => match[1]);
for (const clause of query.matchAll(/\bkey\s+IN\s*\(([^)]*)\)/gi)) {
  for (const literal of clause[1].matchAll(/'([a-z_]+)'/g)) {
    namedKeys.push(literal[1]);
  }
}
for (const key of new Set(namedKeys)) {
  if (key === "brake") continue;
  if (!registered.has(key)) {
    failures.push(
      `the Brake lane selects '${key}', which is not a signal in src/can/registry.ts — the lane would be empty and ` +
        `nothing else in the repo would notice`
    );
  }
}
for (const half of ["front_brake", "rear_brake"]) {
  if (!namedKeys.includes(half)) {
    failures.push(`the Brake lane does not select '${half}', so it cannot be the OR of the two circuits`);
  }
}
if (!namedKeys.includes("brake")) {
  failures.push(
    "the Brake lane no longer reads the retired 'brake' key, so every row logged between June and 2026-08-30 has " +
      "dropped off the panel — those rows are still correct readings of the same two bits"
  );
}

// 2. …and `brake` really is retired, in both places. A registry entry would put the rows
//    back and make the legacy arm double-count; a decoder that still emits it would keep
//    writing a value computed from two signals already on disk.
if (registered.has("brake")) {
  failures.push(
    "`brake` is back in src/can/registry.ts — it is front_brake | rear_brake, and this log stores measured bits " +
      'rather than combinations of them (docs/can-decode-findings.md §"Why `brake` was removed")'
  );
}
const brakeFrame = decodeFrame(0x102, Buffer.from([0x00, 0x00, 0x60, 0x44]));
if (brakeFrame.some(value => value.key === "brake")) {
  failures.push("src/can/decode.ts emits `brake` again — it is computed from the two bits beside it");
}

// 3. The lane itself, against a database the real writer built.
const directory = await mkdtemp(join(tmpdir(), "brake-lane-"));
const databasePath = join(directory, "rides.db");
let lane: LanePoint[] = [];
let sqliteVersion = "unknown";
try {
  initDb(databasePath);
  for (const [ts, value] of LEGACY_BRAKE_ROWS) {
    recordReading(ts, "brake", value, "", "controls", "stream");
  }
  for (const [ts, key, value] of HALF_ROWS) {
    recordReading(ts, key, value, "", "buttons", "stream");
  }
  flushNow();
  closeDb();

  const database = new Database(databasePath, { readonly: true });
  sqliteVersion = String((database.prepare("SELECT sqlite_version() AS version").get() as { version: string }).version);
  const rows = database
    .prepare(query.replaceAll("$__from", String(WINDOW_FROM)).replaceAll("$__to", String(WINDOW_TO)))
    .all() as { time: number; Brake: string }[];
  database.close();
  lane = mergeValues(rows.map(row => ({ time: row.time, state: row.Brake })));

  for (let index = 0; index < Math.max(lane.length, EXPECTED_LANE.length); index++) {
    const want = EXPECTED_LANE[index];
    const got = lane[index];
    if (!want || !got || want.time !== got.time || want.state !== got.state) {
      failures.push(
        `segment ${index} of the Brake lane is ${describe(got)}, expected ${describe(want)} — ` +
          `the whole lane came out as ${lane.map(describe).join(" ")}`
      );
      break;
    }
  }
  // The latching failure, named rather than left as "segment 5 is missing". Scoped to the
  // computed half on purpose: the retired rows before the split supply `no` segments of
  // their own, so a guard over the whole lane would go quiet exactly where the OR is.
  const splitSecond = HALF_ROWS[0][0] / 1000;
  const computed = lane.filter(point => point.time >= splitSecond);
  if (computed.length > 0 && !computed.some(point => point.state === "no")) {
    failures.push(
      "the Brake lane never reads `no` again after the split — a running MAX() over the window latches like this, " +
        "and every release carried forward from a half is lost"
    );
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}

console.log(`SQLite ${sqliteVersion}; the lane the shipped query produced, merged:`);
console.log(`  ${lane.map(describe).join(" ")}`);
console.log(
  `${LEGACY_BRAKE_ROWS.length} retired \`brake\` rows and ${HALF_ROWS.length} half rows in, ` +
    `${EXPECTED_LANE.length} segments expected out`
);

if (failures.length > 0) {
  console.error("FAILED:");
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  process.exit(1);
}
console.log(
  "✓ the Brake lane reproduces the retired key: the pre-split rows read, the overlap read once, a release under a " +
    "still-held second circuit stays yes, both circuits moving in one millisecond give one segment, and the window " +
    "bounds hold at both ends"
);

/** The panel target that draws the Brake lane, found by what it is rather than by index. */
function brakeQuery(dashboardJson: unknown): string {
  const queries: string[] = [];
  collectQueries(dashboardJson, queries);
  const matches = queries.filter(text => /AS "Brake"/.test(text));
  if (matches.length !== 1) {
    console.error(
      `FAILED:\n  ✗ expected exactly one query aliased AS "Brake" in grafana/dashboards/ride-summary.json, found ${matches.length}`
    );
    process.exit(1);
  }
  return matches[0];
}

function collectQueries(node: unknown, into: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      collectQueries(item, into);
    }
    return;
  }
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "rawQueryText" && typeof value === "string") {
        into.push(value);
      } else {
        collectQueries(value, into);
      }
    }
  }
}

/**
 * What the panel does with repeated values: `"mergeValues": true` collapses a run of
 * equal states into one segment, so the check compares what a reader sees rather than
 * how many rows the query happened to emit.
 */
function mergeValues(points: LanePoint[]): LanePoint[] {
  const merged: LanePoint[] = [];
  for (const point of points) {
    if (merged.length === 0 || merged[merged.length - 1].state !== point.state) {
      merged.push(point);
    }
  }
  return merged;
}

function describe(point: LanePoint | undefined): string {
  return point === undefined ? "(nothing)" : `${point.time}s=${point.state}`;
}
