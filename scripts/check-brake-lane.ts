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
// last value rather than over the rows. Two spellings are wrong in opposite directions.
// A running MAX() over ROWS UNBOUNDED PRECEDING latches to `yes` on the first application
// and never comes back down. A carry-forward that starts at $__from reads a lever held
// from before the window as released, and draws `no` over a squeeze — which is worse than
// the omission it replaces, because the retired query could only leave points out.
//
// So this runs the SHIPPED query, pulled out of the dashboard JSON rather than restated
// here, against a database built by the real src/db.ts writer, over three windows: the
// whole series, one that OPENS IN THE MIDDLE of an application, and one over a log in
// which only one of the two circuits was ever written.

const DASHBOARD = new URL("../grafana/dashboards/ride-summary.json", import.meta.url);

interface LanePoint {
  time: number;
  state: string;
}

/** A panel time range, as Grafana substitutes it, and the lane it must produce. */
interface LaneWindow {
  name: string;
  from: number;
  to: number;
  expected: LanePoint[];
}

/**
 * The series the fixture writes, and what the lane must show for it.
 *
 * Written out rather than computed from the halves: a check that carried the values
 * forward with its own copy of the rule would agree with any rule at all, including the
 * latching one. Every timestamp below is inside the first window except where it says so.
 */
const LEGACY_BRAKE_ROWS: [number, number][] = [
  [100, 1], // BEFORE the window — must not reach the lane
  [1000, 1],
  [2000, 0],
  [3000, 1],
  [4000, 0],
  // Shares its timestamp with the first half row, which is not a contrivance: on
  // 2026-08-19 `brake` and the two halves came out of the same decodeFrame call on the
  // same frame, so they share a `ts` exactly. The cutover bound is `<`, and `<=` would
  // read this row on top of the half that replaced it.
  [4500, 1],
  // Two rows from the overlap: front_brake / rear_brake started logging on 2026-08-19 and
  // `brake` kept logging until 2026-08-30, so eleven days of rides.db carry both. The
  // legacy arm has to stop at the first half-row or these are read twice — and this pair
  // says "no" while both halves are down, so a double read is visibly wrong.
  [6500, 0],
  [6600, 0],
];

const HALF_ROWS: [number, "front_brake" | "rear_brake", number][] = [
  // The split. `rear_brake` moves first and reads 0 while `front_brake` has never been
  // written at all, so this row is the one that pins what a never-seen half means.
  [4500, "rear_brake", 0],
  [5000, "front_brake", 1],
  [6000, "rear_brake", 1], // both down
  [7000, "front_brake", 0], // front released, rear still down — the case that needs the carry-forward
  [8000, "rear_brake", 0],
  [9000, "rear_brake", 1], // rear alone
  [10_000, "rear_brake", 0],
  [11_000, "front_brake", 1], // both halves change in the SAME millisecond
  [11_000, "rear_brake", 1],
  [12_000, "rear_brake", 0],
  // The two circuits swapping in one millisecond, once in each direction. The brake is
  // held throughout both, so neither adds a segment — they are here because a pivot that
  // did not aggregate per timestamp would apply the halves one at a time and invent a
  // momentary release between them, and which of the two it invents depends on the order
  // SQLite happens to return the rows in. Both directions are present so either order
  // produces a lane that is visibly not this one.
  [13_000, "front_brake", 0],
  [13_000, "rear_brake", 1],
  [14_000, "front_brake", 1],
  [14_000, "rear_brake", 0],
  [15_000, "front_brake", 0],
  [99_000, "front_brake", 1], // AFTER the window — must not reach the lane
];

/**
 * The windows, and what the lane must read in each once repeated values are merged as the
 * panel merges them.
 *
 * ⚠️ The second one is the whole reason there is more than one. A single window spanning
 * the data cannot exercise its own left edge: both halves always have a row inside it, so
 * a lane that guesses at the state it opens on looks perfect. This one opens between the
 * rear circuit engaging at 6.0 s and the front releasing at 7.0 s, with both levers down
 * and their rows outside the window, which is the shape that drew `no` over a held brake.
 */
const WINDOWS: LaneWindow[] = [
  {
    name: "the whole series",
    from: 500,
    to: 50_000,
    expected: points(
      [1, "yes"],
      [2, "no"],
      [3, "yes"],
      [4, "no"],
      [5, "yes"],
      [8, "no"],
      [9, "yes"],
      [10, "no"],
      [11, "yes"],
      [15, "no"]
    ),
  },
  {
    name: "opening mid-application",
    from: 6500,
    to: 50_000,
    expected: points([6.5, "yes"], [8, "no"], [9, "yes"], [10, "no"], [11, "yes"], [15, "no"]),
  },
];

/**
 * …and the lane over a log in which only `front_brake` was ever written.
 *
 * `decode.ts` cannot produce that — both bits come out of the same frame, so the two
 * halves are logged together or not at all — which is exactly why the OR's treatment of a
 * never-seen half has to be pinned here instead of being trusted to the data. If a
 * missing half ever defaulted to 1 it would read as a permanently held brake, and the
 * only warning would be a lane that never says `no`.
 */
const FRONT_ONLY_WINDOW: LaneWindow = {
  name: "only one circuit ever written",
  from: 500,
  to: 50_000,
  expected: points([5, "yes"], [7, "no"], [11, "yes"], [13, "no"], [14, "yes"], [15, "no"]),
};

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

