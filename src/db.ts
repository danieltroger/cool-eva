// NOTE: as of the encrypted-ride-log change the Pi no longer writes SQLite at
// all — this module now exists for scripts/decrypt-log.ts, which rebuilds a
// plaintext DB on the laptop from decrypted segments so Grafana keeps working.

import Database from "better-sqlite3";

// Long/EAV schema (see obd-garage/INTEGRATION_PLAN.md §SQLite schema):
//   signal  — tiny registry, one row per signal key
//   session — tiny registry, one row per run of the Pi that produced readings
//   reading — (ts, signal_id, value, session_id, seq), one row per logged sample
//   info    — static strings (VIN/ECU name/migration markers), log once
// The legacy `readings(timestamp, sensor, celsius)` table is kept untouched as a
// backup and its history is migrated into `reading` once (see migrateLegacy()).
//
// `ts` is a wall-clock stamp and nothing more. On a Pi with no RTC that clock steps
// (../gps/clock.ts), so ORDER BY ts is not write order — the 2060 incident put
// 49 772 rows 34 years in the future, ahead of everything logged after them.
// (session_id, seq) is the write order, counted rather than clocked; see the note on
// nextSequence in storage/encrypted-log.ts for why bumping `ts` instead would be
// strictly worse. Both are nullable: readings sealed before 2026-08-16 were written
// without a counter, and NULL is the honest way to say so.

export type SignalSource = "stream" | "poll" | "sensor";

interface QueuedRow {
  ts: number;
  signal_id: number;
  value: number;
  session_id: number | null;
  seq: number | null;
}

let db: Database.Database;
let insertReading: Database.Statement;
let insSignal: Database.Statement;
let selSignal: Database.Statement;
let insSession: Database.Statement;
let selSession: Database.Statement;
let upsertInfo: Database.Statement;
let selInfo: Database.Statement;
let flushTxn: (rows: QueuedRow[]) => void;
let flushTimer: ReturnType<typeof setInterval> | undefined;

const signalIdCache = new Map<string, number>();
const sessionIdCache = new Map<string, number>();
let queue: QueuedRow[] = [];

export function initDb(path: string, flushMs = 200): void {
  db = new Database(path);
  db.pragma("journal_mode = WAL");

  // Keep the legacy table definition so old data is never dropped.
  db.exec(`
    CREATE TABLE IF NOT EXISTS readings (
      timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      sensor    TEXT NOT NULL,
      celsius   REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS signal (
      id     INTEGER PRIMARY KEY,
      key    TEXT UNIQUE,
      unit   TEXT,
      grp    TEXT,
      source TEXT
    );
    CREATE TABLE IF NOT EXISTS session (
      id  INTEGER PRIMARY KEY,
      uid TEXT UNIQUE
    );
    CREATE TABLE IF NOT EXISTS reading (
      ts         INTEGER NOT NULL,
      signal_id  INTEGER NOT NULL REFERENCES signal(id),
      value      REAL NOT NULL,
      session_id INTEGER REFERENCES session(id),
      seq        INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_reading_sig_ts ON reading(signal_id, ts);
    CREATE TABLE IF NOT EXISTS info (
      key   TEXT PRIMARY KEY,
      value TEXT,
      ts    INTEGER
    );
  `);
  addOrderingColumns();

  insertReading = db.prepare("INSERT INTO reading (ts, signal_id, value, session_id, seq) VALUES (?, ?, ?, ?, ?)");
  insSession = db.prepare("INSERT INTO session (uid) VALUES (?) ON CONFLICT(uid) DO NOTHING");
  selSession = db.prepare("SELECT id FROM session WHERE uid = ?");
  insSignal = db.prepare("INSERT INTO signal (key, unit, grp, source) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO NOTHING");
  selSignal = db.prepare("SELECT id FROM signal WHERE key = ?");
  upsertInfo = db.prepare(
    "INSERT INTO info (key, value, ts) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, ts = excluded.ts"
  );
  selInfo = db.prepare("SELECT value FROM info WHERE key = ?");

  const txn = db.transaction((rows: QueuedRow[]) => {
    for (const r of rows) insertReading.run(r.ts, r.signal_id, r.value, r.session_id, r.seq);
  });
  flushTxn = txn;

  migrateLegacy();

  flushTimer = setInterval(flushNow, flushMs);
}

export function getSignalId(key: string, unit: string, grp: string, source: SignalSource): number {
  const cached = signalIdCache.get(key);
  if (cached !== undefined) return cached;
  insSignal.run(key, unit, grp, source);
  const row = selSignal.get(key) as { id: number };
  signalIdCache.set(key, row.id);
  return row.id;
}

