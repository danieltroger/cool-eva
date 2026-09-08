import type { ServerResponse } from "http";
import { loadLifetimeStatistics } from "../vcu/lifetime-store.ts";

// GET /lifetime-stats — the bike's lifetime battery statistics as last read, with the
// age of the reading.
//
// ⚠️ THIS ENDPOINT DOES NOT TOUCH THE BUS. It serves a file. The statistics are not
// broadcast (obd-garage/DC_CHARGE_LIMITS.md §10.6), so they arrive only from a
// freeze-frame read — today `scripts/read-freeze-frame.ts --save`, run with the
// service stopped, which is why this is a reader and not a control. The invariant in
// src/http/vcu-read.ts, that /vcu-read is the only path from an HTTP request to a CAN
// frame, therefore still holds.
//
// The reading is decoded per request rather than at startup: the file is written by
// another process, and a `--save` run while the dashboard is open should show up on
// the next refresh rather than after a restart.

export interface LifetimeStatsResponse {
  /** Null when this Pi has never taken a reading, or the file is damaged — the page then says so. */
  reading: Awaited<ReturnType<typeof loadLifetimeStatistics>>;
  /** How a reading gets taken today. Shown on the page, so the answer is not "ask an agent". */
  howToRead: string;
}

/** How a reading is taken today. One place, so the page and the doc cannot drift apart. */
export const HOW_TO_READ =
  "node --experimental-strip-types scripts/read-freeze-frame.ts --components 51,52 --save, with the service stopped";

export async function handleLifetimeStatsEndpoint(res: ServerResponse, directory: string): Promise<void> {
  const payload: LifetimeStatsResponse = {
    reading: await loadLifetimeStatistics(directory),
    howToRead: HOW_TO_READ,
  };
  const body = Buffer.from(JSON.stringify(payload), "utf-8");
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(body.length),
    // The age stamp is the whole point of the block on screen, and a cached copy
    // would freeze it at whatever it said when the tab was first opened.
    "Cache-Control": "no-store",
  });
  res.end(body);
}
