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

/** The three ways a line can be unreadable. A closed union so a typo cannot open a fourth key. */
type JournalInjury = "hole" | "hole-recovered" | "hole-torn" | "damaged";

/** Which damaged lines have already been named. See warnOnceAbout at the bottom. */
const reportedDamage = new Set<string>();

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
 * a motorcycle, it will be kilobytes in a decade. Measured 2026-09-14: 94 records in
 * 29 562 bytes, 0.134 ms to read and parse. What a tail read would cost, and why the
 * arithmetic says not to: docs/power-cuts.md §3.
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
    const record = readJournalLine(directory, line, position + 1, position === lines.length - 1);
    if (record) {
      records.push(record);
    }
  }
  return records.reverse().slice(0, limit);
}

/**
 * One line, as a record or as a reported injury.
 *
 * ⚠️ The NUL branches come FIRST, so a damaged line at the end of the file is still damage. A
 * hole is a wounded file and a torn tail is a process that was killed; only position tells the
 * second from an intact record, and NULs say the first outright wherever they sit (§4 of
 * scripts/check-write-audit.ts has held that for the all-NUL trailing line since #172).
 */
function readJournalLine(directory: string, line: string, lineNumber: number, isLastLine: boolean): AuditRecord | null {
  if (line.replace(/\0/g, "").trim().length === 0) {
    // A HOLE, not a parse failure. A power cut mid-append leaves the block allocated and the
    // write lost, so the line comes back as NUL bytes (docs/power-cuts.md). U+0000 is not JS
    // whitespace, so the trim above does not catch it. Nothing is recovered — these bytes are
    // not a record — and #164 stops NEW holes without repairing the file that already has one.
    warnOnceAbout(
      directory,
      lineNumber,
      line.length,
      "hole",
      `vcu-write: ${AUDIT_FILE} line ${lineNumber} is ${line.length} NUL bytes — a record lost to a power cut, not a parse error`
    );
    return null;
  }
  const holeBytes = leadingNulBytes(line);
  if (holeBytes > 0) {
    return readAfterHole(directory, line, lineNumber, holeBytes);
  }
  try {
    return JSON.parse(line) as AuditRecord;
  } catch (err) {
    // Only the last line can be a torn append. Anywhere else is a damaged file, and
    // quietly skipping it would lower the count of what was done to this bike.
    if (isLastLine) {
      console.log(`vcu-write: ${AUDIT_FILE} ends mid-record — something was killed while writing it`);
      return null;
    }
    warnOnceAbout(
      directory,
      lineNumber,
      line.length,
      "damaged",
      `vcu-write: ${AUDIT_FILE} line ${lineNumber} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

/**
 * A line whose leading NULs are followed by something. The hole ate the record that was there;
 * what comes after it is the NEXT record, which the lost newline glued onto this line.
 *
 * ⚠️ The tail is KEPT when it parses, and that is not optimism. A record truncated at the front
 * cannot parse — across this bike's whole journal, none of 28 933 possible front-truncations
 * parses to any JSON value, because no record carries a `{` after position 0 — so a tail that
 * parses is a tail whose hole ended on a record boundary. Skipping it would lower the count of
 * what was done to this bike, which is the one thing this file must not do: the 2026-09-09 line
 * 15 is an ECUReset of both micros. docs/power-cuts.md §2.
 */
function readAfterHole(directory: string, line: string, lineNumber: number, holeBytes: number): AuditRecord | null {
  const tail = line.slice(holeBytes);
  const recovered = recordFromSalvagedBytes(tail);
  if (recovered) {
    warnOnceAbout(
      directory,
      lineNumber,
      line.length,
      "hole-recovered",
      `vcu-write: ${AUDIT_FILE} line ${lineNumber} lost ${holeBytes} bytes to a power cut — the ${tail.length} bytes after the hole are a whole record and are kept`
    );
    return recovered;
  }
  warnOnceAbout(
    directory,
    lineNumber,
    line.length,
    "hole-torn",
    `vcu-write: ${AUDIT_FILE} line ${lineNumber} is ${holeBytes} NUL bytes then ${tail.length} bytes that are not a record — a power cut tore this one, not a parse error`
  );
  return null;
}

/** How many NUL bytes the line opens with. Only a CONTIGUOUS leading run counts — see the fence. */
function leadingNulBytes(line: string): number {
  const run = /^\0+/.exec(line);
  return run ? run[0].length : 0;
}

/**
 * Salvaged bytes as a record, or null.
 *
 * ⚠️ A stricter bar than an ordinary line gets: `at`, `action` and `status` are the three fields
 * every record has and the page renders, so a fragment that happens to parse without them is not
 * a record of anything.
 */
function recordFromSalvagedBytes(text: string): AuditRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not swallowed — the caller says which line it was and what it did with it. This function
    // only answers "are these bytes a record", and "no" is one of the two answers it exists for.
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const candidate = parsed as Partial<AuditRecord>;
  if (typeof candidate.at !== "number" || typeof candidate.action !== "string") {
    return null;
  }
  if (typeof candidate.status !== "string") {
    return null;
  }
  return candidate as AuditRecord;
}

/**
 * Says a line is damaged, once per process.
 *
 * ⚠️ The dashboard polls /vcu-write, so "per read" is dozens of times a minute — which is how a
 * torn record after a hole came to print a stack trace per request (#189). Keyed per file, line
 * and shape: this journal is only ever APPENDED to, so an existing line cannot change under the
 * key, and a different injury still gets its own line. A torn LAST line is deliberately not in
 * here: it is routine rather than damage, and the next append turns it into a mid-file line.
 */
function warnOnceAbout(
  directory: string,
  lineNumber: number,
  length: number,
  kind: JournalInjury,
  message: string
): void {
  const key = `${directory}|${lineNumber}|${length}|${kind}`;
  if (reportedDamage.has(key)) {
    return;
  }
  reportedDamage.add(key);
  console.warn(`${message} — said once per process`);
}
