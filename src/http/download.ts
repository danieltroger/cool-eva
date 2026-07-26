import { createReadStream } from "fs";
import { readdir, stat } from "fs/promises";
import { join } from "path";
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
  const sizes = await Promise.all(files.map(async file => (await stat(file)).size));
  const totalBytes = sizes.reduce((sum, size) => sum + size, 0);
  const filename = `cool-eva-${new Date().toISOString().slice(0, 10)}.celog`;

  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Content-Length": String(totalBytes),
    "Content-Disposition": `attachment; filename="${filename}"`,
  });

  for (const [index, file] of files.entries()) {
    try {
      await streamInto(res, file, sizes[index]);
    } catch (error) {
      console.error(`dl: streaming ${file} failed:`, (error as Error).message);
      res.destroy();
      return;
    }
  }
  res.end();
  console.log(`dl: served ${files.length} segment file(s), ${totalBytes} bytes`);
}

function streamInto(res: ServerResponse, path: string, byteCount: number): Promise<void> {
  return new Promise((resolve, reject) => {
    // `end: 0-based inclusive` — pin to the size we already announced so a
    // segment appended mid-download can't push us past Content-Length.
    const source = createReadStream(path, { start: 0, end: byteCount - 1 });
    source.on("error", reject);
    source.on("end", resolve);
    source.pipe(res, { end: false });
  });
}
