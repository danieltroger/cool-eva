import { mkdir, readFile } from "fs/promises";
import { join } from "path";
import { readRunningVersion } from "../version.ts";
import { appendDurably } from "../storage/durable.ts";

// Every attempt to change something on this motorcycle, appended to one file, for ever.
// What was asked for, what the bike held before, what it held after, and how it went —
// including the attempts that were refused, and especially those.
//
// A snapshot diff catches the FACT of a change and not its author; this journal is what
// turns "something reconfigured the bike" into "service mode wrote 80 into
// MAX_DC_CHG_CURRENT at 14:02 on 2026-08-23, over a 75 that it read first".
//
// Append-only, one JSON object per line, the same shape as `sweep.partial.jsonl` and for
// the same reasons: a torn write costs the last line and nothing else, it survives a
// service restart mid-write, and it can be read with `tail`. Never rewritten, never
// compacted, never pruned — this file should be boring and enormous rather than clever and
// short.
//
// ⚠️ A REFUSED attempt is recorded exactly as carefully as a successful one. It is the only
// place SecurityAccess attempts get counted, and those are the resource that runs out.
// Why the hand-maintained record was not enough: docs/vcu-parameters.md §16.

const AUDIT_FILE = "service-writes.jsonl";

/** What kind of change was attempted. A closed union so the file cannot grow shapes nothing reads. */
export type AuditAction =
  | "parameter-write"
  | "set-service-point"
  | "clear-dtcs"
  | "rtc-sync"
  /** A charge-current-limit command on 0x121. Fire-and-forget, so recorded like rtc-sync. */
  | "charge-current"
  /** A stop-charging command — the 0x120 Mode-stop request-twin. Fire-and-forget, recorded like charge-current. */
  | "charge-stop"
  /** ECUReset (11 02) on both VCU micros — a key-cycle restart. Recorded because it drops the bike off the bus. */
  | "reset-vcu"
  /** Reading the last-service block. Read-only, but recorded because it is the before-picture of the routine. */
  | "read-service-stamp";

/** One line of the journal. */
export interface AuditRecord {
  /**
   * Wall clock, milliseconds. ⚠️ This Pi has no RTC and steps its own clock from GPS,
   * so a stamp here can be wrong — and a concurrent fix exists precisely because a
   * date-decode bug once stamped 49 772 rows of this bike's log as the year 2060. It
   * is recorded anyway because a rough "when" is far better than none, and
   * `clockTrustworthy` says whether to believe it.
   */
  at: number;
  /** Whether src/vcu/service-actions.ts's clock check passed at the moment this was written. */
  clockTrustworthy: boolean;
  action: AuditAction;
  /** How it went, in the outcome vocabulary of the action's own module. */
  status: string;
  /** The parameter, when there was one. */
  name?: string;
  identifier?: number;
  micro?: string;
  /** What the bike held before, as READ off the bus — never as the caller believed. */
  before?: number | string | null;
  /** What it held after, from the read-back. Null when the action has no read-back (a clock sync has none). */
  after?: number | string | null;
  /** What was asked for, so an attempt that never landed still records its intent. */
  requested?: number | string | null;
  /** The bytes, where there are bytes worth keeping. */
  rawHex?: string;
  /** Why it failed, or what is unusual about it succeeding. */
  note?: string;
  /**
   * Which commit was running when this happened — `09c3b84`, `09c3b84+dirty`, or `unknown`.
   *
   * ⚠️ Stamped by appendAuditRecord rather than by the callers, so a future action cannot
   * forget it. The 2026-09-07 charge-current records are the argument: they say exactly what
   * was sent and there is no way to tell from them that the build was five days old, which is
   * the one fact that explained the whole failure. src/version.ts.
   */
  runningVersion?: string;
}

