import { createReadStream } from "fs";
import { readdir, stat } from "fs/promises";
import { join } from "path";
import { pipeline } from "stream/promises";
import type { ServerResponse } from "http";

// GET /dl — hand over the sealed ride log.
//
// Short path because it gets typed on a phone. No snapshot dance is needed
// (unlike the old /db, which had to work around SQLite's WAL to avoid serving a
// torn file): segments are immutable once appended, and each one is self-framing
// with its own magic header, so the files can simply be concatenated in order
// and fed straight to scripts/decrypt-log.ts.
//
// The payload is ciphertext, so serving it is safe even on a network you don't
// trust — without the laptop's private key it is noise.

const SEGMENT_EXTENSION = ".celog";

export async function handleDownloadEndpoint(res: ServerResponse, directory: string): Promise<void> {
  let files: string[];
  try {
    const entries = await readdir(directory);
    files = entries
      .filter(entry => entry.endsWith(SEGMENT_EXTENSION))
      .sort()
      .map(entry => join(directory, entry));
  } catch (error) {
    console.warn(`dl: cannot read ${directory}:`, (error as Error).message);
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end(`no ride logs at ${directory}\n`);
    return;
  }

  if (files.length === 0) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("no ride logs yet\n");
    return;
  }

  // Sum the sizes up front so the phone shows a real progress bar. Sizes can
  // only grow between here and the read (segments are append-only), and we stop
  // each file at the byte count promised, so the response can't overrun.
  //
  // Zero-byte files are dropped: createReadStream({end: -1}) throws
  // ERR_OUT_OF_RANGE, and by then the headers are already sent — an appendFile
  // that failed right after creating the file (ENOSPC) leaves exactly that.
  const sized = (await Promise.all(files.map(async file => ({ file, size: (await stat(file)).size })))).filter(
    entry => entry.size > 0
  );
  if (sized.length === 0) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("no ride logs yet\n");
    return;
  }
  const totalBytes = sized.reduce((sum, entry) => sum + entry.size, 0);
  const filename = `cool-eva-${new Date().toISOString().slice(0, 10)}.celog`;

  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Content-Length": String(totalBytes),
    "Content-Disposition": `attachment; filename="${filename}"`,
  });

  for (const { file, size } of sized) {
    try {
      // `end` is 0-based inclusive — pin to the size already announced so a
      // segment appended mid-download can't push us past Content-Length.
      // pipeline() (not pipe) so an aborted download destroys the read stream
      // and rejects: bare pipe() leaves the source paused with no consumer, the
      // promise never settles and the fd leaks. On garage wifi, fetching the
      // whole history with no resume, aborts are the common case.
      await pipeline(createReadStream(file, { start: 0, end: size - 1 }), res, { end: false });
    } catch (error) {
      console.warn(`dl: download of ${file} ended early:`, (error as Error).message);
      res.destroy();
      return;
    }
  }
  res.end();
  console.log(`dl: served ${sized.length} segment file(s), ${totalBytes} bytes`);
}
