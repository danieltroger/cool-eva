import { mkdir, readFile } from "fs/promises";
import { replaceFileDurably } from "../storage/durable.ts";
import { join } from "path";
import { decodeFreezeFrameResponse } from "../diagnostics/freeze-frame.ts";
import { summariseLifetimeStatistics, type LifetimeStatistics } from "../diagnostics/lifetime-stats.ts";
import { bytesFromHex } from "./snapshot.ts";

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
//
// What a write refuses and why: `writeLifetimeRead`, and docs/lifetime-battery-statistics.md.

const LATEST_FILE = "lifetime.json";

/**
 * How a reading is taken today, verbatim, shown on a Pi that has never taken one.
 *
 * ⚠️ ONE STRING, AND IT IS EXECUTABLE. scripts/check-lifetime-stats.ts runs it through
 * the script's own argument parser, because the first version said `--components 51,52`
 * — a flag that never existed — and it was the first instruction every Pi would show.
 *
 * It lives here rather than with the endpoint that serves it because this module owns
 * the file the command produces, and both the CLI and the HTTP layer already import it.
 */
export const HOW_TO_READ =
  "node --experimental-strip-types scripts/read-freeze-frame.ts --lifetime --save, with the service stopped";

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

/**
 * A reading as the dashboard receives it.
 *
 * Named rather than inferred from the loader, so the browser's view of the payload is a
 * contract rather than an implementation detail — src/http/vcu-params.ts's own union is
 * the precedent.
 */
export interface StoredLifetimeReading {
  statistics: LifetimeStatistics;
  source: LifetimeReadSource;
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
export async function loadLifetimeStatistics(directory: string): Promise<StoredLifetimeReading | null> {
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

/**
 * Writes a reading — unless it would replace a better one. Says which, and returns it.
 *
 * ⚠️ A WORSE RUN MUST NEVER CLOBBER A GOOD FILE, and this is not the theoretical
 * version of that rule: taking a reading needs the service stopped and `can0` up
 * ACTIVE, so the likeliest run of all is the one where the bike was asleep or the bus
 * came up listen-only and NOTHING answered. Writing that would destroy payloads that
 * cost a service stop and a trip to the garage to get, and cannot be reconstructed
 * from anything. src/vcu/snapshot-store.ts rule 5, same argument.
 */
export async function writeLifetimeRead(
  directory: string,
  read: StoredLifetimeRead
): Promise<{ stored: boolean; reason: string }> {
  const answered = read.replies.filter(reply => reply.payloadHex !== null).length;
  const path = join(directory, LATEST_FILE);
  await mkdir(directory, { recursive: true });
  await archive(directory, read);
  const previous = await loadStoredRead(directory);
  const previousAnswered = previous?.replies.filter(reply => reply.payloadHex !== null).length ?? 0;
  if (answered === 0) {
    const reason = `nothing answered, so ${path} is left as it was — ${previousAnswered} stored replies stand`;
    console.warn(`lifetime: ⚠️  ${reason}`);
    return { stored: false, reason };
  }
  if (answered < previousAnswered) {
    // Said out loud rather than done quietly, for the reason snapshot-store.ts gives:
    // "your page still says yesterday" is baffling when it is silent.
    const reason = `${answered} replies would replace ${previousAnswered} — KEPT the previous ${LATEST_FILE}`;
    console.warn(`lifetime: ⚠️  ${reason}`);
    return { stored: false, reason };
  }
  // Renamed into place, never written in place: a truncated lifetime.json reads as
  // null, the page says "never read", and a reading that cost a service stop and a
  // trip to the garage is gone. Same rule and same call as ./snapshot-store.ts's
  // latest.json — docs/power-cuts.md.
  await replaceFileDurably(path, `${JSON.stringify(read, null, 2)}\n`);
  const reason = `stored ${answered}/${read.replies.length} replies from ${read.source} in ${path}`;
  console.log(`lifetime: ${reason}`);
  return { stored: true, reason };
}

/**
 * Every run leaves a trace, refused or not — src/vcu/snapshot-store.ts rule 1.
 *
 * ⚠️ Rule 5 without rule 1 is how you lose a reading. Refusing to overwrite the good
 * file is right, but it left the bytes of the refused run in terminal scrollback only —
 * and this doc's own #160 is about payloads lost exactly that way, on a read that costs
 * a service stop and a trip to the garage.
 */
async function archive(directory: string, read: StoredLifetimeRead): Promise<void> {
  const stamp = new Date(read.readAt).toISOString().replace(/:/g, "-");
  await replaceFileDurably(join(directory, `lifetime-${stamp}.json`), `${JSON.stringify(read, null, 2)}\n`);
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
    // ⚠️ EVERY ELEMENT, not just the array. This file is served by an HTTP handler that
    // is not itself wrapped in a try, and the process has no `unhandledRejection` hook,
    // so a `replies: [null]` reaching the decoder below would take the service down —
    // over a file whose only purpose is a block on a debug tab.
    if (typeof parsed.readAt !== "number" || !Array.isArray(parsed.replies) || !parsed.replies.every(isStoredReply)) {
      console.warn(`lifetime: ${path} parsed but is not a stored reading`);
      return null;
    }
    return parsed;
  } catch (err) {
    console.warn(`lifetime: ${path} is not valid JSON:`, err);
    return null;
  }
}

/** Whether one element of `replies` is the shape this module wrote. */
function isStoredReply(reply: unknown): reply is StoredLifetimeReply {
  if (typeof reply !== "object" || reply === null) {
    return false;
  }
  const candidate = reply as Partial<StoredLifetimeReply>;
  return (
    typeof candidate.component === "number" &&
    (typeof candidate.payloadHex === "string" || candidate.payloadHex === null) &&
    (typeof candidate.failure === "string" || candidate.failure === null)
  );
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
  // ⚠️ ./snapshot.ts's parser, not a local one. The copy this replaced split on a
  // literal space and validated the parsed NUMBER rather than the token, so `"AB\tCD"`
  // came back one byte short — and a payload one byte short decodes every field after
  // it out of the wrong bytes, confidently. That header argues the same case for
  // `latest.json`; this file is read back the same way.
  const bytes = bytesFromHex(reply.payloadHex);
  if (bytes === null) {
    return { kind: "unrecognised" as const, reason: "stored payload is not hex bytes", rawHex: reply.payloadHex };
  }
  return decodeFreezeFrameResponse(bytes, reply.component);
}
