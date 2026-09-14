/** One parsed table. ⚠️ `header` cells are lower-cased; `selectTable`'s predicates rely on it. */
export interface MarkdownTable {
  header: string[];
  rows: string[][];
}

/**
 * Every markdown table in a document, fenced code blocks skipped.
 *
 * Split out of scripts/check-vehicle-state-labels.ts to keep one responsibility per file:
 * nothing here knows what a 0x101 state is. Cells are stripped of backticks and bold markers,
 * so `**60**` and `` `60` `` both read as 60 — a table that changes emphasis has not changed
 * meaning, and a check that goes red over a pair of asterisks trains people to stop reading it.
 * @param source the whole document
 */
export function markdownTables(source: string): MarkdownTable[] {
  const found: MarkdownTable[] = [];
  let fenced = false;
  let current: string[][] = [];
  // The trailing "" flushes a table that ends at end of file, so the flush is written once.
  for (const line of [...source.split("\n"), ""]) {
    if (line.trimStart().startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      continue;
    }
    if (line.trimStart().startsWith("|")) {
      current.push(cells(line));
      continue;
    }
    if (current.length > 0) {
      pushTable(found, current);
      current = [];
    }
  }
  return found;
}

/**
 * The one table whose HEADER says what it is.
 *
 * Zero matches and two matches are both failures, and that is the point: a selector that
 * silently matches nothing makes every assertion resting on it pass vacuously. Returns null
 * and appends to `failures` rather than throwing, so one run reports every problem it found.
 */
export function selectTable(
  tables: MarkdownTable[],
  matches: (header: string[]) => boolean,
  what: string,
  failures: string[]
): MarkdownTable | null {
  const hits = tables.filter(table => matches(table.header));
  if (hits.length !== 1) {
    failures.push(
      `${hits.length} tables match ${what}, expected exactly 1. Tables are selected by their HEADER ROW, so a ` +
        `renamed column takes the check down — restore the header, or update the selector`
    );
    return null;
  }
  return hits[0];
}

function pushTable(into: MarkdownTable[], lines: string[][]): void {
  // Header, `---` separator, rows. Anything shorter is a line that happens to start with a
  // pipe rather than a table.
  if (lines.length < 3 || !/^\|?\s*:?-{3,}/.test(lines[1][0] ?? "")) {
    return;
  }
  into.push({ header: lines[0].map(cell => cell.toLowerCase()), rows: lines.slice(2) });
}

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map(cell => cell.trim().replace(/`/g, "").replace(/\*\*/g, ""));
}
