import { createReadStream } from "fs";
import { createInterface } from "readline";
import { createGunzip } from "zlib";

// Reads a candump capture line by line, compressed or not.
//
// ⚠️ A truncated capture is the NORMAL ending here, not a fault: the Pi takes its power
// from the bike, so almost every file ends where the 12 V did. `gzip -dc`, Node's zlib and
// Python's gzip module all emit everything up to the cut and then raise, and the last line
// is routinely a partial one. So truncation is reported and read past, never thrown.
//
// Captures are concatenated 64 kB gzip MEMBERS (scripts/can-capture/capture.sh). Node's
// `createGunzip()` walks members natively. Its `createZstdDecompress()` does NOT — it stops
// after the first frame and reports success — which is why these files are gzip and why
// this module deliberately does not open `.zst`. docs/can-capture.md.

export async function* openCaptureLines(path: string): AsyncGenerator<string> {
  const file = createReadStream(path);
  const bytes = captureCodecFor(path) === "gzip" ? file.pipe(createGunzip()) : file;
  // ⚠️ `pipe()` does not forward errors, so without this an unreadable file raises an
  // UNHANDLED 'error' on the read stream and takes the process down instead of reaching
  // the try below — which is the opposite of reporting it.
  if (bytes !== file) {
    file.on("error", error => bytes.destroy(error as Error));
  }
  const lines = createInterface({ input: bytes, crlfDelay: Infinity });
  let delivered = 0;
  try {
    for await (const line of lines) {
      delivered += 1;
      yield line;
    }
  } catch (error) {
    if (!isTruncationError(error)) {
      throw error;
    }
    console.warn(
      `capture: ${path} ends mid-stream after ${delivered} lines (${(error as Error).message.split("\n")[0]})`
    );
  } finally {
    lines.close();
    file.destroy();
  }
}

/** Which decoder a capture's NAME calls for. Pure, so the routing is testable on its own. */
export function captureCodecFor(name: string): "gzip" | "plain" {
  return name.endsWith(".gz") ? "gzip" : "plain";
}

/**
 * Whether an error means "the stream stops here" rather than "this is not a capture".
 *
 * ⚠️ Both codes are needed and neither is hypothetical. A clean cut gives `Z_BUF_ERROR`
 * ("unexpected end of file"). A cut that landed inside ext4's delayed allocation leaves the
 * file ending in NULs — `evidence/keyoff/tail-shape.py` measures that as the power-cut
 * signature — and NULs decode as `Z_DATA_ERROR`. Anything else is a real fault and throws.
 */
export function isTruncationError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "Z_BUF_ERROR" || code === "Z_DATA_ERROR";
}
