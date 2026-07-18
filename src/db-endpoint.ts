import { createReadStream } from "fs";
import { stat, unlink } from "fs/promises";
import { randomUUID } from "crypto";
import { pipeline } from "stream/promises";
import type { IncomingMessage, ServerResponse } from "http";
import { backupTo } from "./db.ts";

// Streaming the live DB file hands out torn copies: the logger checkpoints and
// grows the file mid-download, and whatever sits in the WAL is missing entirely.
// So take a consistent snapshot first (SQLite online backup) and stream that.
export async function handleDbEndpoint(req: IncomingMessage, res: ServerResponse, dbPath: string): Promise<void> {
  const snapshotPath = `${dbPath}.snapshot-${randomUUID()}`;

  try {
    await backupTo(snapshotPath);

    const snapshotStat = await stat(snapshotPath);
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": 'attachment; filename="temperatures.db"',
      "Content-Length": snapshotStat.size,
    });

    // pipeline destroys both sides if either fails (e.g. client disconnects),
    // so the finally below always gets to remove the snapshot file.
    await pipeline(createReadStream(snapshotPath), res);
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(`db snapshot failed: ${err}`);
    } else {
      res.destroy();
    }
  } finally {
    await unlink(snapshotPath).catch(() => {});
  }
}
