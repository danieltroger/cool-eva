import Database from "better-sqlite3";
import { writeFileSync } from "fs";

// Pull every DC charging session out of the decoded archive into one compact fixture, so the
// check can replay them in CI with no database present. Scratch tooling: it reads the evidence
// DBs read-only and writes a .ts fixture; it is not part of the app.

const DATABASES = process.argv.slice(2, -1);
const OUTPUT = process.argv[process.argv.length - 1];
/**
 * DC charging when the pack is taking more than this.
 *
 * ⚠️ 25 A, not 5: delimited on `pack_a` because `fast_dc_target_a` gaps hide whole sessions, but
 * the bike's AC charger tops out around 8-10 A at the pack, so a 5 A threshold pulls in every AC
 * charge and every long park. Nothing in the archive charges DC below 19.5 A (the derate), so 25
 * separates the two cleanly.
 */
const CHARGING_A = 25;
const GAP_MS = 10 * 60_000;
const MIN_MINUTES = 4;
/** The archive holds rows dated past 2027 from a Pi with no RTC. */
const TS_MIN = Date.parse("2026-08-01T00:00:00Z");
const TS_MAX = Date.parse("2026-09-19T00:00:00Z");

interface Row {
  ts: number;
  value: number;
}
interface Session {
  name: string;
  fromMs: number;
  toMs: number;
  temperature: Row[];
  requested: Row[];
  coolantIn: Row[];
  soc: Row[];
  ceiling: Row[];
}

/**
 * At most one row per `everyMs`, plus the last.
 *
 * ⚠️ Time only, never "and when the value changed": `coolant_in` has a 0.05 K deadband and changes
 * on nearly every sample, so a value-aware thinner kept 4 256 rows of one session and made the
 * fixture a megabyte. These are slow signals and the plant integrates them.
 */
function thin(rows: Row[], everyMs: number): Row[] {
  const kept: Row[] = [];
  for (const row of rows) {
    const newest = kept.at(-1);
    if (newest === undefined || row.ts - newest.ts >= everyMs) {
      kept.push(row);
    }
  }
  const final = rows.at(-1);
  if (final !== undefined && kept.at(-1) !== final) {
    kept.push(final);
  }
  return kept;
}

/** `"<ms>:<value> …"`, times relative to the session start, values to `places` decimals. */
function pack(rows: Row[], fromMs: number, places: number): string {
  return rows.map(row => `${row.ts - fromMs}:${row.value.toFixed(places)}`).join(" ");
}

