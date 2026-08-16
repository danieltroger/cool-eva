import type { ServerResponse } from "http";
import { BACKUP_CSV_FILENAME, exportableRowCount, snapshotToBackupCsv } from "../vcu/backup-csv.ts";
import { loadLatestSnapshot } from "./vcu-params.ts";

// GET /vcu-backup.csv — the last parameter snapshot as `vcu_backup.csv`, the file
// another owner's energica_tool.py writes and reads. Byte-compatible on purpose:
// the format is that tool's, not ours, so a set of values can be sent to someone
// with a different bike and opened in the tool they already have. See
// src/vcu/backup-csv.ts for what "byte-compatible" was checked to mean.
//
// ⚠️ IT NEVER TOUCHES THE BUS. Same standing rule as /vcu-params and /stored-dtcs:
// it serves a file a previous sweep wrote. Downloading cannot make the
// bike answer anything. /vcu-read is where a fresh read is asked for.
//
// ⚠️ What the receiving tool can do with this file is a WRITE. energica_tool.py's
// "Restore backup..." reads exactly this shape and puts every row back into an ECU
// over `3B` WriteDataByLocalIdentifier. Nothing on this side can do that — the
// point of the standing read-only rule — but the file is one input to something
// that can, on someone else's bike, with different values. That is a reason the
// download is a deliberate act in service mode rather than a link on the riding
// screens, and a reason the filename says backup.

export async function handleVcuBackupEndpoint(res: ServerResponse, directory: string): Promise<void> {
  const latest = await loadLatestSnapshot(directory);

  if (latest.state === "never-read") {
    // 404 with the fix in it, rather than an empty CSV. A file containing only a
    // header would look like a bike whose every parameter is missing, and it would
    // be indistinguishable from a real export of a bike that answered nothing.
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`no parameter snapshot in ${latest.directory} yet — ${latest.hint}\n`);
    return;
  }
  if (latest.state === "unreadable") {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`the snapshot in ${latest.directory} could not be read: ${latest.reason}\n`);
    return;
  }
  if (exportableRowCount(latest.snapshot) === 0) {
    // A snapshot exists but the bike answered nothing in it — the "zero-read run"
    // the script is careful to keep distinct from a good one. Handing over a
    // header-only file would erase that distinction at the exact moment it matters.
    res.writeHead(409, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("the last snapshot holds no readable values — re-run the read with the bike awake\n");
    return;
  }

  // ASCII in practice (names are [A-Z0-9_]+, values are integers), so this is the
  // same byte sequence energica_tool.py writes. Declared as UTF-8 anyway because
  // that is what the bytes are, and a wrong charset header is the sort of thing
  // that turns into a mojibake bug report years later.
  const body = Buffer.from(snapshotToBackupCsv(latest.snapshot), "utf-8");
  res.writeHead(200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Length": String(body.length),
    // The name that tool's save dialog defaults to, so a swapped file arrives
    // looking like one of its own rather than needing to be explained.
    "Content-Disposition": `attachment; filename="${BACKUP_CSV_FILENAME}"`,
    "Cache-Control": "no-store",
  });
  res.end(body);
  console.log(`vcu-backup: served ${body.length} bytes as ${BACKUP_CSV_FILENAME}`);
}
