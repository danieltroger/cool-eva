import { readdir, stat } from "fs/promises";
import { join } from "path";
import type { ServerResponse } from "http";
import { ageMs, snapshot } from "../can/signals.ts";
import { SIGNALS } from "../can/registry.ts";
import { waypointsSaved } from "./waypoint.ts";

// GET /status — the things the dashboard needs that aren't telemetry.
//
// Chiefly the size of the sealed ride log, so the download button can say
// "Download 4.2 MB" before you commit to pulling it over a phone hotspot in a
// garage. Also a per-source liveness summary, which answers "is the CAN bus
// actually being read, or am I looking at a frozen snapshot?" — a question the
// old dashboard could only answer by squinting at whether numbers moved.

const SEGMENT_EXTENSION = ".celog";

/** A signal seen this recently counts as live. Slowest CAN frames here are 1 Hz. */
const FRESH_MS = 10_000;

export interface StatusPayload {
  uptimeSeconds: number;
  waypoints: number;
  /**
   * `files` is a count of `.celog` FILES, not of the segments sealed into them.
   * See measureLog() — the two differ by orders of magnitude, and the field was
   * called `segments` until the dashboard caption built on that name went wrong.
   */
  log: { files: number; bytes: number; enabled: boolean };
  /** Live-vs-total signal counts per group, e.g. `{ battery: [16, 16] }`. */
  groups: Record<string, [live: number, total: number]>;
}

export async function handleStatusEndpoint(res: ServerResponse, directory: string, logEnabled: boolean): Promise<void> {
  const payload: StatusPayload = {
    uptimeSeconds: Math.round(process.uptime()),
    waypoints: waypointsSaved(),
    log: { ...(await measureLog(directory)), enabled: logEnabled },
    groups: summariseGroups(),
  };

  const body = Buffer.from(JSON.stringify(payload), "utf-8");
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(body.length),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

/**
 * Counts the `.celog` files in `directory` and adds their sizes up.
 *
 * ⚠️ **Files, not segments.** This used to return the same number under the name
 * `segments`, and the dashboard printed it as "N sealed segments". It is not that,
 * and the gap is not small: `storage/encrypted-log.ts` seals a segment on a timer
 * (every 30 s by default) and **appends** each one to `rides-<YYYY-MM-DD>.celog`,
 * so one file is one calendar day's worth of segments — hundreds or thousands of
 * them. `scripts/decrypt-log.ts` is what counts the real thing, by walking the
 * framing inside each file.
 *
 * That also explains how the caption managed to look broken without ever being
 * stale: within a day the file count CANNOT change however long the bike runs, so
 * it sat on one number while the log grew underneath it. The reported number was
 * always the true file count — every entry is stat'd here, nothing is capped or
 * sliced — it was the noun that was wrong.
 *
 * Counting segments instead would mean walking every file's framing (a 56-byte
 * header, then a skip of the length it declares) on each /status poll, for a
 * number the download button has no use for. So the cheap answer stays, and the
 * name now says which answer it is.
 */
export async function measureLog(directory: string): Promise<{ files: number; bytes: number }> {
  try {
    const entries = await readdir(directory);
    const segmentFiles = entries.filter(entry => entry.endsWith(SEGMENT_EXTENSION));
    const sizes = await Promise.all(segmentFiles.map(async entry => (await stat(join(directory, entry))).size));
    return { files: segmentFiles.length, bytes: sizes.reduce((sum, size) => sum + size, 0) };
  } catch (error) {
    // Missing directory is the normal "no key configured, nothing written yet"
    // case, so this is routine rather than alarming — but still say which path
    // failed, because a typo'd RIDE_LOG_DIR looks identical from the dashboard.
    console.log(`status: cannot size ride logs at ${directory}:`, (error as Error).message);
    return { files: 0, bytes: 0 };
  }
}

// Seeded from the REGISTRY, not from what has arrived. snapshot() is liveState,
// which only holds keys decoded at least once since boot — so a source that has
// never said anything was absent from this map entirely rather than reading 0-live.
// A dashboard asking "has anything gone dark" would then see no dark groups and
// report health, which is the one answer it must never give wrongly. A group that
// has never been heard from is the strongest possible dark, not the absence of a
// question. Totals are now what the bike DECLARES rather than what it has managed
// to send, which also makes the denominator stable instead of growing as a ride
// goes on.
function summariseGroups(): Record<string, [number, number]> {
  const groups: Record<string, [number, number]> = {};
  const declared = new Set<string>();
  // Groups whose every signal is written only on request are left out entirely.
  // `waypoint` is the case that forced this: it is [0, 3] before you ever save
  // one and back to [0, 3] ten seconds after you do, so including it made the
  // dashboard name it as dark permanently on a healthy bike — and a liveness
  // widget that always names something is one the reader learns to ignore, which
  // is the exact failure it exists to prevent. Whole-group, not per-signal: a
  // group that mixes measured and on-demand signals still has something to say
  // about its measured half.
  const onDemandOnly = new Set(
    [...new Set(SIGNALS.map(signal => signal.group))].filter(group =>
      SIGNALS.filter(signal => signal.group === group).every(signal => signal.onDemand)
    )
  );
  for (const signal of SIGNALS) {
    if (onDemandOnly.has(signal.group)) continue;
    const counts = groups[signal.group] ?? [0, 0];
    counts[1] += 1;
    groups[signal.group] = counts;
    declared.add(signal.key);
  }
  for (const [key, value] of Object.entries(snapshot())) {
    // Skipped here too, or saving a waypoint would put the group back into the
    // payload for ten seconds and the summary would flicker between 16 and 17
    // sources — worse than either steady answer.
    if (onDemandOnly.has(value.group)) continue;
    const counts = groups[value.group] ?? [0, 0];
    // Membership is tested per KEY, not per group: a group can be declared and
    // still receive an undeclared key, and testing the group would count only the
    // first such key. Either way the fraction can never read live > total.
    if (!declared.has(key)) counts[1] += 1;
    // ageMs(), not Date.now() - value.ts: a clock step would otherwise flip every
    // group to 0-live at once, which reads as "the CAN bus died" — the exact
    // question this endpoint exists to answer, answered wrongly.
    const age = ageMs(key);
    if (age !== null && age < FRESH_MS) {
      counts[0] += 1;
    }
    groups[value.group] = counts;
  }
  return groups;
}
