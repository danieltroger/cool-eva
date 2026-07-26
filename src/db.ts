import Database from "better-sqlite3";

// Long/EAV schema (see obd-garage/INTEGRATION_PLAN.md §SQLite schema):
//   signal  — tiny registry, one row per signal key
//   reading — (ts, signal_id, value), one row per logged sample (log-on-change)
//   info    — static strings (VIN/ECU name/migration markers), log once
// The legacy `readings(timestamp, sensor, celsius)` table is kept untouched as a
// backup and its history is migrated into `reading` once (see migrateLegacy()).

export type SignalSource = "stream" | "poll" | "sensor";

interface QueuedRow {
  ts: number;
  signal_id: number;
  value: number;
}

let db: Database.Database;
let insertReading: Database.Statement;
let insSignal: Database.Statement;
let selSignal: Database.Statement;
let upsertInfo: Database.Statement;
let selInfo: Database.Statement;
let flushTxn: (rows: QueuedRow[]) => void;
let flushTimer: ReturnType<typeof setInterval> | undefined;

const signalIdCache = new Map<string, number>();
let queue: QueuedRow[] = [];
let dbStreamPins = 0;

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
    CREATE TABLE IF NOT EXISTS reading (
      ts        INTEGER NOT NULL,
      signal_id INTEGER NOT NULL REFERENCES signal(id),
      value     REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_reading_sig_ts ON reading(signal_id, ts);
    CREATE TABLE IF NOT EXISTS info (
      key   TEXT PRIMARY KEY,
      value TEXT,
      ts    INTEGER
    );
  `);

  insertReading = db.prepare("INSERT INTO reading (ts, signal_id, value) VALUES (?, ?, ?)");
  insSignal = db.prepare("INSERT INTO signal (key, unit, grp, source) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO NOTHING");
  selSignal = db.prepare("SELECT id FROM signal WHERE key = ?");
  upsertInfo = db.prepare(
    "INSERT INTO info (key, value, ts) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, ts = excluded.ts"
  );
  selInfo = db.prepare("SELECT value FROM info WHERE key = ?");

  const txn = db.transaction((rows: QueuedRow[]) => {
    for (const r of rows) insertReading.run(r.ts, r.signal_id, r.value);
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
export function recordReading(
  ts: number,
  key: string,
  value: number,
  unit: string,
  grp: string,
  source: SignalSource
): void {
  const id = getSignalId(key, unit, grp, source);
  queue.push({ ts, signal_id: id, value });
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

// The /db endpoint streams the raw main database FILE (see db-endpoint.ts). In WAL
// mode that file only ever changes on a checkpoint, so we "pin" it for the duration
// of a download to hand out a consistent snapshot without copying the whole ~0.5 GB
// DB first: fold the WAL in once (so the file is complete + current), then turn off
// auto-checkpointing so nothing rewrites the file mid-stream. Logging is uninterrupted
// — new samples just accumulate in the WAL until we unpin and fold them back in.
// Ref-counted so overlapping downloads are safe: only the first pin checkpoints, only
// the last unpin restores.
export function pinDbFileForStreaming(): void {
  if (dbStreamPins === 0) {
    flushNow(); // persist queued samples so the snapshot is up to date…
    db.pragma("wal_checkpoint(TRUNCATE)"); // …fold the WAL into the main file and empty the WAL
    db.pragma("wal_autocheckpoint = 0"); // freeze the main file: no checkpoint touches it while streaming
  }
  dbStreamPins++;
}

export function unpinDbFile(): void {
  dbStreamPins--;
  if (dbStreamPins <= 0) {
    dbStreamPins = 0;
    db.pragma("wal_autocheckpoint = 1000"); // restore SQLite's default auto-checkpoint threshold
    db.pragma("wal_checkpoint(PASSIVE)"); // fold in whatever the WAL accumulated during the download(s)
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
