import { readFile } from "fs/promises";
import { join } from "path";
import type { ServerResponse } from "http";
import {
  reportTableType,
  retableSnapshot,
  type TableTypeReport,
  type VcuParameterRow,
  type VcuParameterSnapshot,
} from "../vcu/snapshot.ts";

// GET /vcu-params — the VCU's calibration parameters as they were last read off the
// bike, so /params.html can show them by name on a phone in the garage.
//
// ⚠️ IT NEVER TOUCHES THE BUS, and that is the design rather than an implementation
// detail. It serves a file that a previous sweep wrote; refreshing the
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
export type { TableTypeReport, VcuParameterRow, VcuParameterSnapshot };

export type VcuParamsResponse =
  /**
   * No snapshot on this Pi. Deliberately NOT an empty list: "nobody has read the
   * parameters here" and "this bike has no parameters" are different claims, and
   * only one of them is true. The hint is the command that fixes it.
   */
  | { state: "never-read"; directory: string; hint: string }
  /**
   * The last snapshot, whole. `complete: false` inside it means the sweep was cut short.
   *
   * `tableType` is derived here rather than in the browser: the comparison needs all
   * 28 of Energica's parameter tables (src/vcu/table-catalog.ts) and the page cannot
   * import a TypeScript module at runtime, so re-implementing it in
   * public/lib/params-page.js would be the same drift this banner exists to catch.
   *
   * ⚠️ `snapshot` is served with its rows re-named from that same reading — see
   * loadLatestSnapshot(). A stored snapshot's names are a DERIVED view, and deriving
   * them here from the bike's own answer is what keeps a file written under one table
   * from being read under another.
   */
  | { state: "snapshot"; snapshot: VcuParameterSnapshot; tableType: TableTypeReport }
  /** There is a file and it could not be read or parsed. Never silently rendered as "never read". */
  | { state: "unreadable"; directory: string; reason: string };

/** Written by src/vcu/snapshot-store.ts at the end of every sweep that read something. */
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

/**
 * The last snapshot on this Pi, as one of the three things it can be.
 *
 * Exported so ./vcu-read.ts and ./vcu-backup.ts do not each re-derive where
 * `latest.json` lives or re-decide what a missing one means. There is one answer to
 * "has this bike been read here", and this is it.
 */
export async function loadLatestSnapshot(directory: string): Promise<VcuParamsResponse> {
  const path = join(directory, LATEST_FILE);
  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        state: "never-read",
        directory,
        hint: "start one from the dashboard: Menu → Service mode, with the bike awake, parked and out of drive",
      };
    }
    // Not swallowed and not disguised as "never read": a permissions problem or a
    // half-written file is a fault to fix, and pretending the read simply never
    // happened would hide it for as long as nobody re-ran the script.
    console.warn(`vcu-params: could not read ${path}:`, err);
    return { state: "unreadable", directory, reason: describeError(err) };
  }
  let snapshot: VcuParameterSnapshot;
  try {
    snapshot = JSON.parse(text) as VcuParameterSnapshot;
  } catch (err) {
    console.warn(`vcu-params: ${path} is not valid JSON:`, err);
    return { state: "unreadable", directory, reason: `${LATEST_FILE} is not valid JSON — ${describeError(err)}` };
  }
  // Kept OUT of the parse's catch on purpose. `reportTableType` walks `snapshot.rows`,
  // so a file that is valid JSON but not a snapshot — `{}`, `null`, a truncated write
  // that still parses — throws here, and folding that into the block above would
  // report a well-formed file as "not valid JSON". Both are unreadable; they are not
  // the same fault, and the reason string is what someone standing in a garage has to
  // work from.
  try {
    const tableType = reportTableType(snapshot);
    // ⚠️ Re-named from the table the snapshot ITSELF reports, not served as stored.
    // src/vcu/snapshot-store.ts already does this before writing, so for anything this
    // version wrote it is a no-op — it is here for the file on an existing Pi, written
    // before the catalogue existed and therefore carrying whichever table that build
    // hardcoded. Serving those names on a bike that turns out to be on a `RegenFade`
    // table would put `CELL_COUNT` on the page next to a regen fade point, which is the
    // one outcome this whole feature exists to prevent. Cheap and pure, so it is done on
    // every load rather than gated on a version field the old file does not have.
    return { state: "snapshot", snapshot: retableSnapshot(snapshot, tableType), tableType };
  } catch (err) {
    console.warn(`vcu-params: ${path} parsed but is not a parameter snapshot:`, err);
    return {
      state: "unreadable",
      directory,
      reason: `${LATEST_FILE} parsed but is not a parameter snapshot — ${describeError(err)}`,
    };
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
