import { readFile } from "fs/promises";
import { join } from "path";
import type { ServerResponse } from "http";
import type { VcuParameterRow, VcuParameterSnapshot } from "../vcu/snapshot.ts";

// GET /vcu-params — the VCU's calibration parameters as they were last read off the
// bike, so /params.html can show them by name on a phone in the garage.
//
// ⚠️ IT NEVER TOUCHES THE BUS, and that is the design rather than an implementation
// detail. It serves a file that scripts/read-vcu-params.ts wrote; refreshing the
// page cannot make the bike answer anything, cannot open a diagnostic session and
// cannot take bus time away from the OBD poller. Same standing rule as
// /stored-dtcs, and here it is what lets the read be deliberate and rare while the
// result stays a tap away — see the reasoning at the top of the script.
//
// The consequence to be honest about: what this serves can be arbitrarily old, and
// it is old EXACTLY when the bike has not been read recently. So the wire shape
// carries `readAt` and the page says how old it is, in the same spirit as
// /stored-dtcs' `ageMs`.

/** Re-exported so public/lib/params-page.js has one place to import the wire shape from. */
export type { VcuParameterRow, VcuParameterSnapshot };

export type VcuParamsResponse =
  /**
   * No snapshot on this Pi. Deliberately NOT an empty list: "nobody has read the
   * parameters here" and "this bike has no parameters" are different claims, and
   * only one of them is true. The hint is the command that fixes it.
   */
  | { state: "never-read"; directory: string; hint: string }
  /** The last snapshot, whole. `complete: false` inside it means the sweep was cut short. */
  | { state: "snapshot"; snapshot: VcuParameterSnapshot }
  /** There is a file and it could not be read or parsed. Never silently rendered as "never read". */
  | { state: "unreadable"; directory: string; reason: string };

/** Written by scripts/read-vcu-params.ts at the end of every run, complete or not. */
const LATEST_FILE = "latest.json";

export async function handleVcuParamsEndpoint(res: ServerResponse, directory: string): Promise<void> {
  const body = Buffer.from(JSON.stringify(await loadLatestSnapshot(directory)), "utf-8");
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(body.length),
    // Live-ish data with a timestamp in it: a cached copy would put a stale age on
    // screen, which is worse than no age at all.
    "Cache-Control": "no-store",
  });
  res.end(body);
}

async function loadLatestSnapshot(directory: string): Promise<VcuParamsResponse> {
  const path = join(directory, LATEST_FILE);
  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        state: "never-read",
        directory,
        hint: "run: node --experimental-strip-types scripts/read-vcu-params.ts (on the Pi, bike awake)",
      };
    }
    // Not swallowed and not disguised as "never read": a permissions problem or a
    // half-written file is a fault to fix, and pretending the read simply never
    // happened would hide it for as long as nobody re-ran the script.
    console.warn(`vcu-params: could not read ${path}:`, err);
    return { state: "unreadable", directory, reason: describeError(err) };
  }
  try {
    return { state: "snapshot", snapshot: JSON.parse(text) as VcuParameterSnapshot };
  } catch (err) {
    console.warn(`vcu-params: ${path} is not valid JSON:`, err);
    return { state: "unreadable", directory, reason: `${LATEST_FILE} is not valid JSON — ${describeError(err)}` };
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
