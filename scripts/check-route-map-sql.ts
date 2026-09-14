import Database from "better-sqlite3";
import { readFile } from "fs/promises";

// The route map's charge-stop position, run as SQL against a database built for it.
//
//   node --experimental-strip-types scripts/check-route-map-sql.ts
//
// ⚠️ THE FIRST CHECK IN THIS REPO THAT EXECUTES THE DASHBOARD'S OWN QUERIES, and that is
// the point: the SQL is read out of grafana/dashboards/route-map.json rather than restated
// here, so a check that passes is a check about what Grafana will actually run. Nothing
// else covers that file — #173 was found by reading it, not by a failure.
//
// What it is about: a charge stop inherits its position from the last GPS fix before
// plug-in, because the hub sleeps while charging. That newest row is the one row a
// despiker can never see — a lone excursion is only visible from its neighbours, and the
// lookup's own `r.ts <= sess.start_ts` forbids looking at the one after it. So a corrupt
// final fix sat there as the newest row for the whole session, and the map's `fit` framed
// the planet on it. docs/route-map.md §"A charge stop is not a measured position".

const DASHBOARD = "grafana/dashboards/route-map.json";

/** Not a place. Round synthetic degrees, for the reason docs/route-map.md gives. */
const LATITUDE = 10;
const LONGITUDE = 20;

/** The hub's own cadence, measured over the archive: a fix about every 550 ms. */
const SAMPLE_MS = 550;

/**
 * The longest a corrupt fix was ever seen to survive in the archive, to the millisecond.
 *
 * ⚠️ The window's LOWER bound is pinned against this and not against SAMPLE_MS. Every
 * excursion fixture used to correct itself at the median cadence, so a window narrowed to
 * 600 ms passed them all while missing the worst case the archive actually holds — the
 * constant was only ever tested against the hub's typical beat. docs/waypoints.md
 * §"The first fix of a run" derives it: 65 excursions, min 4 ms, median 550, max 661.
 */
const WORST_MEASURED_LIFETIME_MS = 661;

/** Epoch ms for the fixtures. Arbitrary, and far from the 2060 rows the queries guard against. */
const BASE = 1_700_000_000_000;

let failures = 0;

function check(what: string, condition: boolean): void {
  if (condition) {
    console.log(`  ✓ ${what}`);
  } else {
    console.error(`  ✗ ${what}`);
    failures += 1;
  }
}

interface Target {
  refId: string;
  rawQueryText: string;
  queryText: string;
}

interface Panel {
  id?: number;
  targets?: Target[];
  panels?: Panel[];
}

/** One logged sample: a signal key, a time, a value, and the run that wrote it. */
interface Row {
  key: string;
  ts: number;
  value: number;
  sessionId: number | null;
}

const dashboard = JSON.parse(await readFile(DASHBOARD, "utf-8")) as { panels: Panel[] };
const targets = new Map<string, Target>();
collectTargets(dashboard.panels);

function collectTargets(panels: Panel[]): void {
  for (const panel of panels) {
    for (const target of panel.targets ?? []) {
      targets.set(target.refId, target);
    }
    if (panel.panels) {
      collectTargets(panel.panels);
    }
  }
}

function sqlFor(refId: string, fromMs: number, toMs: number): string {
  const target = targets.get(refId);
  if (!target) {
    throw new Error(`${DASHBOARD} has no target ${refId} — the dashboard changed shape`);
  }
  return target.rawQueryText.replaceAll("$__from", String(fromMs)).replaceAll("$__to", String(toMs));
}

/**
 * The same query with the corroboration clause cut out — i.e. what shipped before #173.
 *
 * ⚠️ THIS IS WHAT STOPS THE FIXTURES BEING ASSERTIONS THAT CANNOT FAIL. A fixture that the
 * old query would also have got right proves nothing about the clause; every excursion case
 * below asserts that the ungated query returns the corrupt row and the gated one does not.
 */
function withoutTheClause(sql: string): string {
  // ⚠️ The threshold is matched as a NUMBER, not as the literal 0.002. Pinning the digits
  // here made a mutation of the constant kill this check by failing to strip rather than by
  // drawing the wrong pin — a mutant reported dead for a reason that had nothing to do with
  // the rule under test, which is the same trap as an assertion that cannot fail.
  const stripped = sql.replace(/\s*AND NOT EXISTS \(\s*\n\s*SELECT 1 FROM reading r2[\s\S]*?> [0-9.]+\)/g, "");
  if (stripped === sql) {
    throw new Error("the corroboration clause is not in the dashboard SQL — this check has nothing to test");
  }
  return stripped;
}