const sessions: Session[] = [];
for (const path of DATABASES) {
  const db = new Database(path, { readonly: true });
  const ids = new Map(
    (db.prepare("select id, key from signal").all() as { id: number; key: string }[]).map(r => [r.key, r.id])
  );
  const read = (key: string, from = TS_MIN, to = TS_MAX): Row[] => {
    const id = ids.get(key);
    if (id === undefined) {
      return [];
    }
    return db
      .prepare("select distinct ts, value from reading where signal_id = ? and ts between ? and ? order by ts")
      .all(id, from, to) as Row[];
  };
  const packA = read("pack_a");
  const label = path.replace(/^.*\//, "").replace(/\.db$/, "");
  // Split the charging rows on gaps.
  let start: number | null = null,
    last = 0;
  const spans: { from: number; to: number }[] = [];
  for (const row of packA) {
    if (row.value <= CHARGING_A) {
      continue;
    }
    if (start === null || row.ts - last > GAP_MS) {
      if (start !== null && last - start >= MIN_MINUTES * 60_000) {
        spans.push({ from: start, to: last });
      }
      start = row.ts;
    }
    last = row.ts;
  }
  if (start !== null && last - start >= MIN_MINUTES * 60_000) {
    spans.push({ from: start, to: last });
  }
  for (const wholeSpan of spans) {
    // A DC session is one the vehicle asked the station for. Without a request row this is a fast
    // AC charge or a decode gap, and it cannot be replayed against a rule that commands a ceiling.
    const requestedWhole = read("fast_dc_target_a", wholeSpan.from, wholeSpan.to);
    if (requestedWhole.length === 0) {
      continue;
    }
    // ⚠️ THE SESSION STARTS WHERE THE REQUEST DOES, not where the current does. 13 of 18 sessions
    // have a prefix with `pack_a` logged and no `fast_dc_target_a` at all — a genuine decode gap,
    // 100 minutes of one 258-minute session — and a replay across it has to substitute the station
    // ceiling for what the vehicle was asking. That inflates the do-nothing baseline, which
    // flatters any rule compared against it. Cut it instead, and read every other signal against
    // the CUT span so nothing lands at a negative offset.
    const span = { from: Math.max(wholeSpan.from, requestedWhole[0].ts), to: wholeSpan.to };
    if (span.to - span.from < MIN_MINUTES * 60_000) {
      continue;
    }
    // ⚠️ NO PRE-ROLL on the temperature: `forgetSession` empties the ring at a session edge, so
    // the rule starts a charge blind and answers NO_HISTORY for its first five minutes. Handing
    // the replay an anchor from before the session would be a ring the bike cannot produce.
    // `coolant_in` keeps one, because it is the PLANT's input and a zero-order hold needs a value
    // at t = 0.
    const temperature = read("batt_temp_hi", span.from, span.to);
    if (temperature.length < 3) {
      continue;
    }
    const requested = requestedWhole.filter(row => row.ts >= span.from);
    sessions.push({
      name: `${label}@${new Date(span.from).toLocaleString("sv-SE", { timeZone: "Europe/Stockholm" }).slice(5, 16)}`,
      fromMs: span.from,
      toMs: span.to,
      temperature,
      requested: thin(requested, 15_000),
      coolantIn: thin(read("coolant_in", span.from - 600_000, span.to), 120_000),
      soc: read("soc", span.from, span.to),
      ceiling: read("fast_dc_limit_max_a", span.from - 3_600_000, span.to),
    });
  }
  db.close();
}
sessions.sort((a, b) => a.fromMs - b.fromMs);
console.log(`${sessions.length} sessions`);
for (const session of sessions) {
  const minutes = (session.toMs - session.fromMs) / 60_000;
  const temps = session.temperature.map(row => row.value);
  console.log(
    `  ${session.name}  ${minutes.toFixed(0).padStart(3)} min  temps ${Math.min(...temps)}-${Math.max(...temps)} ` +
      `(${session.temperature.length} rows)  coolant ${session.coolantIn.length}  soc ${session.soc.length}  ` +
      `ceiling ${session.ceiling.at(-1)?.value ?? "—"}`
  );
}
const header = `// GENERATED by scripts/extract-archive-sessions.ts from the decoded archive — DO NOT EDIT.
//
// Every DC charging session on record: 2026-09-07 to 2026-09-18, delimited on \`pack_a\` > 25 A with
// gaps over ten minutes, each one carrying the rings the controller would have seen. The decoded
// databases are gitignored evidence in another worktree and CI has none of them, so the data is
// baked here the way scripts/charge-auto-episode.ts bakes its three episodes — this is the same
// idea over the whole archive rather than three hand-picked stops.
//
// ⚠️ Regenerating this needs databases that are NOT in the repo and will not outlive the track
// that made them: \`archive-to-2026-09-15.db\` (rides.db decoded, 2026-08-02…09-15),
// \`day-2026-09-16.db\`, \`day-2026-09-17.db\` and \`today-2026-09-18.db\`, all decoded by the
// charge-thermal track from \`.celog\` ride logs. Each session below carries the database name and
// its own CEST start time, so a row here can still be traced to a log even when the decode is gone.
//
// ⚠️ Thinned by TIME ONLY, and only where thinning cannot change a decision: \`batt_temp_hi\` and
// \`soc\` are whole-number log-on-change signals and are kept ENTIRE; \`coolant_in\` (a 0.05 K
// deadband, ~6 rows/min) keeps at most one row per two minutes and \`fast_dc_target_a\` one per
// fifteen seconds, in both cases plus the last. A value-aware thinner kept 4 256 rows of one
// session, because the deadband means the coolant changes on nearly every sample. \`pack_a\` is
// dropped: the replay computes the current itself. Times are CEST, matching post-55.txt.

import type { ArchiveSession } from "./archive-session.ts";

export const ARCHIVE_SESSIONS: ArchiveSession[] = `;
const asFixture = sessions.map(session => ({
  name: session.name,
  spanMs: session.toMs - session.fromMs,
  temperature: pack(session.temperature, session.fromMs, 0),
  soc: pack(session.soc, session.fromMs, 0),
  requested: pack(session.requested, session.fromMs, 0),
  coolantIn: pack(session.coolantIn, session.fromMs, 2),
  ceilingAmps: session.ceiling.at(-1)?.value ?? 75,
}));
writeFileSync(OUTPUT, header + JSON.stringify(asFixture, null, 0) + ";\n");
console.log(`wrote ${OUTPUT}`);
