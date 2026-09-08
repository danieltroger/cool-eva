import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { decodeFreezeFrameResponse } from "../diagnostics/freeze-frame.ts";
import { summariseLifetimeStatistics, type LifetimeStatistics } from "../diagnostics/lifetime-stats.ts";

// Where the last lifetime-statistics reading lives, and the reason it is a file at all:
// this is not a broadcast signal, so nothing re-derives it after a restart. One JSON
// file, written by whoever managed to read the bike and read by the endpoint on every
// request.
//
// ⚠️ IT STORES THE PAYLOAD BYTES, NOT THE DECODED ROWS. The decode is an inference
// (docs/diagnostics-and-checks.md §5) and this repo has already changed its mind about
// one field's scaling; storing the rendered numbers would freeze today's reading of
// the bytes into a file nobody would think to re-examine. Bytes re-decode.
//
// ⚠️ TWO WRITERS, ONE FORMAT. scripts/read-freeze-frame.ts --save writes this with the
// service stopped; an in-service read writes the same file. Which one it was is
// recorded, because "the bike was read while the service was down" is worth knowing
// when the age stamp is three weeks old.

const LATEST_FILE = "lifetime.json";

/** How the reading was taken. Not cosmetic — see the header. */
export type LifetimeReadSource = "service" | "read-freeze-frame.ts";

/** One component's reply, as bytes or as the reason there are none. */
export interface StoredLifetimeReply {
  component: number;
  /** The reassembled payload, uppercase hex, PCI stripped. Null when nothing came back. */
  payloadHex: string | null;
  /** Why there is no payload. Null when there is one. */
  failure: string | null;
}

/** The file's contents. */
export interface StoredLifetimeRead {
  readAt: number;
  source: LifetimeReadSource;
  replies: StoredLifetimeReply[];
}

/**
 * The last reading, decoded, or null when this Pi has never taken one.
 *
 * Null on every failure — missing file, unreadable file, valid JSON that is not a
 * reading — because "nothing has been read" and "the file is damaged" both leave the
 * page with nothing true to show. They are logged separately rather than swallowed,
 * since only one of them is fixed by reading the bike.
 */
export async function loadLifetimeStatistics(
  directory: string
): Promise<{ statistics: LifetimeStatistics; source: LifetimeReadSource } | null> {
  const stored = await loadStoredRead(directory);
  if (!stored) {
    return null;
  }
  const responses = stored.replies.map(reply => ({
    component: reply.component,
    response: decodeStoredReply(reply),
  }));
  return { statistics: summariseLifetimeStatistics(stored.readAt, responses), source: stored.source };
}

/** Writes a reading, replacing whatever was there. */
export async function writeLifetimeRead(directory: string, read: StoredLifetimeRead): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, LATEST_FILE), `${JSON.stringify(read, null, 2)}\n`, "utf-8");
  const answered = read.replies.filter(reply => reply.payloadHex !== null).length;
  console.log(
    `lifetime: stored ${answered}/${read.replies.length} replies from ${read.source} in ${join(directory, LATEST_FILE)}`
  );
}

/** The file as it sits on disk, undecoded. For a caller that wants the bytes rather than the reading. */
export async function loadStoredRead(directory: string): Promise<StoredLifetimeRead | null> {
  const path = join(directory, LATEST_FILE);
  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`lifetime: could not read ${path}:`, err);
    }
    return null;
  }
  try {
    const parsed = JSON.parse(text) as StoredLifetimeRead;
    if (typeof parsed.readAt !== "number" || !Array.isArray(parsed.replies)) {
      console.warn(`lifetime: ${path} parsed but is not a stored reading`);
      return null;
    }
    return parsed;
  } catch (err) {
    console.warn(`lifetime: ${path} is not valid JSON:`, err);
    return null;
  }
}

/**
 * One stored reply back into the decoder's own outcome union.
 *
 * A reply that never arrived becomes `unrecognised` with the failure as its reason,
 * so the row that shows it says what went wrong rather than going blank — the three
 * non-frame outcomes are the ones a real bus produces.
 */
function decodeStoredReply(reply: StoredLifetimeReply) {
  if (reply.payloadHex === null) {
    return { kind: "unrecognised" as const, reason: reply.failure ?? "no reply", rawHex: "" };
  }
  const bytes = reply.payloadHex
    .split(" ")
    .filter(byte => byte.length > 0)
    .map(byte => Number.parseInt(byte, 16));
  if (bytes.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 0xff)) {
    return { kind: "unrecognised" as const, reason: "stored payload is not hex bytes", rawHex: reply.payloadHex };
  }
  return decodeFreezeFrameResponse(Uint8Array.from(bytes), reply.component);
}
