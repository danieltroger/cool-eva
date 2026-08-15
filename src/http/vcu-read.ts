import type { IncomingMessage, ServerResponse } from "http";
import { exportableRowCount } from "../vcu/backup-csv.ts";
import type { VcuReadRunner, VcuReadState } from "../vcu/read-runner.ts";
import { loadLatestSnapshot } from "./vcu-params.ts";

// /vcu-read — service mode's control surface: start a parameter sweep, watch it,
// stop it.
//
//   GET     how the current or last sweep is going
//   POST    start one (refused, not queued, if one is already running)
//   DELETE  ask a running one to stop, keeping what it has
//
// ⚠️ This is the ONE endpoint in this repo that causes traffic on the bike's bus,
// and it does it by running `scripts/read-vcu-params.ts` rather than by talking to
// the micros itself — see the header of src/vcu/read-runner.ts for why that
// distinction is load-bearing and not a technicality. The service process still
// contains no path from an HTTP request to a CAN frame.
//
// ⚠️ Still read-only. A sweep can only ask `10 81`, `3E` and `22`: those three are
// the whole of param-codec.ts's request union, and its encoder throws on anything
// else on the way out. There is no parameter on this endpoint that selects a
// service, an identifier or a value — POST takes no body at all — so there is
// nothing here for a widened union to leak through either.
//
// ── Why POST returns immediately ─────────────────────────────────────────────
// A sweep is ~277 reads at a 300 ms reply window; on a bike whose link drops as
// routine it can take a minute or stall entirely. Holding the response open for
// that would freeze the phone's request, time out on garage wifi, and leave the
// dashboard unable to say what had been read so far. So POST starts it and
// returns, and GET is how the page follows along — which also means closing the
// page, or riding out of wifi range, does not stop the sweep.

export interface VcuReadExportSummary {
  /** How many rows an export would carry right now. Zero is a real answer, not "unknown". */
  rows: number;
  /** When the snapshot behind those rows was taken, or null when there is none. */
  readAt: number | null;
  /** False when the snapshot it comes from was itself a truncated sweep. */
  complete: boolean;
}

export interface VcuReadResponse {
  run: VcuReadState;
  /** What /vcu-backup.csv would hand over, so the page can label the button without fetching 277 rows to count them. */
  export: VcuReadExportSummary;
  /** Why a POST or DELETE did nothing. Null on a GET and on a request that did what it said. */
  message: string | null;
}

export async function handleVcuReadEndpoint(
  req: IncomingMessage,
  res: ServerResponse,
  runner: VcuReadRunner,
  directory: string
): Promise<void> {
  switch (req.method) {
    case "GET":
      await respond(res, 200, runner, directory, null);
      return;
    case "POST": {
      const { started, reason } = runner.start();
      // 409, not 500: "one is already running" is the endpoint working correctly,
      // and the page shows the reason rather than an error.
      await respond(res, started ? 202 : 409, runner, directory, reason);
      return;
    }
    case "DELETE": {
      const cancelled = runner.cancel();
      await respond(res, cancelled ? 202 : 409, runner, directory, cancelled ? null : "no sweep is running");
      return;
    }
    default:
      res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8", "Allow": "GET, POST, DELETE" });
      res.end("use GET to watch a parameter read, POST to start one, DELETE to stop it\n");
  }
}

async function respond(
  res: ServerResponse,
  statusCode: number,
  runner: VcuReadRunner,
  directory: string,
  message: string | null
): Promise<void> {
  const payload: VcuReadResponse = {
    run: await runner.state(),
    export: await summariseExport(directory),
    message,
  };
  const body = Buffer.from(JSON.stringify(payload), "utf-8");
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(body.length),
    // Progress with a timestamp in it. A cached copy would freeze the count on
    // screen while the sweep carried on, which is worse than no count at all.
    "Cache-Control": "no-store",
  });
  res.end(body);
}

/**
 * What a download would contain, from the snapshot on disk.
 *
 * Deliberately counts the EXPORTABLE rows rather than all of them: a snapshot of
 * 277 rows in which the bike answered none would otherwise offer a download of a
 * header line, described as 277 parameters.
 */
async function summariseExport(directory: string): Promise<VcuReadExportSummary> {
  const latest = await loadLatestSnapshot(directory);
  if (latest.state !== "snapshot") {
    return { rows: 0, readAt: null, complete: false };
  }
  return {
    rows: exportableRowCount(latest.snapshot),
    readAt: latest.snapshot.readAt,
    complete: latest.snapshot.complete,
  };
}