// Queue a sample for the next batched flush. Caller (signals.ts) has already
// decided this value is worth logging (change-detection / deadband).
//
// `session` and `seq` come straight off the ride-log segment being rebuilt and are
// undefined for segments sealed before the counter existed. Passing them through
// unchanged rather than renumbering here is the point: a value this code invented
// would order the rows it read, not the rows the Pi wrote.
export function recordReading(
  ts: number,
  key: string,
  value: number,
  unit: string,
  grp: string,
  source: SignalSource,
  session?: string,
  seq?: number
): void {
  const id = getSignalId(key, unit, grp, source);
  const sessionRowId = session === undefined ? null : getSessionId(session);
  queue.push({ ts, signal_id: id, value, session_id: sessionRowId, seq: seq ?? null });
}

/** Interns a ride-log session id, the same way getSignalId interns a signal key. */
export function getSessionId(uid: string): number {
  const cached = sessionIdCache.get(uid);
  if (cached !== undefined) return cached;
  insSession.run(uid);
  const row = selSession.get(uid) as { id: number };
  sessionIdCache.set(uid, row.id);
  return row.id;
}

export function flushNow(): void {
  if (queue.length === 0) return;
  const rows = queue;
  queue = [];
  flushTxn(rows);
}

export function setInfo(key: string, value: string): void {
  upsertInfo.run(key, value, Date.now());
}

export function getInfo(key: string): string | undefined {
  const row = selInfo.get(key) as { value: string } | undefined;
  return row?.value;
}

export function closeDb(): void {
  if (flushTimer) clearInterval(flushTimer);
  flushNow();
  db.close();
}

/**
 * Adds `session_id` and `seq` to a `reading` table created before they existed.
 *
 * `CREATE TABLE IF NOT EXISTS` above is a no-op against a database that already has
 * the table, so a rides.db rebuilt before 2026-08-16 would keep the three-column
 * shape and every insert would fail on arity. SQLite's ADD COLUMN is a metadata-only
 * edit — it does not rewrite the rows — so this is instant even on the 269 MB file,
 * and every existing row simply reads NULL, which is true: nothing counted them.
 *
 * Driven off PRAGMA rather than a marker in `info`, so it stays correct if someone
 * hand-builds a database or restores an older one over the top.
 */
function addOrderingColumns(): void {
  const columns = db.prepare("SELECT name FROM pragma_table_info('reading')").all() as { name: string }[];
  const present = new Set(columns.map(column => column.name));
  for (const [name, definition] of [
    ["session_id", "INTEGER REFERENCES session(id)"],
    ["seq", "INTEGER"],
  ]) {
    if (!present.has(name)) {
      console.log(`db: adding reading.${name} (write-order columns, added 2026-08-16)`);
      db.exec(`ALTER TABLE reading ADD COLUMN ${name} ${definition}`);
    }
  }
}

// One-time migration of the legacy coolant table into the EAV schema so the
// Grafana dashboard keeps a continuous history. sensor_0 = inlet, sensor_1 =
// outlet (per the original dashboard description). Idempotent via an info marker;
// the legacy `readings` table is left intact as a backup.
function migrateLegacy(): void {
  const hasLegacy = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='readings'").get();
  if (!hasLegacy) return;
  if (getInfo("legacy_readings_migrated")) return;

  const { c } = db.prepare("SELECT COUNT(*) AS c FROM readings").get() as { c: number };
  if (c === 0) {
    setInfo("legacy_readings_migrated", "1");
    return;
  }

  console.log(`db: migrating ${c} legacy coolant readings into EAV schema…`);
  const inId = getSignalId("coolant_in", "°C", "coolant", "sensor");
  const outId = getSignalId("coolant_out", "°C", "coolant", "sensor");

  // Legacy timestamps are UTC ISO strings ("…Z"); strip the Z and let julianday
  // treat them as UTC, then convert to epoch-ms to match Date.now() going forward.
  const copy = db.prepare(`
    INSERT INTO reading (ts, signal_id, value)
    SELECT CAST(round((julianday(replace(timestamp, 'Z', '')) - 2440587.5) * 86400000) AS INTEGER),
           ?, celsius
    FROM readings
    WHERE sensor = ? AND timestamp IS NOT NULL
  `);
  const run = db.transaction(() => {
    copy.run(inId, "sensor_0");
    copy.run(outId, "sensor_1");
  });
  run();

  setInfo("legacy_readings_migrated", "1");
  console.log("db: legacy migration complete.");
}
