import type { ServerResponse } from "node:http";
import { HOW_TO_READ, loadFreezeFrames, type StoredFreezeFrameReading } from "../vcu/freeze-frame-store.ts";

// GET /freeze-frames — what the VCU recorded when each stored code set, as last read.
//
// ⚠️ THIS ENDPOINT DOES NOT TOUCH THE BUS. It serves a file, and it takes no `req` at all,
// which makes that a guarantee the type checker enforces rather than a comment. The read
// that fills the file is POST /freeze-frame-read, its own path — the same split as
// /vcu-params ÷ /vcu-read and /lifetime-stats ÷ /lifetime-read.
//
// Decoded per request rather than at startup: the file can be written by a script with the
// service stopped, and that should show up on the next refresh rather than after a restart.

export interface FreezeFramesResponse {
  /** Null when this Pi has never taken a reading, or the file is damaged — the page says so. */
  reading: StoredFreezeFrameReading | null;
  /** How a reading gets taken, so the answer on screen is not "ask an agent". */
  howToRead: string;
}

export async function handleFreezeFramesEndpoint(res: ServerResponse, directory: string): Promise<void> {
  const payload: FreezeFramesResponse = { reading: await loadFreezeFrames(directory), howToRead: HOW_TO_READ };
  const body = Buffer.from(JSON.stringify(payload), "utf-8");
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(body.length),
    // The age of the reading is the point of the block on screen, and a cached copy would
    // freeze it at whatever it said when the tab was first opened.
    "Cache-Control": "no-store",
  });
  res.end(body);
}
