import type { IncomingMessage, ServerResponse } from "http";
import { exportableRowCount } from "../vcu/backup-csv.ts";
import type { VcuReadRunner, VcuReadState } from "../vcu/read-runner.ts";
import type { ServiceGateVerdict } from "../vcu/service-gate.ts";
import { loadLatestSnapshot } from "./vcu-params.ts";

// /vcu-read — service mode's control surface: start a parameter sweep, watch it,
// stop it.
//
//   GET     how the current or last sweep is going, and whether the bike may be serviced
//   POST    start one (refused, not queued, if one is already running)
//   DELETE  ask a running one to stop, keeping what it has
//
// ⚠️ This is the ONE endpoint in this repo that causes traffic on the bike's bus,
// and since the sweep moved in-process (src/vcu/sweep.ts) it is also the only path
// from an HTTP request to a CAN frame that exists at all. What stands between the
// two is src/vcu/service-gate.ts: a POST is refused unless the bike is PROVED
// stationary and out of drive, and a sweep already running is put out the moment
// that stops being true. The gate is on the wire below so the page can say why the
// button is unavailable rather than leaving it to fail.
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
// page, or walking out of wifi range, does not stop the sweep. Riding away does,
// but that is the gate rather than the HTTP layer.
//
// ── Why starting a read needs a header ──────────────────────────────────────
// A bare `POST` with no body and no custom headers is a CORS-SIMPLE request: any
// page open in the phone's browser while it is on the bike's hotspot can fire one
// at this endpoint (`fetch(url, {method: "POST", mode: "no-cors"})`, or a plain
// cross-origin `<form method=post>`) without a preflight. It never sees the
// response — but here the side effect IS the point, and it is the only side effect
// in this repo that reaches the bus. The two-tap arming on the page guards against
// a thumb, not against that.
//
// Requiring a header a simple request cannot set makes the browser send a
// preflight first; nothing here answers OPTIONS, so the browser blocks the request
// and the sweep never starts. Same-origin fetches from our own page need no
// preflight, so the dashboard is unaffected. `curl` can still start a read, which
// is correct — anything with a shell on that network already has the bus.
//
// The gate does not replace this and this does not replace the gate. One answers
// "did the owner ask for this", the other "can the motorcycle move". A parked bike
// is exactly when a drive-by request would succeed, so the cheap check still earns
// its keep.
//
// DELETE needs no such guard: a non-simple method already forces a preflight, and
// stopping a sweep is never the dangerous direction anyway.

/** Header the dashboard sends to start a read. Its VALUE is not a secret — being unsettable cross-origin is the point. */
export const SERVICE_MODE_HEADER = "x-cool-eva";

export const SERVICE_MODE_HEADER_VALUE = "service-mode";

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
  /**
   * Whether the bike is safe to service right now, and why not when it is not.
   * Sampled per request, so the page shows the gate as it stands rather than as it
   * stood when the sheet opened.
   */
  gate: ServiceGateVerdict;
  /**
   * False when SERVICE_MODE_ENABLED=0. The page then labels the button as off
   * rather than letting it fail, and — the part that matters — a Pi configured this
   * way has no reachable control that puts anything on the bus at all.
   */
  enabled: boolean;
  /** What /vcu-backup.csv would hand over, so the page can label the button without fetching 277 rows to count them. */
  export: VcuReadExportSummary;
  /** Why a POST or DELETE did nothing. Null on a GET and on a request that did what it said. */
  message: string | null;
}

export interface VcuReadEndpointOptions {
  runner: VcuReadRunner;
  directory: string;
  /**
   * Whether a read may be STARTED. Every other subsystem that touches the bus has
   * an off switch (CAN_ENABLED, OBD_ENABLED, ELOCK_ENABLED, BLE_ENABLED); this is
   * the one for the only control in the dashboard that does. Reading the snapshot
   * and exporting it stay available either way — neither goes near the bike.
   */
  enabled: boolean;
}

export async function handleVcuReadEndpoint(
  req: IncomingMessage,
  res: ServerResponse,
  options: VcuReadEndpointOptions
): Promise<void> {
  switch (req.method) {
    case "GET":
      await respond(res, 200, options, null);
      return;
    case "POST": {
      if (!hasServiceModeHeader(req)) {
        // See the header. This is the one request in the repo whose SIDE EFFECT is
        // the point, so it is the one that has to be unavailable to a page the
        // owner did not open.
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`starting a read needs the ${SERVICE_MODE_HEADER}: ${SERVICE_MODE_HEADER_VALUE} header\n`);
        return;
      }
      if (!options.enabled) {
        // 403 rather than 404: the endpoint exists and is answering, it is the
        // action that is switched off, and the page says which switch.
        await respond(res, 403, options, "service mode is switched off on this Pi (SERVICE_MODE_ENABLED=0)");
        return;
      }
      // The gate lives in the runner rather than here, so that the check a POST
      // makes and the check the sweep makes before every frame are the same code
      // reading the same signals. An endpoint that decided for itself would be a
      // second opinion to keep in step.
      const { started, reason } = options.runner.start();
      // 409, not 500: "the bike is moving" and "one is already running" are both the
      // endpoint working correctly, and the page shows the reason rather than an
      // error.
      await respond(res, started ? 202 : 409, options, reason);
      return;
    }
    case "DELETE": {
      // Always allowed, even switched off: stopping something is never the
      // dangerous direction, and a sweep could still be running from before the
      // flag was set.
      const cancelled = options.runner.cancel();
      await respond(res, cancelled ? 202 : 409, options, cancelled ? null : "no sweep is running");
      return;
    }
    default:
      res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8", "Allow": "GET, POST, DELETE" });
      res.end("use GET to watch a parameter read, POST to start one, DELETE to stop it\n");
  }
}

/** Node lower-cases incoming header names, so this needs no case folding of its own. */
function hasServiceModeHeader(req: IncomingMessage): boolean {
  return req.headers[SERVICE_MODE_HEADER] === SERVICE_MODE_HEADER_VALUE;
}

async function respond(
  res: ServerResponse,
  statusCode: number,
  options: VcuReadEndpointOptions,
  message: string | null
): Promise<void> {
  const payload: VcuReadResponse = {
    run: options.runner.state(),
    gate: options.runner.gate(),
    enabled: options.enabled,
    export: await summariseExport(options.directory),
    message,
  };
  const body = Buffer.from(JSON.stringify(payload), "utf-8");
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(body.length),
    // Progress and a live gate reading. A cached copy would freeze the count on
    // screen while the sweep carried on — and, far worse, show a stale "safe to
    // service" for a bike that has since been ridden off.
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
