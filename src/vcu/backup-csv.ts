import type { VcuParameterRow, VcuParameterSnapshot } from "./snapshot.ts";

// A snapshot rendered as `vcu_backup.csv` — the file another owner's energica_tool.py
// writes from its "Save backup..." button, byte for byte, so the two tools can exchange
// parameter sets. Pure: snapshot in, string out, which is what lets
// scripts/check-vcu-params.ts §9 compare our bytes against a golden fixture from that
// tool's own writer with no bike and no Python in the loop.
//
// The format is PROVEN rather than inferred — that tool's writer was executed and the
// bytes captured on 2026-08-15 — and it is Python's `excel` dialect:
//
//     id_hex,name,value\r\n
//     0x06,CHARGE_RESTART_HOLDOFF,20\r\n
//
// ⚠️ CRLF after EVERY row INCLUDING the last, unlike params.ecf. ASCII, no BOM,
// QUOTE_MINIMAL (which never fires for this table — see quoteField).
//
// `id_hex` is our `index` in uppercase hex, proven against that tool's 206-entry table
// with zero mismatches. It reads with a ONE-BYTE local id, so it cannot see the ten real
// parameters at 256…277 — MAX_DC_CHG_CURRENT among them — and we export those anyway,
// as three hex digits, because its restore path skips ids it does not know.
// docs/vcu-parameters.md §15.

/** What energica_tool.py's save dialog defaults to, so a swapped file arrives under the expected name. */
export const BACKUP_CSV_FILENAME = "vcu_backup.csv";

/** Header row, verbatim. Its column order is the format. */
const HEADER = ["id_hex", "name", "value"];

const LINE_TERMINATOR = "\r\n";

/**
 * Renders a snapshot as energica_tool.py's backup CSV.
 *
 * ⚠️ Only rows that carry a typed value are written — that tool's `pid in PARAMS and
 * self._param_cur[pid] is not None` in our vocabulary. A failure reason in a numeric column
 * would produce a file whose restore path (`int(row["value"])`) throws, or worse, doesn't;
 * an unnamed identifier has no place in a two-column-of-meaning file even though its raw
 * bytes are real and are still in the snapshot. The three exclusions one at a time:
 * docs/vcu-parameters.md §15.
 *
 * Ascending by index, which is that tool's `sorted(self._param_cur)`. Already sorted by
 * whatever wrote the snapshot; sorted again so the output does not depend on that.
 */
export function snapshotToBackupCsv(snapshot: VcuParameterSnapshot): string {
  const rows = snapshot.rows
    .filter(isExportable)
    .sort((left, right) => left.index - right.index)
    .map(row => [formatIdentifier(row.index), row.name ?? "", String(row.value)]);
  return [HEADER, ...rows].map(columns => `${columns.map(quoteField).join(",")}${LINE_TERMINATOR}`).join("");
}

/** How many rows an export would carry — so a caller can say "0 parameters" before offering a download of nothing. */
export function exportableRowCount(snapshot: VcuParameterSnapshot): number {
  return snapshot.rows.filter(isExportable).length;
}

function isExportable(row: VcuParameterRow): boolean {
  return row.status === "read" && row.value !== null && row.name !== null;
}

/**
 * `0x{index:02X}` — uppercase, padded to at least two digits, NOT truncated to two.
 * Index 258 is `0x102`, which is exactly what Python's `f"0x{pid:02X}"` produces
 * for a number that wide; the `02` is a minimum, not a width.
 */
function formatIdentifier(index: number): string {
  return `0x${index.toString(16).toUpperCase().padStart(2, "0")}`;
}

/**
 * Python's QUOTE_MINIMAL: quote only when the field contains the delimiter, the
 * quote character, or a newline; double the quote character inside.
 *
 * It never fires here — parameter names out of params.ecf are `[A-Z0-9_]+` and the
 * values are integers — and it is implemented anyway rather than skipped, because
 * the alternative is a function that silently produces a corrupt file the first
 * time a future table contains a comma. Cheap insurance on a format whose whole
 * point is that someone else's tool can read it.
 */
function quoteField(field: string): string {
  if (!/[",\r\n]/.test(field)) {
    return field;
  }
  return `"${field.replace(/"/g, '""')}"`;
}
