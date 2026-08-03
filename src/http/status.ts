import { readdir, stat } from "fs/promises";
import { join } from "path";
import type { ServerResponse } from "http";
import { ageMs, snapshot } from "../can/signals.ts";
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
  log: { segments: number; bytes: number; enabled: boolean };
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

async function measureLog(directory: string): Promise<{ segments: number; bytes: number }> {
  try {
    const entries = await readdir(directory);
    const segments = entries.filter(entry => entry.endsWith(SEGMENT_EXTENSION));
    const sizes = await Promise.all(segments.map(async entry => (await stat(join(directory, entry))).size));
    return { segments: segments.length, bytes: sizes.reduce((sum, size) => sum + size, 0) };
  } catch (error) {
    // Missing directory is the normal "no key configured, nothing written yet"
    // case, so this is routine rather than alarming — but still say which path
    // failed, because a typo'd RIDE_LOG_DIR looks identical from the dashboard.
    console.log(`status: cannot size ride logs at ${directory}:`, (error as Error).message);
    return { segments: 0, bytes: 0 };
  }
}

function summariseGroups(): Record<string, [number, number]> {
  const groups: Record<string, [number, number]> = {};
  for (const [key, value] of Object.entries(snapshot())) {
    const counts = groups[value.group] ?? [0, 0];
    counts[1] += 1;
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
