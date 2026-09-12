import Database from "better-sqlite3";
import { copyFile, stat } from "fs/promises";
import { createHash } from "crypto";
import { createReadStream } from "fs";
import { RECOVERY_OUTCOME, type RecoveryVerdict } from "../src/gps/recover-holds.ts";

// The only half of the recovery that writes to Daniel's ride log, kept apart from the
// reading half so the dry-run path cannot reach it by accident.
//
// ⚠️ THIS FILE IS THE REASON THE SCRIPT IS SAFE, and the order of the steps is the whole
// argument: back up and VERIFY the copy before opening a writable handle; checksum every
// pre-existing signal before and after; refuse on any mismatch. `rides.db` is the only copy
// of 2026-09-07 on this laptop — there is no .celog for that day here — so a bad write is
// not recoverable from the logs. docs/waypoints.md §"Recovering the holds the phone dropped".

/** Signals the recovery writes. Everything else must checksum identically before and after. */
const WRITTEN_KEYS = ["waypoint_seq", "waypoint_lat", "waypoint_lon"];

/** One signal's fingerprint: the hash catches a MODIFIED row, the count an added or lost one. */
interface SignalDigest {
  digest: string;
  rows: number;
}

export interface CommitResult {
  backupPath: string;
  sessionUid: string;
  insertedRows: number;
}

/**
 * Inserts the recovered waypoints under their own session, with a backup either side.
 *
 * ⚠️ Provenance is the SESSION, not a new signal key. The route map keys on the literal
 * `waypoint_seq`, so a distinct key would be invisible to it without a second copy of a
 * 60-line query; a session uid is per-reading, already joinable, and makes the whole run
 * reversible with one DELETE. The cost, which docs/waypoints.md states plainly: a reader
 * that ignores sessions sees these as live waypoints.
 */
