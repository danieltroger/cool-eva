import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServiceGateVerdict } from "../vcu/service-gate.ts";
import type { VcuReadRunner } from "../vcu/read-runner.ts";
import { describeFreezeFrameRead } from "../vcu/freeze-frame-read.ts";
import { writeFreezeFrameRead } from "../vcu/freeze-frame-store.ts";
import { describeFailures } from "./lifetime-read.ts";
import { SERVICE_MODE_HEADER, SERVICE_MODE_HEADER_VALUE } from "./vcu-read.ts";

// POST /freeze-frame-read — ask A8 which components have a stored record, then read each
// one, and store what comes back.
//
// ⚠️ A POST because it puts frames on the bike's bus and GET must be safe: a browser, a
// prefetcher, a link preview or a `curl` of the URL bar must not open a diagnostic session.
// Same `X-Cool-Eva: service-mode` header as /vcu-read, /vcu-probe and /lifetime-read, which
// a CORS-simple request cannot set. Same gate, too — nothing transmits while the motorcycle
// can move, and a watchdog re-checks while the read is in flight.
//
// What it does when the bike has more records than the poller hold has room for:
// docs/freeze-frame.md.

export interface FreezeFrameReadResponse {
  /**
   * The read in one sentence, however it came out — including how late our flow control was
   * and the worst event-loop delay, which is what the in-service path exists to measure.
   * Null when nothing was read.
   */
  summary: string | null;
  /** Why nothing was read, why it was not stored, or what the components that failed said. */
  message: string | null;
  /** The gate as it reads now, so the page can explain a refusal without a second request. */
  gate: ServiceGateVerdict;
}

export interface FreezeFrameReadEndpointOptions {
  runner: VcuReadRunner;
  directory: string;
  /** Same switch as /vcu-read: SERVICE_MODE_ENABLED=0 means nothing here reaches the bike. */
  enabled: boolean;
}

export async function handleFreezeFrameReadEndpoint(
  req: IncomingMessage,
  res: ServerResponse,
  options: FreezeFrameReadEndpointOptions
): Promise<void> {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8", "Allow": "POST" });
    res.end("use POST to read the stored freeze frames; GET /freeze-frames serves the last reading\n");
    return;
  }
  if (req.headers[SERVICE_MODE_HEADER] !== SERVICE_MODE_HEADER_VALUE) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`starting a read needs the ${SERVICE_MODE_HEADER}: ${SERVICE_MODE_HEADER_VALUE} header\n`);
    return;
  }
  if (!options.enabled) {
    respond(res, 403, options, { message: "service mode is switched off on this Pi (SERVICE_MODE_ENABLED=0)" });
    return;
  }

  const outcome = await options.runner.readFreezeFrames();
  if (!outcome.ok) {
    // 409, not 500: a busy bus and a bike that may not be serviced are both this endpoint
    // working correctly, and the page shows the reason.
    respond(res, 409, options, { message: outcome.reason });
    return;
  }

  // ⚠️ AFTER the runner returned, which is after the lease and the poller hold are both
  // released. `replaceFileDurably` fsyncs the file and then the directory; that is
  // threadpool work rather than event-loop work, but there is no reason for it to happen
  // on the bus's time either.
  const stored = await writeFreezeFrameRead(options.directory, {
    readAt: Date.now(),
    source: "service",
    completion: outcome.result.completion,
    components: outcome.result.components,
    replies: outcome.result.replies,
    list: outcome.result.list,
  });
  // ⚠️ The summary goes back WHATEVER happened to the store, for the reason
  // /lifetime-read gives: a read that was correctly refused storage is exactly the run
  // whose outcome is worth having on screen.
  // ⚠️ The count is IN the summary, not beside it. `answered` and `listed` were the same
  // two numbers `describeFreezeFrameRead` already prints, so the phone rendered
  // "3/5 components answered · freeze frames: read 3/3 answered in 2.1 s" — one numerator,
  // two denominators, and a three-branch null dance for fields that were always all-set or
  // all-null together.
  respond(res, 200, options, {
    summary: describeFreezeFrameRead(outcome.result),
    message: stored.stored ? describeFailures(outcome.result.replies) : stored.reason,
  });
}

function respond(
  res: ServerResponse,
  statusCode: number,
  options: FreezeFrameReadEndpointOptions,
  fields: Partial<FreezeFrameReadResponse>
): void {
  const payload: FreezeFrameReadResponse = {
    summary: null,
    message: null,
    gate: options.runner.gate(),
    ...fields,
  };
  const body = Buffer.from(JSON.stringify(payload), "utf-8");
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(body.length),
    "Cache-Control": "no-store",
  });
  res.end(body);
}
