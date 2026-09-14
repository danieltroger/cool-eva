import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { replaceFileDurably } from "../storage/durable.ts";
import { decodeFreezeFrameResponse, type FreezeFrameResponse } from "../diagnostics/freeze-frame.ts";
import {
  answeredCount,
  archiveRead,
  isStoredReply,
  serialiseRead,
  type StoredLifetimeReply,
} from "./lifetime-store.ts";
import { describeListDamage, listParsedCleanly, type FreezeFrameListReport } from "./freeze-frame-list.ts";
import type { FreezeFrameReadResult } from "./freeze-frame-read.ts";
import { bytesFromHex } from "./snapshot.ts";

// Where the bike's stored freeze frames live between reads, and the rule that decides
// whether a new read may replace them.
//
// ⚠️ IT STORES THE PAYLOAD BYTES, NOT THE DECODED ROWS — ./lifetime-store.ts's rule and
// its reason: the decode is partly an inference, this repo has already changed its mind
// about one field's scaling, and rendered numbers in a file are numbers nobody re-examines.
// Bytes re-decode.
//
// ⚠️ THE CLOBBER RULE IS PER COMPONENT, not a count. ./lifetime-store.ts compares how many
// of its two components answered, which is right when the question is always the same two;
// here the LIST is the bike's answer and can legitimately shrink — clear the codes and five
// becomes two. Comparing counts across two different sets of components would be arithmetic
// between two different questions. What is refused instead is LOSING a component the bike
// still says it has. docs/freeze-frame.md.

const LATEST_FILE = "freeze-frames.json";

/** How a reading was taken. Not cosmetic — a service-stopped read is worth telling apart. */
export type FreezeFrameReadSource = "service" | "read-freeze-frame.ts";

/** The file's contents. */
export interface StoredFreezeFrameRead {
  readAt: number;
  source: FreezeFrameReadSource;
  completion: FreezeFrameReadResult["completion"];
  /** Every component the `0x18` named and this read was willing to ask about. */
  components: number[];
  /** One per component ASKED about. A prefix of `components` when the budget stopped the read. */
  replies: StoredLifetimeReply[];
  list: FreezeFrameListReport | null;
}

/** One component's record as the dashboard receives it: the decode, redone per request. */
export interface FreezeFrameRecord {
  component: number;
  /** The decoder's own outcome. `unrecognised` carries `57 00`, which is a real answer — see the view. */
  response: FreezeFrameResponse;
  /** Why these bytes are not a reading, or null when they are one. */
  failure: string | null;
}

/**
 * What GET /freeze-frames serves: the file, with `replies` decoded into `records`.
 *
 * ⚠️ DERIVED from the stored shape rather than restated beside it. As two hand-written
 * interfaces they shared five of six fields, and `loadFreezeFrames` copied them across one
 * by one — so a field added to the file would type-check everywhere and silently never
 * reach the phone.
 */
export type StoredFreezeFrameReading = Omit<StoredFreezeFrameRead, "replies"> & {
  records: FreezeFrameRecord[];
};

/**
 * How a reading gets taken today.
 *
 * ⚠️ Not a shell command, and that is the point — ./lifetime-store.ts's `HOW_TO_READ`
 * records why: an instruction on a phone screen that you cannot follow from that phone is
 * not an instruction. The comma is load-bearing in the same way: *parked, with (the drive
 * down OR plugged in)*, which is the gate's own shape.
 */
export const HOW_TO_READ =
  'menu → Service mode → "Read the stored freeze frames", parked, with the drive down or plugged in';

/** The last reading, decoded, or null when this Pi has never taken one. */
export async function loadFreezeFrames(directory: string): Promise<StoredFreezeFrameReading | null> {
  const stored = await loadStoredRead(directory);
  if (!stored) {
    return null;
  }
  const { replies, ...rest } = stored;
  return { ...rest, records: replies.map(toRecord) };
}

/**
 * Writes a reading — unless it would lose something the bike still has. Says which.
 *
 * The whole rule, and every case it was argued against:
 *
 *   degraded = components the PREVIOUS file answered, that this read does NOT answer,
 *              and that are still on THIS read's list
 *   store iff (something answered, or the list was genuinely empty) and degraded is empty
 *
 * `no-list` never stores: there is no list, so there is nothing to judge a loss against.
 */