/**
 * Appends one record. Never throws into a caller.
 *
 * ⚠️ A failure to WRITE THE JOURNAL must not stop or undo the action — by the time
 * this is called the frame is already on the bus and the EEPROM cell has already
 * changed. So the only honest thing left is to be extremely loud about having lost
 * the record, which is what this does. A silent catch here would mean a bike whose
 * calibration changed with nothing anywhere saying so.
 */
export async function appendAuditRecord(directory: string, record: AuditRecord): Promise<void> {
  // Read here rather than pushed in at startup: readRunningVersion() is already cached, so this is
  // one map lookup, and it removes both a module global and an ordering rule ("must be set before
  // anything can be written") that a script or a reordered startup could silently break.
  const stamped: AuditRecord = { ...record, runningVersion: (await readRunningVersion()).label };
  try {
    await mkdir(directory, { recursive: true });
    // Flushed before it counts as recorded, and the directory too on the first record
    // ever written here — an unflushed append comes back as NULs after a power cut, which
    // is how a 1710-NUL line got into this file on 2026-09-08. docs/power-cuts.md.
    await appendDurably(join(directory, AUDIT_FILE), `${JSON.stringify(stamped)}\n`);
  } catch (err) {
    console.error("=".repeat(72));
    console.error(`vcu-write: COULD NOT RECORD ${record.action} (${record.status}) IN THE AUDIT JOURNAL:`, err);
    console.error(`vcu-write: the record that may not have reached the card: ${JSON.stringify(stamped)}`);
    console.error("vcu-write: the action itself already happened. Copy the line above somewhere by hand.");
    console.error("=".repeat(72));
  }
}

/**
 * The most recent records, newest first.
 *
 * `limit` exists because this file only grows and the page shows a handful. Read
 * whole and sliced rather than seeked backwards: at one line per deliberate change to
 * a motorcycle, it will be kilobytes in a decade.
 */
export async function recentAuditRecords(directory: string, limit: number): Promise<AuditRecord[]> {
  let text: string;
  try {
    text = await readFile(join(directory, AUDIT_FILE), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      // Not silent: a journal that cannot be read looks exactly like a journal with
      // nothing in it, and those are very different claims about a motorcycle.
      console.warn(`vcu-write: could not read the audit journal in ${directory}:`, err);
    }
    return [];
  }
  const records: AuditRecord[] = [];
  const lines = text.split("\n");
  for (const [position, line] of lines.entries()) {
    if (line.trim().length === 0) {
      continue;
    }
    if (line.replace(/\0/g, "").trim().length === 0) {
      // A HOLE, not a parse failure. A power cut mid-append leaves the block allocated and
      // the write lost, so the line comes back as NUL bytes (docs/power-cuts.md). U+0000 is
      // not JS whitespace, so the trim above does not catch it and this reached JSON.parse —
      // which threw a stack trace on every GET and POST to /vcu-write, complaining about a
      // line whose NULs its own message renders as spaces.
      //
      // ⚠️ Still a WARNING, and deliberately so: a torn tail is a process that was killed,
      // a hole is a DAMAGED FILE, and the level is the only thing carrying that difference
      // (check-power-cut-durability.ts §3). What changes is that it names the injury and
      // carries no stack trace. Nothing is recovered — these bytes are not a record — and
      // #164 stops NEW holes without repairing the file that already has one.
      console.warn(
        `vcu-write: ${AUDIT_FILE} line ${position + 1} is ${line.length} NUL bytes — a record lost to a power cut, not a parse error`
      );
      continue;
    }
    try {
      records.push(JSON.parse(line) as AuditRecord);
    } catch (err) {
      // Only the last line can be a torn append. Anywhere else is a damaged file, and
      // quietly skipping it would lower the count of what was done to this bike.
      if (position === lines.length - 1) {
        console.log(`vcu-write: ${AUDIT_FILE} ends mid-record — something was killed while writing it`);
        continue;
      }
      console.warn(`vcu-write: ${AUDIT_FILE} line ${position + 1} is not valid JSON:`, err);
    }
  }
  return records.reverse().slice(0, limit);
}
