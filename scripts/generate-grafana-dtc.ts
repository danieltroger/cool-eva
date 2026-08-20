import { readFile, writeFile } from "fs/promises";
import { DTC_TABLE, dtcSignalKey, type DtcTableEntry } from "../src/diagnostics/dtc-table.ts";

// Rewrites the fault-code lookup embedded in grafana/dashboards/trouble-codes.json
// from DTC_TABLE, so that only one copy of the table is ever hand-maintained.
//
//   node --experimental-strip-types scripts/generate-grafana-dtc.ts           # rewrite the JSON
//   node --experimental-strip-types scripts/generate-grafana-dtc.ts --check   # fail if it is stale
//
// WHY THE COPY EXISTS AT ALL — Grafana reads the ride log and nothing else, and the
// code table is not in it: `reading` holds `dtc_0044_0 = 1`, not "water pump open
// circuit". Without a second datasource that copy cannot be deleted, so this makes it
// derived instead. src/http/dtc-table.ts refuses the same duplication for the phone.
//
// ⚠️ IT HAD TO BE GENERATED BECAUSE IT DRIFTED, in the direction nobody notices: for a
// day Grafana and the phone dashboard named THIS BIKE'S OWN FAULT `dtc_0044_0`
// differently — a seized pump on one screen, an unwired one on the other, on the fault
// the cooling work turns on. A wrong name still looks like an answer, which is why it
// survived being stared at. docs/diagnostics-and-checks.md §11.4.
//
// HOW — the rewrite is textual, splicing only the bytes between the CTE header and its
// closing paren, so no other byte of the dashboard can move: panel ids, field order,
// transformations and the \uXXXX escaping all survive untouched.
// assertOnlyValuesListsChanged() proves that rather than trusting it.

/** Repo-relative, for messages; the URL beside it is what is actually read. */
const DASHBOARD_PATH = "grafana/dashboards/trouble-codes.json";
const dashboardUrl = new URL(`../${DASHBOARD_PATH}`, import.meta.url);

// The CTE header the generated rows belong to, matched whole. Keying off a bare
// "VALUES" would let this script rewrite some future unrelated inline table.
const VALUES_HEADER = "WITH code(key, obd, name, descr, mil) AS (\n  VALUES ";
const VALUES_TERMINATOR = "\n)\n";
/** Continuation rows line up under the first, which starts after "  VALUES ". */
const ROW_INDENT = " ".repeat("  VALUES ".length);

// Both fields, always together. `rawQueryText` is the one that runs — the plugin
// derives `queryText` from it at query time, so a `queryText` in the file is
// overwritten and never executes (grafana/README.md). It is written out anyway so
// the file does not lie about what runs, which only holds if the two stay equal,
// so this rewrites whichever of them carries the table.
const QUERY_FIELDS = ["rawQueryText", "queryText"] as const;

// Matched under any alias, because VALUES_HEADER pins the CTE's name and columns
// but not what a SELECT chooses to call it: `LEFT JOIN code AS t` reads `t.mil`.
// The second is deliberately just the predicate rather than "a CASE arm beginning
// with it" — today's arm is `WHEN c.key IS NULL OR c.mil IS NULL`, and pinning the
// shape of the expression would fail on the very query it is meant to approve.
const READS_MIL = /\b\w+\.mil\b/;
const TESTS_MIL_FOR_NULL = /\b[\w.]*\bmil\s+IS\s+NULL\b/i;

/**
 * Prose elsewhere that states how many codes the table holds. None of it can be
 * derived — every one sits inside a comment explaining why something nearby is
 * generated — so checking it is the only thing between the next correction and
 * another stale number. That is exactly what went wrong here: three files still
 * said 148 once the table had grown to 154.
 *
 * A reworded sentence fails with "nothing matched". Fix the pattern rather than
 * dropping the entry, or that file goes back to drifting unwatched.
 */