export async function writeFreezeFrameRead(
  directory: string,
  read: StoredFreezeFrameRead
): Promise<{ stored: boolean; reason: string; answered: number }> {
  const answered = answeredCount(read.replies);
  const path = join(directory, LATEST_FILE);
  await mkdir(directory, { recursive: true });
  // Every run leaves a trace, refused or not — ./snapshot-store.ts rule 1. Rule 5 without
  // rule 1 is how a reading that cost a service stop ends up in terminal scrollback only.
  // ⚠️ Serialised ONCE for both files. `archive()` and the durable write below were each
  // doing their own `JSON.stringify` of the same object; ../vcu/snapshot-store.ts already
  // hands one string to both.
  const serialised = serialiseRead(read);
  await archive(directory, read.readAt, serialised);

  // ⚠️ ONE guard, on the REPORT rather than on the completion beside it. `list === null`
  // means the `0x18` never answered — whatever the run then called itself — so there is no
  // statement about what the bike has to judge a loss against. Checking `completion` here
  // instead let a `cancelled` run through carrying the same empty list, and it emptied the
  // file: the gate watchdog aborting on a moving motorcycle is not the bike saying it has
  // no stored codes.
  if (read.list === null) {
    const reason = `the 0x18 list was not read, so ${LATEST_FILE} is left as it was`;
    console.warn(`freeze-frame: ⚠️  ${reason}`);
    return { stored: false, reason, answered };
  }
  const emptyList = read.components.length === 0;
  if (answered === 0 && !(emptyList && listParsedCleanly(read.list))) {
    // ⚠️ The exception is narrow on purpose. A `0x18` that lists nothing is the bike
    // saying "nothing is stored", and refusing it would leave pre-clear records on disk
    // with no path to ever empty them. A list where every record was outside 1…63, or one
    // that arrived short, is a GARBLED list — writing "nothing is stored" from that turns
    // a transport fault into a confident claim about the motorcycle.
    const reason = emptyList
      ? `the 0x18 list parsed to nothing usable (${describeListDamage(read.list)}) — ${LATEST_FILE} is left as it was`
      : `nothing answered, so ${LATEST_FILE} is left as it was`;
    console.warn(`freeze-frame: ⚠️  ${reason}`);
    return { stored: false, reason, answered };
  }

  const previous = await loadStoredRead(directory);
  const degraded = degradedComponents(previous, read);
  if (degraded.length > 0) {
    const damage = describeListDamage(read.list);
    const why = damage === null ? "the bike still lists them" : `the 0x18 list ${damage}`;
    const reason =
      `component(s) ${degraded.join(", ")} answered in the stored reading and did not now, and ` +
      `${why} — KEPT the previous ${LATEST_FILE}`;
    console.warn(`freeze-frame: ⚠️  ${reason}`);
    return { stored: false, reason, answered };
  }
  // Renamed into place, never written in place: a truncated file reads as null and a
  // reading that cost a service stop is gone. docs/power-cuts.md.
  await replaceFileDurably(path, serialised);
  const reason = `stored ${answered}/${read.replies.length} replies from ${read.source} in ${path}`;
  console.log(`freeze-frame: ${reason}`);
  return { stored: true, reason, answered };
}

/**
 * Components this read would lose: answered before, and not answered now.
 *
 * Exported so the check can drive it without a filesystem.
 *
 * ⚠️ "AND STILL LISTED" IS CONDITIONAL ON THE LIST BEING BELIEVABLE, and that conjunct is
 * the whole rule. Absent from the list means *the bike no longer has that record* — which is
 * what a clear looks like, and what makes a genuinely shorter reading storable. But that
 * reading is only available once the list PARSED, and the parse is exactly what a transport
 * fault corrupts. A list that declared five records and sent two, or whose count byte says 0
 * with fifteen bytes of records behind it, does not say the missing components are gone — it
 * says we did not hear about them. So when the list is damaged, every previously-answered
 * component this read does not answer counts as degraded and the good file stands.
 *
 * Three runs found by review, each of which destroyed a five-component file before this: a
 * count byte of 0 with real records in `trailingHex` (needing no answer at all), a
 * `truncated` list plus one answer, and four of five records out of range plus one answer.
 */
export function degradedComponents(
  previous: StoredFreezeFrameRead | null,
  next: Pick<StoredFreezeFrameRead, "components" | "replies" | "list">
): number[] {
  if (!previous) {
    return [];
  }
  const answeredNow = new Set(next.replies.filter(reply => reply.failure === null).map(reply => reply.component));
  const stillListed = new Set(next.components);
  const believable = next.list !== null && listParsedCleanly(next.list);
  return previous.replies
    .filter(reply => reply.failure === null)
    .map(reply => reply.component)
    .filter(component => !answeredNow.has(component) && (!believable || stillListed.has(component)));
}

/** The file as it sits on disk, undecoded. Null on every failure, each logged apart. */
export async function loadStoredRead(directory: string): Promise<StoredFreezeFrameRead | null> {
  const path = join(directory, LATEST_FILE);
  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`freeze-frame: could not read ${path}:`, err);
    }
    return null;
  }
  try {
    const parsed = JSON.parse(text) as StoredFreezeFrameRead;
    // ⚠️ EVERY ELEMENT, not just the array. This file is served by an HTTP handler that is
    // not itself wrapped in a try and the process has no `unhandledRejection` hook, so a
    // `replies: [null]` reaching the decoder would take the service down over a file whose
    // only purpose is a block on a tab. ./lifetime-store.ts makes the same check.
    if (
      typeof parsed.readAt !== "number" ||
      !Array.isArray(parsed.replies) ||
      !parsed.replies.every(isStoredReply) ||
      !Array.isArray(parsed.components) ||
      !parsed.components.every(component => typeof component === "number")
    ) {
      console.warn(`freeze-frame: ${path} parsed but is not a stored reading`);
      return null;
    }
    return parsed;
  } catch (err) {
    console.warn(`freeze-frame: ${path} is not valid JSON:`, err);
    return null;
  }
}

/** One stored reply back into the decoder's own outcome union. */
function toRecord(reply: StoredLifetimeReply): FreezeFrameRecord {
  const bytes = reply.payloadHex === null ? null : bytesFromHex(reply.payloadHex);
  if (bytes === null) {
    const reason = reply.payloadHex === null ? (reply.failure ?? "no reply") : "stored payload is not hex bytes";
    return {
      component: reply.component,
      response: { kind: "unrecognised", reason, rawHex: reply.payloadHex ?? "" },
      failure: reply.failure ?? reason,
    };
  }
  // ⚠️ The bytes are decoded even when `failure` is set, unlike ./lifetime-store.ts's
  // reader. A refusal's `7F 17 xx` decodes to `refused`, which is the honest rendering —
  // and `57 00` decodes to `unrecognised` while carrying NO failure, which is the state
  // the view turns into "the VCU has no record for this component".
  return {
    component: reply.component,
    response: decodeFreezeFrameResponse(bytes, reply.component),
    failure: reply.failure,
  };
}

async function archive(directory: string, readAt: number, serialised: string): Promise<void> {
  await archiveRead(directory, "freeze-frames", readAt, serialised);
}
