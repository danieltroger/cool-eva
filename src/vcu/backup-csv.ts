import type { VcuParameterRow, VcuParameterSnapshot } from "./snapshot.ts";

// A snapshot rendered as `vcu_backup.csv` — the file another owner's
// energica_tool.py writes from its "Save backup..." button, byte for byte, so the
// two tools can exchange parameter sets.
//
// Pure: snapshot in, string out. No I/O, no clock. Which is what lets
// scripts/check-vcu-params.ts §9 compare our bytes against a golden fixture taken
// from that tool's own writer, with no bike and no Python in the loop.
//
// ── Provenance of the format (established 2026-08-15) ────────────────────────
// energica_tool.py is a reverse-engineered Energica VCU tool by another owner,
// built from the decompiled NRJK7 app. Its `_params_save_backup` is six lines:
//
//     with open(path, "w", newline="") as fh:
//         w = csv.writer(fh)
//         w.writerow(["id_hex", "name", "value"])
//         for pid in sorted(self._param_cur):
//             if pid in PARAMS and self._param_cur[pid] is not None:
//                 w.writerow([f"0x{pid:02X}", PARAMS[pid][0], self._param_cur[pid]])
//
// PROVEN, not inferred: that code was executed against its own PARAMS table on
// 2026-08-15 and the bytes captured. Python's default `csv` dialect is `excel`,
// so the shape below is not a guess about what "CSV" means here —
//
//     id_hex,name,value\r\n
//     0x06,CHARGE_RESTART_HOLDOFF,20\r\n
//     0x0F,MODEL,358\r\n
//
//   • comma delimiter, no spaces around it;
//   • CRLF after EVERY row INCLUDING the last (csv.writer terminates each row, so
//     the file ends with a newline — unlike params.ecf, which does not);
//   • QUOTE_MINIMAL with `"`, which never fires for this table (see quoteField);
//   • ASCII throughout, and `newline=""` means Python does no translation, so the
//     bytes are the same on every platform. No BOM.
//
// ── Why `id_hex` is our `index` in hex ───────────────────────────────────────
// PROVEN 2026-08-15 by comparing that tool's 206-entry PARAMS table against
// params.ecf line by line: for every one of the 206, the dict key equals the
// file's decimal index, and the name, width, S/U column, µC column and [SECTION]
// all match with ZERO mismatches. So `0x{pid:02X}` is `0x` + this table's index in
// uppercase hex. It is the same number our identifier carries in its low 12 bits.
//
// That tool reads parameters with `21` ReadDataByLocalIdentifier and a ONE-BYTE
// local id, which is why its table stops at 0xFF and why it cannot see the ten
// real parameters at indices 256…277 — MAX_AC_CHG_CURRENT, MAX_DC_CHG_CURRENT,
// MAX_C_TEMP, CHARGER_TYPE and the EEPROM/TABLE version pairs among them. We read
// with `22` and a 16-bit identifier, so we do see them, and they are exported:
// `0x102` is simply three hex digits where the rest are two. Its restore path
// (`_params_restore_backup`) does `int(row["id_hex"], 16)` and skips any id not in
// PARAMS, so the extra rows are ignored by that tool rather than misread — and
// dropping this bike's actual DC charge-current limit from its own backup to look
// more like a tool that cannot reach it would be the wrong trade.

/** What energica_tool.py's save dialog defaults to, so a swapped file arrives under the expected name. */
export const BACKUP_CSV_FILENAME = "vcu_backup.csv";

/** Header row, verbatim. Its column order is the format. */
const HEADER = ["id_hex", "name", "value"];

const LINE_TERMINATOR = "\r\n";

/**
 * Renders a snapshot as energica_tool.py's backup CSV.
 *
 * Only rows that carry a typed value are written, which is that tool's
 * `pid in PARAMS and self._param_cur[pid] is not None` in our vocabulary:
 *
 *   • `status !== "read"` — the bike never answered, so there is no value to back
 *     up. Writing the failure reason into a numeric column would produce a file
 *     whose restore path (`int(row["value"])`) throws, or worse, doesn't.
 *   • `value === null` — the name table has no honest opinion (an identifier it
 *     does not describe, or a record whose width contradicts the TYPE column).
 *     The raw bytes are still real and are still in the snapshot and on
 *     /params.html; they just have no place in a two-column-of-meaning file.
 *   • `name === null` — nothing to put in the `name` column. Implied by the above
 *     (an unnamed identifier cannot have a typed value) and checked anyway,
 *     because a silently empty name field would look like a real parameter called
 *     "".
 *
 * Ascending by index, which is that tool's `sorted(self._param_cur)`. The rows are
 * already sorted by the script that wrote the snapshot; sorted again here so the
 * output does not depend on that staying true.
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