const COUNT_MENTIONS: { path: string; pattern: RegExp }[] = [
  { path: "README.md", pattern: /`src\/diagnostics\/dtc-table\.ts`, (\d+) codes/ },
  { path: "grafana/README.md", pattern: /which of the (\d+) appear is a runtime fact/ },
  { path: "public/lib/bounds.js", pattern: /the (\d+) generated `dtc_\*`/ },
  { path: "src/can/registry.ts", pattern: /the cell signals are: (\d+)/ },
  { path: "src/http/dtc-table.ts", pattern: /duplicate of (\d+) transcribed codes/ },
];

/** Only the parts of the dashboard JSON this script looks at. */
interface DashboardPanel {
  panels?: DashboardPanel[];
  targets?: Record<string, unknown>[];
}

const checkOnly = process.argv.includes("--check");
const failures: string[] = [];

const originalJson = await readFile(dashboardUrl, "utf8");
assertOneRowPerCode(DTC_TABLE);
const valuesList = renderValuesList(DTC_TABLE);
const originalQueries = codeTableQueries(originalJson);
// Checked whether or not anything is stale: the arm can be deleted from the SQL
// long after the rows that need it were generated, and that would be silent.
assertMilNullIsHandled(originalQueries, DTC_TABLE);
failures.push(...divergedQueryFields(originalJson));
const staleQueries = originalQueries.filter(sql => replaceValuesList(sql, valuesList) !== sql);

if (staleQueries.length === 0) {
  console.log(`✓ ${DASHBOARD_PATH} already matches DTC_TABLE (${DTC_TABLE.length} codes)`);
} else {
  const regeneratedJson = spliceValuesLists(originalJson, valuesList);
  assertOnlyValuesListsChanged(originalJson, regeneratedJson, valuesList);
  const differences = describeRowDifferences(staleQueries, valuesList);
  if (checkOnly) {
    failures.push(
      `${DASHBOARD_PATH} is out of date with src/diagnostics/dtc-table.ts — run \`npm run generate:grafana-dtc\`\n` +
        differences.map(line => `      ${line}`).join("\n")
    );
  } else {
    await writeFile(dashboardUrl, regeneratedJson);
    console.log(`rewrote ${DASHBOARD_PATH} from DTC_TABLE (${DTC_TABLE.length} codes):`);
    for (const line of differences) {
      console.log(`  ${line}`);
    }
  }
}

failures.push(...(await staleCountMentions(DTC_TABLE.length)));

if (failures.length > 0) {
  console.error("FAILED:");
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  // Not process.exit(): Node's stdio is asynchronous whenever it is a pipe, which
  // it always is under Actions, and exit() does not drain what is still queued.
  // The point of describeRowDifferences() is that a red check names the rows that
  // moved, so a truncated flush would lose precisely the part worth printing.
  process.exitCode = 1;
} else {
  console.log("✓ every prose mention of how many codes there are agrees with the table");
}

/** One `('key', 'obd', 'name', 'description', mil)` row per code, in table order. */
function renderValuesList(entries: DtcTableEntry[]): string {
  return entries
    .map(entry =>
      [
        sqlString(dtcSignalKey(entry.component, entry.symptom)),
        sqlString(entry.obdCode),
        sqlString(entry.name),
        sqlString(entry.description),
        sqlMil(entry.illuminatesMil),
      ].join(", ")
    )
    .map(columns => `(${columns})`)
    .join(`,\n${ROW_INDENT}`);
}

/** SQLite string literal: the only escape it has is a doubled quote. */
function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** NULL, not 0, when no source states whether the code lights the lamp. */
function sqlMil(illuminatesMil: boolean | null): string {
  if (illuminatesMil === null) {
    return "NULL";
  }
  return illuminatesMil ? "1" : "0";
}