// 2. The rows must come out globally sorted by time. This is a property of the query TEXT
//    and not of the rows, because the two arms cannot interleave: the legacy arm is
//    bounded below the cutover and the half arm never starts before it, so SQLite returns
//    them in order whether the clause is there or not and no fixture can tell. Grafana
//    can — `frser-sqlite-datasource` rejects the WHOLE query with "not sorted in ascending
//    order by time" (grafana/README.md §"The datasource"), so the panel goes blank rather
//    than out of order.
if (!/\bORDER BY\s+(?:1|time)\s*$/i.test(query.trim())) {
  failures.push(
    "the Brake lane's query does not end in an ORDER BY over its time column — frser-sqlite-datasource fails the " +
      "whole query with `not sorted in ascending order by time`, so the panel shows an error rather than a lane"
  );
}

// 3. …and `brake` really is retired, in both places. A registry entry would put the rows
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

// 4. The lane itself, against a database the real writer built.
const directory = await mkdtemp(join(tmpdir(), "brake-lane-"));
const databasePath = join(directory, "rides.db");
const lanes = new Map<string, LanePoint[]>();
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
  for (const panelWindow of WINDOWS) {
    const lane = runLane(database, query, panelWindow);
    lanes.set(panelWindow.name, lane);
    compareLane(panelWindow, lane, failures);
    // The latching failure, named rather than left as "a segment is missing". Scoped to
    // the segments the OR computes: the retired rows before the split supply `no` of
    // their own, and so does the pivot row at the split itself, so a guard over the whole
    // lane would go quiet exactly where the OR is.
    const computed = lane.filter(point => point.time >= Math.max(HALF_ROWS[0][0], panelWindow.from) / 1000);
    const firstApplication = computed.findIndex(point => point.state === "yes");
    if (firstApplication >= 0 && !computed.slice(firstApplication + 1).some(point => point.state === "no")) {
      failures.push(
        `over ${panelWindow.name} the Brake lane never reads \`no\` again after its first application — a running MAX() ` +
          `over the window latches like this, and every release carried forward from a half is lost`
      );
    }
  }
  database.close();

  // The last window needs a log the fixture above cannot be: one where a half was never
  // written at all. Taking the rear circuit's rows back out of the finished database is
  // how that is built, so the schema, the signal table and the index still come from
  // src/db.ts rather than from a hand-written CREATE TABLE.
  const editable = new Database(databasePath);
  editable.prepare("DELETE FROM reading WHERE signal_id <> (SELECT id FROM signal WHERE key = 'front_brake')").run();
  editable.close();

  const frontOnly = new Database(databasePath, { readonly: true });
  const frontOnlyLane = runLane(frontOnly, query, FRONT_ONLY_WINDOW);
  lanes.set(FRONT_ONLY_WINDOW.name, frontOnlyLane);
  compareLane(FRONT_ONLY_WINDOW, frontOnlyLane, failures);
  frontOnly.close();
} finally {
  await rm(directory, { recursive: true, force: true });
}

console.log(`SQLite ${sqliteVersion}; the lanes the shipped query produced, merged:`);
for (const [name, lane] of lanes) {
  console.log(`  ${name}: ${lane.map(describe).join(" ")}`);
}
console.log(
  `${LEGACY_BRAKE_ROWS.length} retired \`brake\` rows and ${HALF_ROWS.length} half rows in, ` +
    `${WINDOWS.length + 1} windows out`
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
    "still-held second circuit stays yes, both circuits moving in one millisecond give one segment, a window that " +
    "opens mid-application opens at yes, and a half nobody ever logged does not read as a held brake"
);

/** Runs the lane over one window and merges it the way the panel does. */
function runLane(database: Database.Database, sql: string, panelWindow: LaneWindow): LanePoint[] {
  const rows = database
    .prepare(sql.replaceAll("$__from", String(panelWindow.from)).replaceAll("$__to", String(panelWindow.to)))
    .all() as { time: number; Brake: string }[];
  return mergeValues(rows.map(row => ({ time: row.time, state: row.Brake })));
}

function compareLane(panelWindow: LaneWindow, lane: LanePoint[], into: string[]): void {
  for (let index = 0; index < Math.max(lane.length, panelWindow.expected.length); index++) {
    const want = panelWindow.expected[index];
    const got = lane[index];
    if (!want || !got || want.time !== got.time || want.state !== got.state) {
      into.push(
        `over ${panelWindow.name} ($__from ${panelWindow.from}, $__to ${panelWindow.to}) segment ${index} of the Brake lane is ` +
          `${describe(got)}, expected ${describe(want)} — the whole lane came out as ${lane.map(describe).join(" ")}`
      );
      return;
    }
  }
}

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
function mergeValues(lane: LanePoint[]): LanePoint[] {
  const merged: LanePoint[] = [];
  for (const point of lane) {
    if (merged.length === 0 || merged[merged.length - 1].state !== point.state) {
      merged.push(point);
    }
  }
  return merged;
}

function points(...pairs: [number, string][]): LanePoint[] {
  return pairs.map(([time, state]) => ({ time, state }));
}

function describe(point: LanePoint | undefined): string {
  return point === undefined ? "(nothing)" : `${point.time}s=${point.state}`;
}
