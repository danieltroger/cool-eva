import type { ServerResponse } from "http";
import { HOW_TO_READ, loadLifetimeStatistics, type StoredLifetimeReading } from "../vcu/lifetime-store.ts";

// GET /lifetime-stats — the bike's lifetime battery statistics as last read, with the
// age of the reading.
//
// ⚠️ THIS ENDPOINT DOES NOT TOUCH THE BUS. It serves a file. The statistics are not
// broadcast (obd-garage/DC_CHARGE_LIMITS.md §10.6), so they arrive only from a
// freeze-frame read — today `scripts/read-freeze-frame.ts --lifetime --save`, run with
// the service stopped, which is why this is a reader and not a control. Nothing here
// can reach the bus: it has no `req`, no gate and no client.
//
// The reading is decoded per request rather than at startup: the file is written by
// another process, and a `--save` run while the dashboard is open should show up on
// the next refresh rather than after a restart.

export interface LifetimeStatsResponse {
  /** Null when this Pi has never taken a reading, or the file is damaged — the page then says so. */
  reading: StoredLifetimeReading | null;
  /** How a reading gets taken today. Shown on the page, so the answer is not "ask an agent". */
  howToRead: string;
}

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