/** Every distinct query in the dashboard that embeds the code table. */
function codeTableQueries(dashboardJson: string): string[] {
  const dashboard = JSON.parse(dashboardJson) as { panels?: DashboardPanel[] };
  const found = new Set<string>();
  for (const target of collectTargets(dashboard.panels ?? [])) {
    for (const field of QUERY_FIELDS) {
      const sql = target[field];
      if (typeof sql === "string" && sql.includes(VALUES_HEADER)) {
        found.add(sql);
      }
    }
  }
  if (found.size === 0) {
    throw new Error(
      `${DASHBOARD_PATH}: no panel carries the code-table CTE any more. If the dashboard was rebuilt, point ` +
        `VALUES_HEADER in this script at its new shape — do not leave the table hand-maintained.`
    );
  }
  return [...found];
}

/** Every target in the dashboard; rows can nest panels inside themselves. */
function collectTargets(panels: DashboardPanel[], found: Record<string, unknown>[] = []): Record<string, unknown>[] {
  for (const panel of panels) {
    for (const target of panel.targets ?? []) {
      found.push(target);
    }
    if (panel.panels) {
      collectTargets(panel.panels, found);
    }
  }
  return found;
}

/** `sql` with its `VALUES` list swapped for `valuesList`, everything else as it was. */
function replaceValuesList(sql: string, valuesList: string): string {
  const listStart = sql.indexOf(VALUES_HEADER) + VALUES_HEADER.length;
  return sql.slice(0, listStart) + valuesList + sql.slice(listStart + valuesListOf(sql).length);
}

/**
 * The same swap done on the file's text rather than on parsed strings, so that
 * nothing else is re-serialised. Both markers are plain ASCII, so their encoded
 * forms are unambiguous, and a row can never contain the terminator: every line
 * inside the list begins with spaces, never with `)`.
 *
 * This rewrites EVERY occurrence in the file, not only the ones staleness is
 * detected through — a copy of the table that had ended up somewhere other than a
 * query field would still be a copy, and would still be wrong.
 */
function spliceValuesLists(dashboardJson: string, valuesList: string): string {
  const header = encodeJsonStringBody(VALUES_HEADER);
  const terminator = encodeJsonStringBody(VALUES_TERMINATOR);
  const encodedList = encodeJsonStringBody(valuesList);

  let output = "";
  let cursor = 0;
  for (;;) {
    const headerAt = dashboardJson.indexOf(header, cursor);
    if (headerAt === -1) {
      return output + dashboardJson.slice(cursor);
    }
    const listStart = headerAt + header.length;
    const listEnd = dashboardJson.indexOf(terminator, listStart);
    if (listEnd === -1) {
      throw new Error(`${DASHBOARD_PATH}: a code-table CTE in the file text is never closed`);
    }
    output += dashboardJson.slice(cursor, listStart) + encodedList;
    cursor = listEnd;
  }
}

/**
 * A JSON string's body, escaped the way this dashboard already is: ASCII only,
 * non-ASCII as \uXXXX. Prettier accepts either form, so the point is not
 * correctness but diff size — matching the file's existing convention keeps the
 * change to the rows that actually moved.
 */
