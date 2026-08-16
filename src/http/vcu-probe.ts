import type { IncomingMessage, ServerResponse } from "http";
import { PROBE_TARGETS, parseProbeRequest, type VcuProbeReading } from "../vcu/probe.ts";
import type { VcuReadRunner } from "../vcu/read-runner.ts";
import type { ServiceGateVerdict } from "../vcu/service-gate.ts";
import { SERVICE_MODE_HEADER, SERVICE_MODE_HEADER_VALUE } from "./vcu-read.ts";

// POST /vcu-probe?target=A9&bank=2&index=5 — read ONE identifier off ONE ECU.
//
// The replacement for `scripts/read-vcu-params.ts --index N`, which went away when
// the sweep moved into the service. It is not a like-for-like restoration: the old
// flag could only reach bank 1 on the two VCU micros, and this reaches any bank on
// any of the three targets — including the CHARGE MANAGER, which nothing in this
// project had ever addressed. See src/vcu/probe.ts for why that matters.
//
// ── ⚠️ Why this is a POST with a query string, and not a GET ─────────────────
// It puts a frame on the bike's bus. GET must be safe — a browser, a prefetcher, a
// link preview or a `curl` of the URL bar must not be able to open a diagnostic
// session — so the side effect goes behind a method that is not safe by definition.
// The parameters ride in the query string rather than a body because a body would
// make this the only endpoint here that parses one, and there is nothing to gain:
// three scalars, all validated.
//
// It carries the same `X-Cool-Eva: service-mode` header requirement as /vcu-read,
// and for the same reason — a POST with no body and no custom header is CORS-simple,
// so any page open on the bike's hotspot could otherwise fire one. A query string
// does not change that; `Content-Type` is what a simple request is judged on, and
// this sends none.
//
// ── ⚠️ And it is behind the same safety gate ─────────────────────────────────
// A probe is one read, not 277, but "short" is not the property the gate is about.
// The rule is that nothing transmits while the motorcycle can move, and one frame
// breaks it exactly as well as a burst does. The runner checks the gate before the
// session is opened and a watchdog re-checks it while the read is in flight.
//
// ── What comes back ──────────────────────────────────────────────────────────
// The raw bytes, and BOTH the unsigned and the signed reading of them, always.
// Outside bank 1 nothing here knows a width or a sign, so naming one of them "the
// value" would be inventing the half of the answer that was not read off the bus.
// `value` is non-null only where the name table has an opinion.

export interface VcuProbeResponse {
  /** The reading, or null when nothing was asked. */
  reading: VcuProbeReading | null;
  /** Why nothing was asked: a bad request, a busy bus, or a bike that may not be serviced. */
  message: string | null;
  /** The gate as it reads now, so the page can explain a refusal without a second request. */
  gate: ServiceGateVerdict;
  /** The targets this build can address, so the page's selector cannot drift from the codec's. */
  targets: string[];
}

export interface VcuProbeEndpointOptions {
  runner: VcuReadRunner;
  /** Same switch as /vcu-read: SERVICE_MODE_ENABLED=0 means nothing here reaches the bike. */
  enabled: boolean;
}

export async function handleVcuProbeEndpoint(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: VcuProbeEndpointOptions
): Promise<void> {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8", "Allow": "POST" });
    res.end("use POST to probe one identifier: /vcu-probe?target=A9&bank=2&index=5\n");
    return;
  }
  if (req.headers[SERVICE_MODE_HEADER] !== SERVICE_MODE_HEADER_VALUE) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`probing needs the ${SERVICE_MODE_HEADER}: ${SERVICE_MODE_HEADER_VALUE} header\n`);
    return;
  }
  if (!options.enabled) {
    respond(res, 403, options, null, "service mode is switched off on this Pi (SERVICE_MODE_ENABLED=0)");
    return;
  }

  // Validated before anything is started, so a typo is a message rather than a
  // diagnostic session opened for a request that could never have been encoded.
  const parsed = parseProbeRequest({
    target: url.searchParams.get("target"),
    bank: url.searchParams.get("bank"),
    index: url.searchParams.get("index"),
  });
  if (!parsed.ok) {
    // 400, not 409: the request itself is wrong, and re-sending it unchanged will
    // always be wrong. 409 is for a bus that is busy or a bike that is moving.
    respond(res, 400, options, null, parsed.reason);
    return;
  }

  const outcome = await options.runner.probe(parsed.request);
  if (!outcome.ok) {
    respond(res, 409, options, null, outcome.reason);
    return;
  }
  // 200 even for a `refused` or `no-response` reading. Those are ANSWERS — the ECU
  // is there and will not serve that identifier, or it is there and said nothing —
  // and turning them into HTTP errors would collapse the distinction the codec works
  // hardest to keep. The status is in the body, where the page can render it.
  respond(res, 200, options, outcome.reading, null);
}

function respond(
  res: ServerResponse,
  statusCode: number,
  options: VcuProbeEndpointOptions,
  reading: VcuProbeReading | null,
  message: string | null
): void {
  const payload: VcuProbeResponse = {
    reading,
    message,
    gate: options.runner.gate(),
    targets: PROBE_TARGETS,
  };
  const body = Buffer.from(JSON.stringify(payload), "utf-8");
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(body.length),
    // A live reading off the bike, and a live gate. A cached copy of either would be
    // worse than no answer at all.
    "Cache-Control": "no-store",
  });
  res.end(body);
}
