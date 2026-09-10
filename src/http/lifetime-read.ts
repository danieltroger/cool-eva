import type { IncomingMessage, ServerResponse } from "http";
import type { VcuReadRunner } from "../vcu/read-runner.ts";
import type { ServiceGateVerdict } from "../vcu/service-gate.ts";
import { writeLifetimeRead, type StoredLifetimeReply } from "../vcu/lifetime-store.ts";
import { describeMeasurement } from "../vcu/lifetime-read.ts";
import type { LifetimeReadResult } from "../vcu/lifetime-read.ts";
import { SERVICE_MODE_HEADER, SERVICE_MODE_HEADER_VALUE } from "./vcu-read.ts";

// POST /lifetime-read — read the bike's lifetime battery statistics off components 51
// and 52, in this process, and store what comes back.
//
// ⚠️ ITS OWN PATH, not a method on /lifetime-stats, and the split is the same one the
// parameter side already makes: /vcu-params serves the stored snapshot and never
// touches the bus, /vcu-read does the reading. /lifetime-stats is this feature's
// /vcu-params — its handler takes no `req` at all, which makes "nothing here can reach
// the bus" a guarantee the type checker enforces rather than a comment. Adding a method
// there would have spent that to save a route.
//
// ⚠️ A POST because it puts frames on the bike's bus and GET must be safe: a browser, a
// prefetcher, a link preview or a `curl` of the URL bar must not open a diagnostic
// session. Same `X-Cool-Eva: service-mode` header as /vcu-read and /vcu-probe, which a
// CORS-simple request cannot set.
//
// ⚠️ And behind the same gate. This is two multi-frame exchanges rather than 277 single
// ones, but "short" is not the property the gate is about: nothing transmits while the
// motorcycle can move. The runner checks before the session opens and a watchdog
// re-checks while the read is in flight.
//
// What it measures about itself, and why that is the point:
// docs/lifetime-battery-statistics.md.

export interface LifetimeReadResponse {
  /** How late our flow control was, in words. Null when nothing was read. */
  measurement: string | null;
  /** How many of the two components answered with a READING — a refusal sent bytes and is not one. */
  answered: number | null;
  /** Why nothing was read, why it was not stored, or what the components that failed said. Null when all is well. */
  message: string | null;
  /** The gate as it reads now, so the page can explain a refusal without a second request. */
  gate: ServiceGateVerdict;
}

export interface LifetimeReadEndpointOptions {
  runner: VcuReadRunner;
  directory: string;
  /** Same switch as /vcu-read and /vcu-probe: SERVICE_MODE_ENABLED=0 means nothing here reaches the bike. */
  enabled: boolean;
}

export async function handleLifetimeReadEndpoint(
  req: IncomingMessage,
  res: ServerResponse,
  options: LifetimeReadEndpointOptions
): Promise<void> {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8", "Allow": "POST" });
    res.end("use POST to read the lifetime battery statistics; GET /lifetime-stats serves the last reading\n");
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

  const outcome = await options.runner.readLifetimeStatistics();
  if (!outcome.ok) {
    // 409, not 500: a busy bus and a bike that may not be serviced are both this
    // endpoint working correctly, and the page shows the reason.
    respond(res, 409, options, { message: outcome.reason });
    return;
  }

  // ⚠️ AFTER the runner returned, which is after the lease and the poller hold are both
  // released. `replaceFileDurably` fsyncs the file and then the directory; that is
  // threadpool work rather than event-loop work, so it cannot stall the CAN handler —
  // but there is no reason for it to happen on the bus's time either.
  const stored = await writeLifetimeRead(options.directory, {
    readAt: Date.now(),
    source: "service",
    replies: outcome.result.replies,
  });
  // ⚠️ The measurement goes back WHATEVER happened to the store. A read that answered
  // 1 of 2 and was correctly refused storage is exactly the run whose flow-control
  // number is worth having, and putting only the refusal here hid it.
  respond(res, 200, options, {
    measurement: describeMeasurement(outcome.result),
    answered: stored.answered,
    // What each component actually said, when they did not all answer. The count alone
    // cannot tell a silent micro from one that refused, and those send you to different
    // places — the first to the bus, the second to the conditions the read was taken in.
    message: stored.stored ? describeFailures(outcome.result.replies) : stored.reason,
  });
}

/** The components that did not answer, by name and reason, or null when they all did. */
function describeFailures(replies: readonly StoredLifetimeReply[]): string | null {
  const failed = replies.filter(reply => reply.failure !== null);
  if (failed.length === 0) {
    return null;
  }
  return failed.map(reply => `component ${reply.component}: ${reply.failure}`).join("; ");
}

function respond(
  res: ServerResponse,
  statusCode: number,
  options: LifetimeReadEndpointOptions,
  fields: Partial<LifetimeReadResponse>
): void {
  const payload: LifetimeReadResponse = {
    measurement: null,
    answered: null,
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
