import type { IncomingMessage, ServerResponse } from "http";
import type { VcuReadRunner } from "../vcu/read-runner.ts";
import type { ServiceGateVerdict } from "../vcu/service-gate.ts";
import { writeLifetimeRead } from "../vcu/lifetime-store.ts";
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
  /** How many of the two components answered with bytes. */
  answered: number | null;
  /** Why nothing was read, or why the result was not stored. Null when it was. */
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
    await respond(res, 403, options, { message: "service mode is switched off on this Pi (SERVICE_MODE_ENABLED=0)" });
    return;
  }

  const outcome = await options.runner.readLifetimeStatistics();
  if (!outcome.ok) {
    // 409, not 500: a busy bus and a bike that may not be serviced are both this
    // endpoint working correctly, and the page shows the reason.
    await respond(res, 409, options, { message: outcome.reason });
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
  const answered = outcome.result.replies.filter(reply => reply.payloadHex !== null).length;
  // ⚠️ The measurement goes back WHATEVER happened to the store. A read that answered
  // 1 of 2 and was correctly refused storage is exactly the run whose flow-control
  // number is worth having, and putting only the refusal here hid it.
  await respond(res, 200, options, {
    measurement: describeMeasurement(outcome.result),
    answered,
    message: stored.stored ? null : stored.reason,
  });
}

/**
 * The two instruments, in one sentence for the page.
 *
 * ⚠️ The kernel-stamp number is the one that answers the question; the event-loop delay
 * is the independent second reading that needs no timestamp threaded anywhere. Both are
 * shown, because if the kernel stamp turns out absent on this build the other one is
 * the whole answer. src/can/frame-arrival.ts.
 */
function describeMeasurement(result: LifetimeReadResult): string {
  const loop = result.loopDelayMs === null ? "" : ` · worst event-loop delay ${result.loopDelayMs.toFixed(1)} ms`;
  if (result.flowControl === null) {
    return `no flow control was needed${loop}`;
  }
  return result.flowControl.known
    ? `flow control ${result.flowControl.ms.toFixed(1)} ms after the kernel saw the First Frame${loop}`
    : `flow-control latency unmeasured (${result.flowControl.reason})${loop}`;
}

async function respond(
  res: ServerResponse,
  statusCode: number,
  options: LifetimeReadEndpointOptions,
  fields: Partial<LifetimeReadResponse>
): Promise<void> {
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