function encodeJsonStringBody(value: string): string {
  const encoded = JSON.stringify(value).slice(1, -1);
  // No `u` flag on purpose: it would match an astral character as one two-unit
  // string, and charCodeAt(0) would then emit its high surrogate and silently drop
  // the low one. Matching code units instead gives the surrogate pair the two
  // \uXXXX escapes JSON wants. Nothing in the table needs it today; a name
  // arriving with an emoji in it should not be the thing that finds this out.
  return encoded.replaceAll(/[^\x20-\x7e]/g, codeUnit => {
    return `\\u${codeUnit.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}

/**
 * Codes with an unknown MIL render as SQL NULL, and `c.mil = 1` is NULL rather than
 * false, so a CASE with no explicit NULL arm falls through to its ELSE and prints a
 * confident "no" — the exact claim DtcTableEntry.illuminatesMil carries `null` to
 * withhold, and which public/views/faults.js prints as "unknown". Refuse to
 * generate into a query that would do that.
 */
function assertMilNullIsHandled(queries: string[], entries: DtcTableEntry[]): void {
  if (!entries.some(entry => entry.illuminatesMil === null)) {
    return;
  }
  for (const sql of queries) {
    // Comments are stripped first, and the column is matched under any alias. A
    // guard that a reworded comment can satisfy, or that a `LEFT JOIN code AS t`
    // can walk straight past, would be load-bearing and not tamper-evident — the
    // same shape of problem this whole script exists to end.
    const statement = stripSqlComments(sql);
    if (READS_MIL.test(statement) && !TESTS_MIL_FOR_NULL.test(statement)) {
      throw new Error(
        `${DASHBOARD_PATH}: a panel reads the mil column with no "WHEN … mil IS NULL" arm, so the codes whose ` +
          `lamp behaviour no source states would be rendered as "no". Give that CASE an unknown arm first.`
      );
    }
  }
}

/**
 * SQL with its `-- …` comments removed, so that what a comment happens to say can
 * neither satisfy nor defeat a test. Quote state is tracked because a `--` inside a
 * string literal is data, not a comment; SQLite's only escape is a doubled quote,
 * which closes and immediately reopens the literal and so needs no special case.
 */
function stripSqlComments(sql: string): string {
  let output = "";
  let insideLiteral = false;
  for (let index = 0; index < sql.length; index++) {
    const character = sql[index];
    if (character === "'") {
      insideLiteral = !insideLiteral;
    } else if (!insideLiteral && character === "-" && sql[index + 1] === "-") {
      while (index < sql.length && sql[index] !== "\n") {
        index++;
      }
      output += "\n";
      continue;
    }
    output += character;
  }
  return output;
}

/**
 * (component, symptom) is the table's primary key, but nothing enforces it: the
 * lookup map in dtc-table.ts and the object in http/dtc-table.ts both absorb a
 * duplicate last-wins. Here it would survive as two `VALUES` rows with the same
 * key, and panel 21 joins before it aggregates — so "Times set" for a duplicated
 * code doubles, and panel 11 draws the series twice. Both look like data.
 */
function assertOneRowPerCode(entries: DtcTableEntry[]): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = dtcSignalKey(entry.component, entry.symptom);
    if (seen.has(key)) {
      throw new Error(`DTC_TABLE has two entries for ${key}; (component, symptom) is its primary key`);
    }
    seen.add(key);
  }
}

/**
 * `rawQueryText` is what runs and `queryText` is written out only so the file does
 * not lie about it, which holds only while they are equal. Nothing else checks
 * that, and a `queryText` that drifted OUTSIDE the code table — a changed COALESCE,
 * a dropped HAVING — would pass every other test here. They are equal in all four
 * targets today, so it is cheap to pin while it is still true.
 */
function divergedQueryFields(dashboardJson: string): string[] {
  const dashboard = JSON.parse(dashboardJson) as { panels?: DashboardPanel[] };
  const [runsField, mirrorField] = QUERY_FIELDS;
  const diverged: string[] = [];
  for (const target of collectTargets(dashboard.panels ?? [])) {
    const runs = target[runsField];
    const mirror = target[mirrorField];
    if (typeof runs === "string" && typeof mirror === "string" && runs !== mirror) {
      diverged.push(
        `${DASHBOARD_PATH}: target ${String(target.refId ?? "?")} has a ${mirrorField} that differs from its ` +
          `${runsField}, so the file no longer says what actually runs`
      );
    }
  }
  return diverged;
}

/**
 * Refuses to hand back a file that changed anywhere but inside a code table, and
 * confirms the encoder round-tripped. The panels' queries, transformations,
 * overrides and ids are hand-tuned against a Grafana that is fussy about all four
 * (grafana/README.md), so a generator able to quietly reshape them would be worse
 * than the drift it replaces.
 */
function assertOnlyValuesListsChanged(before: string, after: string, valuesList: string): void {
  if (blankCodeTables(before) !== blankCodeTables(after)) {
    throw new Error(`${DASHBOARD_PATH}: the rewrite changed something outside a VALUES list — refusing to write`);
  }
  for (const sql of codeTableQueries(after)) {
    if (replaceValuesList(sql, valuesList) !== sql) {
      throw new Error(`${DASHBOARD_PATH}: a rewritten query did not decode back to the rows it was given`);
    }
  }
}

/** The dashboard re-serialised with every code table replaced by a marker. */
function blankCodeTables(dashboardJson: string): string {
  const dashboard: unknown = JSON.parse(dashboardJson);
  return JSON.stringify(dashboard, (_key, value: unknown) => {
    if (typeof value === "string" && value.includes(VALUES_HEADER)) {
      return replaceValuesList(value, "<code table>");
    }
    return value;
  });
}

/** The `VALUES` list inside a query, without its header or the CTE's closing paren. */
function valuesListOf(sql: string): string {
  const listStart = sql.indexOf(VALUES_HEADER) + VALUES_HEADER.length;
  const listEnd = sql.indexOf(VALUES_TERMINATOR, listStart);
  if (listEnd === -1) {
    throw new Error(`${DASHBOARD_PATH}: a code-table CTE has no closing ")" on a line of its own`);
  }
  return sql.slice(listStart, listEnd);
}

/** `dtc_0044_0` → its whole row, for reporting what moved. */
function rowsByKey(valuesList: string): Map<string, string> {
  const rows = new Map<string, string>();
  // A row never contains a newline — every SQL literal here is single-line — so
  // splitting on the row separator cannot cut one in half.
  for (const line of valuesList.split(",\n")) {
    const row = line.trim();
    const key = /^\('(dtc_\d+_\d+)'/.exec(row)?.[1];
    if (key) {
      rows.set(key, row);
    }
  }
  return rows;
}

/**
 * What `valuesList` changes about each stale query, pooled and de-duplicated —
 * the copies normally hold the same rows and go stale together, but they are
 * separate strings and one can be edited alone, so each is compared on its own
 * rather than merged first.
 */
function describeRowDifferences(staleQueries: string[], valuesList: string): string[] {
  const newRows = rowsByKey(valuesList);
  const differences = new Set<string>();
  for (const sql of staleQueries) {
    const oldRows = rowsByKey(valuesListOf(sql));
    for (const [key, row] of newRows) {
      const previous = oldRows.get(key);
      if (previous === undefined) {
        differences.add(`+ ${row}`);
      } else if (previous !== row) {
        differences.add(`~ ${previous}\n      → ${row}`);
      }
    }
    for (const [key, row] of oldRows) {
      if (!newRows.has(key)) {
        differences.add(`- ${row}`);
      }
    }
  }
  if (differences.size === 0) {
    // Same rows, different order: worth saying, because "out of date" with an
    // empty explanation reads as a bug in this script.
    return ["(the same rows in a different order)"];
  }
  return [...differences];
}

async function staleCountMentions(expected: number): Promise<string[]> {
  const stale: string[] = [];
  for (const { path, pattern } of COUNT_MENTIONS) {
    // A rename is the likeliest way one of these goes stale, so it gets the same
    // "fix the entry" nudge as a reworded sentence rather than an ENOENT stack
    // trace from an unhandled rejection.
    const text = await readFile(new URL(`../${path}`, import.meta.url), "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        stale.push(`${path}: cannot be read (${error.code ?? error.message}) — renamed? Update COUNT_MENTIONS.`);
        return null;
      }
    );
    if (text === null) {
      continue;
    }
    const found = pattern.exec(text);
    if (!found) {
      stale.push(`${path}: nothing matched ${pattern} — reword the pattern in scripts/generate-grafana-dtc.ts`);
    } else if (Number(found[1]) !== expected) {
      stale.push(`${path}: says ${found[1]} codes, DTC_TABLE holds ${expected}`);
    }
  }
  return stale;
}