/** A database with src/db.ts's schema and nothing else. */
function databaseWith(rows: Row[]): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE signal (id INTEGER PRIMARY KEY, key TEXT UNIQUE, unit TEXT, grp TEXT, source TEXT);
    CREATE TABLE session (id INTEGER PRIMARY KEY, uid TEXT UNIQUE);
    CREATE TABLE reading (ts INTEGER NOT NULL, signal_id INTEGER NOT NULL REFERENCES signal(id),
                          value REAL NOT NULL, session_id INTEGER REFERENCES session(id), seq INTEGER);
    CREATE INDEX idx_reading_sig_ts ON reading(signal_id, ts);
  `);
  // The runs the rows belong to. src/db.ts interns these the same way; without them the
  // reading.session_id foreign key has nothing to point at.
  const insertSession = db.prepare("INSERT OR IGNORE INTO session (id, uid) VALUES (?, ?)");
  for (const row of rows) {
    if (row.sessionId !== null) {
      insertSession.run(row.sessionId, `run-${row.sessionId}`);
    }
  }
  const insertSignal = db.prepare("INSERT INTO signal (key, unit, grp, source) VALUES (?, '', 'x', 'stream')");
  const signalId = new Map<string, number>();
  const insertReading = db.prepare("INSERT INTO reading (ts, signal_id, value, session_id) VALUES (?, ?, ?, ?)");
  for (const row of rows) {
    let id = signalId.get(row.key);
    if (id === undefined) {
      id = Number(insertSignal.run(row.key).lastInsertRowid);
      signalId.set(row.key, id);
    }
    insertReading.run(row.ts, id, row.value, row.sessionId);
  }
  return db;
}

/**
 * The evidence a charge session is detected from: ten minutes of mains current.
 *
 * Four fixtures needed this and each grew its own copy of the loop. It is not decoration —
 * the detector wants > 0.5 A and a span over the 5-minute HAVING, so a fixture that gets it
 * wrong silently produces no session at all and every assertion about the pin vanishes with it.
 */
function chargeEvidence(startTs: number, sessionId: number | null): Row[] {
  const rows: Row[] = [];
  for (let offset = 0; offset < 600_000; offset += 10_000) {
    rows.push({ key: "mains_a", ts: startTs + offset, value: 12, sessionId });
  }
  return rows;
}

/**
 * A parked bike logging fixes up to plug-in, then a charge.
 *
 * `driftDeg` is the ordinary metre-scale wander between samples; the archive's own p99.9
 * step under 700 ms is 29.6 m, so this is the shape a real approach to a charger has.
 */
function chargeStopRows(options: {
  samples: number;
  sessionId: number | null;
  /** Applied to the last sample at or before plug-in. */
  excursion?: { axis: "gps_lat" | "gps_lon"; delta: number };
  /** Whether the hub logs anything after plug-in, which is what a live receiver does. */
  correctionAfterPlugIn: boolean;
}): { rows: Row[]; startTs: number; lastGoodLatitude: number; lastGoodLongitude: number } {
  const rows: Row[] = [];
  const drift = 0.00004;
  for (let index = 0; index < options.samples; index += 1) {
    rows.push({
      key: "gps_lat",
      ts: BASE + index * SAMPLE_MS,
      value: LATITUDE + index * drift,
      sessionId: options.sessionId,
    });
    rows.push({
      key: "gps_lon",
      ts: BASE + index * SAMPLE_MS,
      value: LONGITUDE + index * drift,
      sessionId: options.sessionId,
    });
  }
  const lastIndex = options.samples - 1;
  const startTs = BASE + lastIndex * SAMPLE_MS;
  if (options.excursion) {
    for (const row of rows) {
      if (row.ts === startTs && row.key === options.excursion.axis) {
        row.value += options.excursion.delta;
      }
    }
  }
  if (options.correctionAfterPlugIn) {
    // ⚠️ Measured, not assumed: in every session whose last fix is within 1.2 s of plug-in
    // the archive has another fix 0.1-2.6 s AFTER it. The hub does not fall silent the
    // instant the cable goes in, which is what gives the forward arm something to see.
    rows.push({
      key: "gps_lat",
      ts: startTs + SAMPLE_MS,
      value: LATITUDE + lastIndex * drift,
      sessionId: options.sessionId,
    });
    rows.push({
      key: "gps_lon",
      ts: startTs + SAMPLE_MS,
      value: LONGITUDE + lastIndex * drift,
      sessionId: options.sessionId,
    });
  }
  rows.push(...chargeEvidence(startTs, options.sessionId));
  rows.push({ key: "residual_energy_wh", ts: startTs - 1000, value: 1000, sessionId: options.sessionId });
  rows.push({ key: "residual_energy_wh", ts: startTs + 590_000, value: 4000, sessionId: options.sessionId });
  rows.push({ key: "soc", ts: startTs - 1000, value: 30, sessionId: options.sessionId });
  rows.push({ key: "soc", ts: startTs + 590_000, value: 80, sessionId: options.sessionId });
  return {
    rows,
    startTs,
    lastGoodLatitude: LATITUDE + lastIndex * drift,
    lastGoodLongitude: LONGITUDE + lastIndex * drift,
  };
}

interface MapRow {
  stop_lat: number;
  stop_lon: number;
  "Fix age (min)": number;
}

/** The map's charge-stop layer (target B), gated and ungated. */
function pins(db: Database.Database, startTs: number): { gated: MapRow[]; ungated: MapRow[] } {
  const from = BASE - 3_600_000;
  const to = startTs + 3_600_000;
  const sql = sqlFor("B", from, to);
  return {
    gated: db.prepare(sql).all() as MapRow[],
    ungated: db.prepare(withoutTheClause(sql)).all() as MapRow[],
  };
}

// --- 1. Nothing wrong with the data ---------------------------------------------------

console.log("\n1. a clean approach to a charger");

const clean = chargeStopRows({ samples: 30, sessionId: 1, correctionAfterPlugIn: true });
const cleanPins = pins(databaseWith(clean.rows), clean.startTs);
check("one charge stop is drawn", cleanPins.gated.length === 1);
check(
  "…at the last fix before plug-in, which the clause leaves alone",
  cleanPins.gated[0].stop_lat === clean.lastGoodLatitude && cleanPins.gated[0].stop_lon === clean.lastGoodLongitude
);
check(
  "…and the gated and ungated queries agree, so the clause costs a clean map nothing",
  cleanPins.gated[0].stop_lon === cleanPins.ungated[0].stop_lon
);

// --- 2. The leading-digit excursion, with the correction logged -----------------------

console.log("\n2. ⚠️  a leading-digit excursion as the last fix before plug-in");

// The archive's own shape: a longitude carrying an extra leading digit. It is a legal
// coordinate, so no range gate sees it, and it lands ~100° from the track.
const forward = chargeStopRows({
  samples: 30,
  sessionId: 1,
  excursion: { axis: "gps_lon", delta: 100 },
  correctionAfterPlugIn: true,
});
const forwardPins = pins(databaseWith(forward.rows), forward.startTs);
check(
  "⚠️  the shipped query would have inherited the excursion — so this fixture reaches the clause",
  forwardPins.ungated[0].stop_lon === forward.lastGoodLongitude + 100
);
check(
  "…and the gated query steps back to a fix nothing contradicts",
  Math.abs(forwardPins.gated[0].stop_lon - LONGITUDE) < 1
);

// --- 2b. An excursion with no BACKWARD witness -----------------------------------------

console.log("\n2b. ⚠️  an excursion whose only witness is the fix after it");

// ⚠️ WITHOUT THIS THE FORWARD ARM HAS NO TEST. Every other excursion fixture puts the spike
// at the end of an unbroken run of samples, so a backward witness is always there and a
// backward-only clause passes them all. Here the receiver had been quiet for 10 s, so the
// row before the excursion is outside the window and the correction after it is the only
// thing that can contradict it — which is the ordinary shape of a fix taken as the bike
// arrives at a charger after a stretch of poor reception.
const forwardOnly: Row[] = [];
for (let index = 0; index < 10; index += 1) {
  forwardOnly.push({ key: "gps_lat", ts: BASE + index * SAMPLE_MS, value: LATITUDE, sessionId: 1 });
  forwardOnly.push({ key: "gps_lon", ts: BASE + index * SAMPLE_MS, value: LONGITUDE, sessionId: 1 });
}
const quietUntil = BASE + 9 * SAMPLE_MS + 10_000;
forwardOnly.push({ key: "gps_lat", ts: quietUntil, value: LATITUDE, sessionId: 1 });
forwardOnly.push({ key: "gps_lon", ts: quietUntil, value: LONGITUDE + 100, sessionId: 1 });
const forwardStart = quietUntil + 100;
// The correction lands after plug-in, which the clause can see and `r.ts <= sess.start_ts`
// cannot — the whole point of looking forward. ⚠️ And it lands at the archive's measured
// WORST delay rather than its median one, which is what pins the window's lower bound: with
// the correction at the usual 550 ms a window narrowed to 600 ms passed this too, so the
// constant was only ever tested against the hub's typical beat.
forwardOnly.push({ key: "gps_lat", ts: quietUntil + WORST_MEASURED_LIFETIME_MS, value: LATITUDE, sessionId: 1 });
forwardOnly.push({ key: "gps_lon", ts: quietUntil + WORST_MEASURED_LIFETIME_MS, value: LONGITUDE, sessionId: 1 });
forwardOnly.push(...chargeEvidence(forwardStart, 1));
const forwardOnlyPins = pins(databaseWith(forwardOnly), forwardStart);
check(
  "the shipped query inherits it — the row before is 10 s away, so only the one after objects",
  forwardOnlyPins.ungated[0].stop_lon === LONGITUDE + 100
);
check(
  "⚠️  and the forward arm steps back, with no backward witness inside the window at all",
  forwardOnlyPins.gated[0].stop_lon === LONGITUDE
);

// --- 2c. The window's UPPER side ------------------------------------------------------

console.log("\n2c. ⚠️  a window too WIDE deletes the pin it was meant to protect");

// ⚠️ WITHOUT THIS THE 2 000 ms IS UNPINNED IN THE DIRECTION THAT MATTERS. Narrowing it is
// caught by any fixture whose correction lands 550 ms later — but that tests the hub's
// cadence, not the constant. Widening it was caught by nothing: ±12 s passed every case
// above, while marking 37 % of gps_lat and 53 % of gps_lon rows across the whole archive.
//
// The discriminator is the argument docs/route-map.md already makes: the window has to be
// short enough that the BIKE cannot cross the 0.002° threshold inside it. Here it is moving
// at ~80 km/h on the way to the charger — 12.2 m per sample, 37 m in 2 s, but 256 m in 12 s
// against a threshold of 222.6 m in latitude. At ±2 s the last fix before plug-in is clean;
// at ±12 s it is "contradicted" by its own honest movement, and so is every row behind it,
// until the sub-select runs out of candidates and the map loses the stop altogether.
const moving: Row[] = [];
const metresPerSample = 0.00011;
for (let index = 0; index < 40; index += 1) {
  moving.push({
    key: "gps_lat",
    ts: BASE + index * SAMPLE_MS,
    value: LATITUDE + index * metresPerSample,
    sessionId: 1,
  });
  moving.push({ key: "gps_lon", ts: BASE + index * SAMPLE_MS, value: LONGITUDE, sessionId: 1 });
}
const movingStart = BASE + 39 * SAMPLE_MS + 100;
moving.push(...chargeEvidence(movingStart, 1));
const movingPins = pins(databaseWith(moving), movingStart);
check("⚠️  a bike still moving when it arrives keeps its charge pin", movingPins.gated.length === 1);
check(
  "…at the last fix before plug-in, not at one the ride's own movement contradicted",
  movingPins.gated.length === 1 && movingPins.gated[0].stop_lat === LATITUDE + 39 * metresPerSample
);

// --- 3. The same in latitude ----------------------------------------------------------

console.log("\n3. the other axis, since they are resolved by separate sub-selects");

const latitudeCase = chargeStopRows({
  samples: 30,
  sessionId: 1,
  excursion: { axis: "gps_lat", delta: 100 },
  correctionAfterPlugIn: true,
});
const latitudePins = pins(databaseWith(latitudeCase.rows), latitudeCase.startTs);
check("the ungated query inherits the latitude excursion", latitudePins.ungated[0].stop_lat > LATITUDE + 50);
check("…and the gated one does not", Math.abs(latitudePins.gated[0].stop_lat - LATITUDE) < 1);

// --- 4. The end-of-data case, which is the mechanism #173 describes --------------------

console.log("\n4. ⚠️  the receiver falls silent right after the excursion");

// This is the case the issue actually raised, and the one a FORWARD-ONLY clause cannot
// reach: with nothing logged after the excursion there is no correction to contradict it.
// The backward arm is what covers it — an ordinary sample 550 ms EARLIER disagrees with
// the excursion whether or not the receiver ever speaks again.
const endOfData = chargeStopRows({
  samples: 30,
  sessionId: 1,
  excursion: { axis: "gps_lon", delta: 100 },
  correctionAfterPlugIn: false,
});
const endPins = pins(databaseWith(endOfData.rows), endOfData.startTs);
check(
  "⚠️  the shipped query inherits it and keeps it for the whole session",
  endPins.ungated[0].stop_lon === endOfData.lastGoodLongitude + 100
);
check(
  "⚠️  …and the backward arm still steps back, with no successor anywhere in the database",
  Math.abs(endPins.gated[0].stop_lon - LONGITUDE) < 1
);

// --- 5. A small excursion, the size the threshold actually decides ---------------------

console.log("\n5. an excursion just over the threshold, not a hundred degrees");

// ⚠️ Without this the 0.002° threshold has no test: a ~100° fixture is still contradicted
// at 0.2°, so a mutation of the constant would pass every case above.
const small = chargeStopRows({
  samples: 30,
  sessionId: 1,
  excursion: { axis: "gps_lon", delta: 0.0025 },
  correctionAfterPlugIn: true,
});
const smallPins = pins(databaseWith(small.rows), small.startTs);
check(
  "the ungated query inherits a 0.0025° excursion",
  smallPins.ungated[0].stop_lon === small.lastGoodLongitude + 0.0025
);
check(
  "…and the gated one rejects it, which is what the 0.002° threshold is for",
  smallPins.gated[0].stop_lon !== small.lastGoodLongitude + 0.0025
);

// --- 6. A bike that was genuinely carried ---------------------------------------------

console.log("\n6. a real gap is not an excursion");

// A ride, then six hours and three degrees away, then one fix and a plug-in. The clause
// must have no opinion: its window is ±2 s, and a gap that size is outside it.
const carried: Row[] = [];
for (let index = 0; index < 20; index += 1) {
  carried.push({ key: "gps_lat", ts: BASE + index * SAMPLE_MS, value: LATITUDE, sessionId: 1 });
  carried.push({ key: "gps_lon", ts: BASE + index * SAMPLE_MS, value: LONGITUDE, sessionId: 1 });
}
const carriedFixTs = BASE + 20 * SAMPLE_MS + 6 * 3_600_000;
carried.push({ key: "gps_lat", ts: carriedFixTs, value: LATITUDE + 3, sessionId: 1 });
carried.push({ key: "gps_lon", ts: carriedFixTs, value: LONGITUDE + 3, sessionId: 1 });
const carriedStart = carriedFixTs + 2000;
carried.push(...chargeEvidence(carriedStart, 1));
const carriedPins = pins(databaseWith(carried), carriedStart);
check(
  "the fix at the charger is kept, three degrees from the ride and six hours later",
  carriedPins.gated[0].stop_lat === LATITUDE + 3 && carriedPins.gated[0].stop_lon === LONGITUDE + 3
);

// --- 7. Two boots interleaved across a clock step -------------------------------------

console.log("\n7. ⚠️  two runs whose rows interleave, because the Pi steps its clock");

// The archive does this three times: a boot's first rows are stamped from a clock that has
// not been corrected yet, so in `ts` order they sit among the PREVIOUS boot's rows, hundreds
// of km away. Without the session predicate those rows contradict each other and the clause
// rejects fixes that are real — 26 gps_lat and 29 gps_lon rows over the archive.
const interleaved: Row[] = [];
for (let index = 0; index < 20; index += 1) {
  interleaved.push({ key: "gps_lat", ts: BASE + index * SAMPLE_MS, value: LATITUDE, sessionId: 1 });
  interleaved.push({ key: "gps_lon", ts: BASE + index * SAMPLE_MS, value: LONGITUDE, sessionId: 1 });
}
// Boot 2, three degrees away, its first rows landing between boot 1's in `ts`.
for (let index = 0; index < 20; index += 1) {
  const ts = BASE + index * SAMPLE_MS + 100;
  interleaved.push({ key: "gps_lat", ts, value: LATITUDE + 3, sessionId: 2 });
  interleaved.push({ key: "gps_lon", ts, value: LONGITUDE + 3, sessionId: 2 });
}
const interleavedStart = BASE + 19 * SAMPLE_MS + 200;
interleaved.push(...chargeEvidence(interleavedStart, 2));
const interleavedPins = pins(databaseWith(interleaved), interleavedStart);
check(
  "⚠️  boot 2's own last fix is inherited, not rejected because boot 1 was 3° away at the same ts",
  interleavedPins.gated.length === 1 && interleavedPins.gated[0].stop_lat === LATITUDE + 3
);

// --- 8. The un-sessioned block, where `=` would switch the gate off -------------------

console.log("\n8. ⚠️  rows with no session at all");

// 110 654 GPS rows in the archive carry session_id IS NULL, spanning a week that includes
// the 2026-08-09 corrupt longitude. `NULL = NULL` is unknown, so an `=` here would satisfy
// NOT EXISTS for every one of them and switch this gate OFF over that whole block — failing
// OPEN, silently, on exactly the rows it exists for. `IS` is what keeps it running.
const unsessioned = chargeStopRows({
  samples: 30,
  sessionId: null,
  excursion: { axis: "gps_lon", delta: 100 },
  correctionAfterPlugIn: true,
});
const unsessionedPins = pins(databaseWith(unsessioned.rows), unsessioned.startTs);
check(
  "⚠️  an excursion among rows with no session is still contradicted",
  Math.abs(unsessionedPins.gated[0].stop_lon - LONGITUDE) < 1
);

// --- 9. The rows stamped 2060 ----------------------------------------------------------

console.log("\n9. the 2060 rows cannot reach into a 2026 window");

// A corrupt GPS frame once stepped the Pi's clock to 2060 and stamped 49 772 rows with it.
// Every query guards with `ts < 2000000000000`; the inner sub-select does not need to,
// because 34 years is not within 2 s — asserted here rather than left to a reader.
const withFuture = chargeStopRows({ samples: 30, sessionId: 1, correctionAfterPlugIn: true });
withFuture.rows.push({ key: "gps_lat", ts: 2_840_000_000_000, value: LATITUDE + 50, sessionId: 1 });
withFuture.rows.push({ key: "gps_lon", ts: 2_840_000_000_000, value: LONGITUDE + 50, sessionId: 1 });
const futurePins = pins(databaseWith(withFuture.rows), withFuture.startTs);
check(
  "a row stamped 2060 neither draws a pin nor contradicts a 2026 one",
  futurePins.gated.length === 1 && futurePins.gated[0].stop_lat === withFuture.lastGoodLatitude
);

// --- 10. The four targets that share one `detail` CTE ----------------------------------

console.log("\n10. the four targets stay one query");

const tableSql = sqlFor("G", BASE - 3_600_000, forward.startTs + 3_600_000);
const tableRows = databaseWith(forward.rows).prepare(tableSql).all() as MapRow[];
const mapAge = forwardPins.gated[0]["Fix age (min)"];
check(
  `the table and the map report the same fix age (${mapAge} min)`,
  tableRows.length === 1 && tableRows[0]["Fix age (min)"] === mapAge
);

// ⚠️ D and E WRAP G'S BODY VERBATIM, which is the only thing keeping the four in step — the
// tiles select COUNT(*) and SUM(), so the position sub-selects are inert in them and no
// behavioural assertion can notice the clause going missing from one. This one can.
const bodyOfG = targets.get("G")?.rawQueryText ?? "";
for (const refId of ["D", "E"]) {
  const wrapper = targets.get(refId)?.rawQueryText ?? "";
  check(
    `${refId} still contains G's body verbatim, so an edit to G cannot leave it behind`,
    bodyOfG.length > 0 && wrapper.includes(bodyOfG)
  );
}
for (const refId of ["B", "D", "E", "G"]) {
  const sql = targets.get(refId)?.rawQueryText ?? "";
  check(
    `${refId} carries the clause on all three of its GPS sub-selects`,
    (sql.match(/AND NOT EXISTS \(/g) ?? []).length === 3
  );
  check(
    `${refId} compares the session with IS, never =`,
    sql.includes("r2.session_id IS r.session_id") && !sql.includes("r2.session_id = r.session_id")
  );
}

console.log(
  failures === 0
    ? "\n✓ the charge-stop position is corroborated before it is drawn, on both axes and in both directions"
    : `\n✗ the route map's charge-stop lookup — ${failures} failure${failures === 1 ? "" : "s"}`
);
process.exit(failures === 0 ? 0 : 1);
