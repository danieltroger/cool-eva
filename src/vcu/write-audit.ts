import { mkdir, open, readFile } from "fs/promises";
import { join } from "path";

// Every attempt to change something on this motorcycle, appended to one file, for
// ever. What was asked for, what the bike held before, what it held after, and how it
// went — including the attempts that were refused, and especially those.
//
// ── Why this exists at all ───────────────────────────────────────────────────
// obd-garage/VCU_PARAM_CHANGES.md is the current record of what has been changed on
// this bike, and it is a hand-maintained markdown file in a folder that is not even
// in this repository. It has already proved its worth twice — it is what made
// "neither MAX_DC_CHG_CURRENT nor FCHG_CURRENT_GAIN was ever touched" a checkable
// claim, which is what killed a whole hypothesis about the charge ceiling. But a
// hand-maintained file records the changes someone remembered to write down.
//
// A parameter sweep is the other half: src/vcu/snapshot-store.ts diffs every snapshot
// against the last and shouts when a value moved. That catches the FACT of a change
// and not its author — "something reconfigured the bike" is exactly as far as a diff
// can go. This journal is what turns that into "service mode wrote 80 into
// MAX_DC_CHG_CURRENT at 14:02 on 2026-08-23, over a 75 that it read first".
//
// ── Append-only, one JSON object per line ────────────────────────────────────
// The same shape as `sweep.partial.jsonl` and for the same reasons: a torn write
// costs the last line and nothing else, it survives a service restart mid-write, and
// it can be read with `tail`. Never rewritten, never compacted, never pruned — this
// is a file that should be boring and enormous rather than clever and short.
//
// ⚠️ A REFUSED attempt is recorded exactly as carefully as a successful one. "The
// micro refused this three times" is the record that matters when someone is trying
// to work out why a parameter will not take, and a journal that only holds successes
// is a journal that answers no interesting question. It is also the only place the
// SecurityAccess attempts get counted, and those are the resource that runs out.

const AUDIT_FILE = "service-writes.jsonl";

/** What kind of change was attempted. A closed union so the file cannot grow shapes nothing reads. */
export type AuditAction =
  | "parameter-write"
  | "set-service-point"
  | "clear-dtcs"
  | "rtc-sync"
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
  try {
    await mkdir(directory, { recursive: true });
    const handle = await open(join(directory, AUDIT_FILE), "a");
    try {
      await handle.write(`${JSON.stringify(record)}\n`);
    } finally {
      await handle.close();
    }
  } catch (err) {
    console.error("=".repeat(72));
    console.error(`vcu-write: COULD NOT RECORD ${record.action} (${record.status}) IN THE AUDIT JOURNAL:`, err);
    console.error(`vcu-write: the record that was lost: ${JSON.stringify(record)}`);
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
