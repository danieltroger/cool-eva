import type { IncomingMessage, ServerResponse } from "http";
import { KICK_START_MS, MAX_DUTY_PERCENT, MIN_RUNNING_DUTY_PERCENT } from "../fan/control.ts";
import type { FanController, FanPhase } from "../fan/control.ts";

// /fan — manual duty control for the cooling fan.
//
//   GET   what the driver is doing. Touches no hardware.
//   POST  ?duty=N  command a duty, in whole percent. Below the minimum this stops the fan.
//
// POST rather than GET for the same reason /can-restart is a POST: this one spins a fan
// blade, and a prefetch or a crawler must not be able to do that by following a link.
//
// ⚠️ POST alone is not enough, and the two-tap arming in public/views/fan.js protects
// nothing here: this server sends no Access-Control-* headers and has no auth, so
// `<form method=POST action="http://cool-eva.local/fan?duty=100">` on ANY page the
// rider's phone opens on the hotspot is a SIMPLE request — no preflight, no header, and
// the fan spins. CORS would only stop the attacker READING the reply. So a POST wants
// FAN_HEADER, whose custom name is exactly what forces a preflight this server never
// answers. Its value is not vcu-write.ts's: a caller built for that cannot reach this,
// and this one drives an accessory off the Pi's own GPIO and never touches the bus.
//
// Served only when FAN_ENABLED=1: index.ts routes it behind the controller's `configured`
// flag, so a Pi with no fan wired up answers 404 here rather than "not enabled".

/** The header a POST must carry, and a value that is neither of vcu-write.ts's. */
export const FAN_HEADER = "x-cool-eva";

export const FAN_HEADER_VALUE = "fan";

/**
 * What the endpoint says, for the caller that acts on it. A named type imported through
 * JSDoc in public/views/fan.js, for the reason CLAUDE.md gives about DashboardMessage:
 * the dashboard has no build step, so this is what stops the two ends drifting.
 */
export interface FanReply {
  /** The duty the bridge is being given, in percent. 100 for the length of a kick-start. */
  dutyPercent: number;
  /** The duty that was asked for, which a kick-start briefly overrides. */
  targetPercent: number;
  /** Whether both IBT-2 enables are HIGH. False means standby: every FET off. */
  driverEnabled: boolean;
  phase: FanPhase;
  /** Why the driver is unusable — a missing overlay, no `pinctrl` — or null. */
  fault: string | null;
  /** The policy the Pi enforces, so the page labels its control from the server's numbers. */
  limits: { minRunningPercent: number; maxPercent: number; kickStartMs: number };
  /** What the last command did, or why it did nothing. Null for a plain GET. */
  message: string | null;
}

export interface FanEndpointOptions {
  controller: FanController;
}

export async function handleFanEndpoint(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: FanEndpointOptions
): Promise<void> {
  if (req.method === "GET") {
    respond(res, 200, options.controller, null);
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8", "Allow": "GET, POST" });
    res.end("use GET to see what the fan is doing, POST ?duty=N to command it\n");
    return;
  }

  if (req.headers[FAN_HEADER] !== FAN_HEADER_VALUE) {
    // 403 and a plain-text reason, like /vcu-write: the caller that hits this is either
    // `curl` without the header or a cross-origin form, and neither reads JSON.
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`commanding the fan needs the ${FAN_HEADER}: ${FAN_HEADER_VALUE} header\n`);
    return;
  }

  const parsed = parseDutyRequest(url.searchParams);
  if (!parsed.ok) {
    // 400, not 409: the request itself is wrong and re-sending it unchanged stays wrong.
    respond(res, 400, options.controller, parsed.reason);
    return;
  }

  const outcome = await options.controller.setDutyPercent(parsed.duty);
  // 503 rather than 500 when the driver itself is unusable: the request was fine, the
  // hardware or its setup is not, and that is the distinction the page reports.
  respond(res, outcome.ok ? 200 : 503, options.controller, outcome.message);
}

/**
 * Turns a query string into a duty, or into a reason. Pure.
 *
 * Whole percent only. A fractional duty is not wrong so much as meaningless here — one
 * percent of a 50 000 ns period is 500 ns, and nothing about this fan resolves finer.
 */
export function parseDutyRequest(params: URLSearchParams): { ok: true; duty: number } | { ok: false; reason: string } {
  const raw = params.get("duty");
  if (raw === null || raw.trim().length === 0) {
    return { ok: false, reason: `how much? pass duty=<0…${MAX_DUTY_PERCENT}> in whole percent` };
  }
  const duty = Number(raw.trim());
  if (!Number.isInteger(duty)) {
    return { ok: false, reason: `duty must be a whole number of percent, not ${raw}` };
  }
  if (duty < 0 || duty > MAX_DUTY_PERCENT) {
    return {
      ok: false,
      reason:
        `duty must be 0…${MAX_DUTY_PERCENT}, not ${duty}. Anything under ${MIN_RUNNING_DUTY_PERCENT} stops the ` +
        `fan rather than commanding a crawl it may stall at.`,
    };
  }
  return { ok: true, duty };
}

function respond(res: ServerResponse, statusCode: number, controller: FanController, message: string | null): void {
  const state = controller.state();
  const payload: FanReply = {
    dutyPercent: state.dutyPercent,
    targetPercent: state.targetPercent,
    driverEnabled: state.driverEnabled,
    phase: state.phase,
    fault: controller.fault,
    limits: {
      minRunningPercent: MIN_RUNNING_DUTY_PERCENT,
      maxPercent: MAX_DUTY_PERCENT,
      kickStartMs: KICK_START_MS,
    },
    message,
  };
  const body = Buffer.from(JSON.stringify(payload), "utf-8");
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(body.length),
    // A live phase and a live fault. A cached copy of either would describe a fan that
    // has since stopped, which is the one thing this must not do.
    "Cache-Control": "no-store",
  });
  res.end(body);
}