export async function commitRecovered(
  dbPath: string,
  verdicts: RecoveryVerdict[],
  runId: string
): Promise<CommitResult> {
  const recovered = verdicts.filter(verdict => verdict.outcome === RECOVERY_OUTCOME.RECOVERED);
  if (recovered.length === 0) {
    throw new Error("nothing to commit — the report found no recoverable holds");
  }
  const backupPath = `${dbPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  await copyFile(dbPath, backupPath);
  const [originalSize, backupSize] = await Promise.all([stat(dbPath), stat(backupPath)]);
  if (originalSize.size !== backupSize.size) {
    throw new Error(`backup is ${backupSize.size} bytes against ${originalSize.size} — refusing to write`);
  }
  const [originalHash, backupHash] = [await md5OfFile(dbPath), await md5OfFile(backupPath)];
  if (originalHash !== backupHash) {
    throw new Error(`backup md5 ${backupHash} does not match ${originalHash} — refusing to write`);
  }
  console.log(`backup verified: ${backupPath} (${backupSize.size} bytes, md5 ${backupHash})`);

  const db = new Database(dbPath);
  const before = checksumSignals(db);
  const expected = expectedGrowth(before, recovered.length);
  const sessionUid = `recovered-192-${runId}`;
  let insertedRows = 0;
  const insert = db.transaction(() => {
    db.prepare("INSERT INTO session (uid) VALUES (?) ON CONFLICT(uid) DO NOTHING").run(sessionUid);
    const sessionId = (db.prepare("SELECT id FROM session WHERE uid = ?").get(sessionUid) as { id: number }).id;
    const addReading = db.prepare("INSERT INTO reading (ts, signal_id, value, session_id, seq) VALUES (?, ?, ?, ?, ?)");
    let sequence = 0;
    for (const verdict of recovered) {
      sequence += 1;
      for (const [key, value] of [
        ["waypoint_seq", sequence],
        ["waypoint_lat", verdict.latitudeDeg],
        ["waypoint_lon", verdict.longitudeDeg],
      ] as [string, number][]) {
        addReading.run(verdict.fireAt, signalId(db, key), value, sessionId, sequence);
        insertedRows += 1;
      }
    }
    // ⚠️ INSIDE THE TRANSACTION, so a mismatch ROLLS THE WRITE BACK instead of reporting it
    // after the fact. better-sqlite3 aborts the transaction when the function throws, which
    // is the only thing that makes "any change aborts the run" a true sentence. Checking
    // after insert() returned — and worse, after db.close() — left a bad write committed
    // and swallowed the undo statement, which the caller only prints on success.
    assertSupersetOnly(before, checksumSignals(db), expected);
  });
  insert();
  db.close();
  return { backupPath, sessionUid, insertedRows };
}

/**
 * A checksum per signal, not a row count.
 *
 * ⚠️ Counts catch an added or deleted row and MISS a modified one, which is the failure
 * that matters here — a botched UPDATE leaves the count identical. SQLite has no md5(), so
 * this streams the rows and hashes them in JS rather than in SQL.
 */
function checksumSignals(db: Database.Database): Map<string, SignalDigest> {
  const rows = db
    .prepare(
      "SELECT s.key AS key, r.ts AS ts, r.signal_id AS signalId, r.value AS value, " +
        "r.session_id AS sessionId, r.seq AS seq FROM reading r JOIN signal s ON s.id = r.signal_id " +
        "ORDER BY s.key, r.ts, r.seq"
    )
    .iterate() as IterableIterator<Record<string, number | string | null>>;
  const hashes = new Map<string, { hash: ReturnType<typeof createHash>; rows: number }>();
  for (const row of rows) {
    const key = String(row.key);
    let entry = hashes.get(key);
    if (entry === undefined) {
      entry = { hash: createHash("md5"), rows: 0 };
      hashes.set(key, entry);
    }
    entry.rows += 1;
    entry.hash.update(`${row.ts}|${row.signalId}|${row.value}|${row.sessionId}|${row.seq}\n`);
  }
  const digests = new Map<string, SignalDigest>();
  for (const [key, entry] of hashes) {
    digests.set(key, { digest: entry.hash.digest("hex"), rows: entry.rows });
  }
  return digests;
}

/** What each written signal's row count must become. Everything else must not move at all. */
function expectedGrowth(before: Map<string, SignalDigest>, recoveredCount: number): Map<string, number> {
  const wanted = new Map<string, number>();
  for (const key of WRITTEN_KEYS) {
    wanted.set(key, (before.get(key)?.rows ?? 0) + recoveredCount);
  }
  return wanted;
}

/**
 * Every pre-existing signal byte-identical, and the three written ones grown by EXACTLY
 * the number of waypoints claimed.
 *
 * ⚠️ The written keys used to be skipped with a bare `continue`, so the one thing this
 * function existed to police was the one thing it never looked at — and the cheerful
 * "gained N" was the caller's own argument echoed back. Run twice, it printed the same
 * sentence while the waypoints went 1 → 3 → 5.
 */
function assertSupersetOnly(
  before: Map<string, SignalDigest>,
  after: Map<string, SignalDigest>,
  expected: Map<string, number>
): void {
  const moved: string[] = [];
  for (const [key, digest] of before) {
    if (WRITTEN_KEYS.includes(key)) {
      continue;
    }
    if (after.get(key)?.digest !== digest.digest) {
      moved.push(key);
    }
  }
  for (const key of after.keys()) {
    if (!before.has(key) && !WRITTEN_KEYS.includes(key)) {
      moved.push(`${key} (new)`);
    }
  }
  for (const [key, rows] of expected) {
    const got = after.get(key)?.rows ?? 0;
    if (got !== rows) {
      moved.push(`${key} has ${got} rows, expected ${rows}`);
    }
  }
  if (moved.length > 0) {
    throw new Error(`SUPERSET CHECK FAILED, rolling back — ${moved.join("; ")}`);
  }
  const grown = [...expected].map(([key, rows]) => `${key}→${rows}`).join(", ");
  console.log(`superset check passed: ${before.size} signals unchanged; ${grown}`);
}

function signalId(db: Database.Database, key: string): number {
  const row = db.prepare("SELECT id FROM signal WHERE key = ?").get(key) as { id: number } | undefined;
  if (row === undefined) {
    throw new Error(`signal ${key} is not in this database — refusing to invent it`);
  }
  return row.id;
}

function md5OfFile(path: string): Promise<string> {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash("md5");
    const stream = createReadStream(path);
    stream.on("data", chunk => hash.update(chunk));
    stream.on("error", rejectHash);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}
