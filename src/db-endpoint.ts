import { createReadStream } from "fs";
import { stat } from "fs/promises";
import { createGzip } from "zlib";
import { pipeline } from "stream/promises";
import type { IncomingMessage, ServerResponse } from "http";
import { pinDbFileForStreaming, unpinDbFile } from "./db.ts";

// Stream the live SQLite file for download.
//
// In WAL mode the main DB file only changes on a checkpoint, so pinDbFileForStreaming()
// folds the WAL in once and then freezes the file for the duration — a consistent
// snapshot without copying the whole ~0.5 GB DB up front. So headers and the first bytes
// go out immediately: no multi-minute silent "backup" before the response starts (which
// was making phone browsers time out before the download even began). Logging keeps
// running — new samples accumulate in the WAL until we unpin.
//
// Compression is content-negotiated: browsers send `Accept-Encoding: gzip` and get a
// gzipped stream they transparently inflate back to temperatures.db (~4× less to push
// over the phone hotspot); wget/curl (which don't ask for gzip by default) get the raw
// file with a Content-Length so they can show a progress bar.
export async function handleDbEndpoint(req: IncomingMessage, res: ServerResponse, dbPath: string): Promise<void> {
  pinDbFileForStreaming();
  try {
    const { size } = await stat(dbPath); // also confirms the file exists → clean 500 if not
    const acceptsGzip = /\bgzip\b/.test(req.headers["accept-encoding"] ?? "");

    const headers: Record<string, string> = {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": 'attachment; filename="temperatures.db"',
      Vary: "Accept-Encoding",
    };
    if (acceptsGzip) {
      headers["Content-Encoding"] = "gzip"; // length is unknown after gzip ⇒ chunked
    } else {
      headers["Content-Length"] = String(size); // raw file: give CLIs a progress total
    }
    res.writeHead(200, headers);

    // pipeline tears down every stage if the client disconnects or a stage errors, so the
    // unpin in `finally` always runs (writes never stay frozen after the download ends).
    const source = createReadStream(dbPath);
    if (acceptsGzip) {
      // level 1: the hotspot link, not the CPU, is the bottleneck, and gzip is throttled to
      // the client's download speed by backpressure — a low level keeps a Pi Zero comfortably
      // ahead while still shrinking this repetitive telemetry a lot.
      await pipeline(source, createGzip({ level: 1 }), res);
    } else {
      await pipeline(source, res);
    }
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(`db download failed: ${err}`);
    } else {
      res.destroy();
    }
  } finally {
    unpinDbFile();
  }
}
