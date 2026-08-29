import type { IncomingMessage, ServerResponse } from "http";
import { KICK_START_MS, MAX_DUTY_PERCENT, MIN_RUNNING_DUTY_PERCENT } from "../fan/control.ts";
import type { FanController, FanPhase } from "../fan/control.ts";
import type { FanAutomatic, FanMode } from "../fan/auto.ts";
import {
  DC_CURVE_TOP_C,
  FAN_OFF_TEMPERATURE_C,
  FAN_ON_TEMPERATURE_C,
  RIDING_CURVE_TOP_C,
  SPEED_GATE_OFF_KMH,
  SPEED_GATE_ON_KMH,
  TEMPERATURE_GRACE_MS,
  type FanReason,
  type FanTemperatureInput,
} from "../fan/curve.ts";

// /fan — duty control for the cooling fan, manual or automatic.
//
//   GET   what the driver and the curve are doing. Touches no hardware.
//   POST  ?duty=N     command a duty, in whole percent. This SWITCHES TO MANUAL: the
//                     automatic loop would otherwise undo the command on its next tick.
//   POST  ?mode=auto  hand the fan back to the temperature curve.
//   POST  ?mode=manual  keep the duty it has and stop the curve moving it.
//
// POST rather than GET for the same reason /can-restart is a POST: this one spins a fan
// blade, and a prefetch or a crawler must not be able to do that by following a link.
//
// ⚠️ POST alone is not enough: this server sends no Access-Control-* headers and has no
// auth, so `<form method=POST action="http://cool-eva.local/fan?duty=100">` on ANY page
// the rider's phone opens on the hotspot is a SIMPLE request — no preflight, no header,
// and the fan spins. CORS would only stop the attacker READING the reply. So a POST
// wants FAN_HEADER, whose custom name is exactly what forces a preflight this server
// never answers. Its value is not vcu-write.ts's: a caller built for that cannot reach
// this, and this one drives an accessory off the Pi's own GPIO and never touches the bus.
//
// ⚠️ There is deliberately no two-tap arming in front of this any more. It was copied
// from the controls that change the MOTORCYCLE, and this one changes a GPIO on the Pi
// that the next command takes straight back — docs/fan-control.md §"The slider".
//
// Served only when FAN_ENABLED=1: index.ts routes it behind the controller's `configured`
// flag, so a Pi with no fan wired up answers 404 here rather than "not enabled".

/** The header a POST must carry, and a value that is neither of vcu-write.ts's. */
export const FAN_HEADER = "x-cool-eva";

export const FAN_HEADER_VALUE = "fan";

/**
 * The policy the Pi enforces, so the page can label and shape its control from the
 * server's numbers rather than from a second copy of them.
 */
export interface FanLimits {
  minRunningPercent: number;
  maxPercent: number;
  kickStartMs: number;
  /** The automatic curve's own constants — src/fan/curve.ts owns every one of them. */
  curve: {
    onTemperatureC: number;
    offTemperatureC: number;
    ridingTopC: number;
    dcTopC: number;
    speedGateOnKmh: number;
    speedGateOffKmh: number;
    temperatureGraceMs: number;
  };
}

/** What the automatic loop last decided, or nulls while the slider is driving the fan. */
export interface FanAutoReply {
  reason: FanReason | null;
  temperatureInput: FanTemperatureInput | null;
  /** The temperature the decision rested on, which is not necessarily the newest one. */
  temperatureC: number | null;
  /** Milliseconds since the last IN-BOUNDS `batt_temp_hi`, or since the loop started. */
  temperatureAgeMs: number;
}

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
  /** Automatic on every start, and never persisted — see src/fan/auto.ts. */
  mode: FanMode;
  auto: FanAutoReply;
  /** Why the driver is unusable — a missing overlay, no `pinctrl` — or null. */
  fault: string | null;
  limits: FanLimits;
  /** What the last command did, or why it did nothing. Null for a plain GET. */
  message: string | null;
}

export interface FanEndpointOptions {
  controller: FanController;
  automatic: FanAutomatic;
}

export async function handleFanEndpoint(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: FanEndpointOptions
): Promise<void> {
  if (req.method === "GET") {
    respond(res, 200, options, null);
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8", "Allow": "GET, POST" });
    res.end("use GET to see what the fan is doing, POST ?duty=N or ?mode=auto to command it\n");
    return;
  }

  if (req.headers[FAN_HEADER] !== FAN_HEADER_VALUE) {
    // 403 and a plain-text reason, like /vcu-write: the caller that hits this is either
    // `curl` without the header or a cross-origin form, and neither reads JSON.
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`commanding the fan needs the ${FAN_HEADER}: ${FAN_HEADER_VALUE} header\n`);
    return;
  }

  const parsed = parseFanRequest(url.searchParams);
  if (!parsed.ok) {
    // 400, not 409: the request itself is wrong and re-sending it unchanged stays wrong.
    respond(res, 400, options, parsed.reason);
    return;
  }

  const outcome =
    parsed.kind === "mode"
      ? await options.automatic.setMode(parsed.mode)
      : await options.automatic.commandManualDuty(parsed.duty);
  // 503 rather than 500 when the driver itself is unusable: the request was fine, the
  // hardware or its setup is not, and that is the distinction the page reports.
  respond(res, outcome.ok ? 200 : 503, options, outcome.message);
}

export type FanRequest =
  | { ok: true; kind: "duty"; duty: number }
  | { ok: true; kind: "mode"; mode: FanMode }
  | { ok: false; reason: string };

/**
 * Turns a query string into a command, or into a reason. Pure.
 *
 * Whole percent only. A fractional duty is not wrong so much as meaningless here — one
 * percent of a 50 000 ns period is 500 ns, and nothing about this fan resolves finer.
 *
 * ⚠️ `duty` and `mode` together is a 400 rather than a guess about which was meant. A
 * duty already implies manual, so the only reading of `?mode=auto&duty=60` is a caller
 * that thinks one of the two does something it does not.
 */
export function parseFanRequest(params: URLSearchParams): FanRequest {
  const rawMode = params.get("mode");
  const rawDuty = params.get("duty");
  const hasMode = rawMode !== null && rawMode.trim().length > 0;
  const hasDuty = rawDuty !== null && rawDuty.trim().length > 0;

  if (hasMode && hasDuty) {
    return { ok: false, reason: "pass duty=<percent> OR mode=auto|manual, not both — a duty already means manual" };
  }
  if (hasMode) {
    const mode = rawMode.trim().toLowerCase();
    if (mode === "auto" || mode === "automatic") {
      return { ok: true, kind: "mode", mode: "automatic" };
    }
    if (mode === "manual") {
      return { ok: true, kind: "mode", mode: "manual" };
    }
    return { ok: false, reason: `mode must be auto or manual, not ${rawMode}` };
  }
  if (!hasDuty) {
    return { ok: false, reason: `how much? pass duty=<0…${MAX_DUTY_PERCENT}> in whole percent, or mode=auto` };
  }

  const duty = Number(rawDuty.trim());
  if (!Number.isInteger(duty)) {
    return { ok: false, reason: `duty must be a whole number of percent, not ${rawDuty}` };
  }
  if (duty < 0 || duty > MAX_DUTY_PERCENT) {
    return {
      ok: false,
      reason:
        `duty must be 0…${MAX_DUTY_PERCENT}, not ${duty}. Anything under ${MIN_RUNNING_DUTY_PERCENT} stops the ` +
        `fan rather than commanding a crawl it may stall at.`,
    };
  }
  return { ok: true, kind: "duty", duty };
}

function respond(res: ServerResponse, statusCode: number, options: FanEndpointOptions, message: string | null): void {
  const state = options.controller.state();
  const auto = options.automatic.state();
  const payload: FanReply = {
    dutyPercent: state.dutyPercent,
    targetPercent: state.targetPercent,
    driverEnabled: state.driverEnabled,
    phase: state.phase,
    mode: auto.mode,
    auto: {
      reason: auto.decision?.reason ?? null,
      temperatureInput: auto.decision?.temperatureInput ?? null,
      temperatureC: auto.decision?.temperatureC ?? null,
      temperatureAgeMs: Math.round(auto.temperatureAgeMs),
    },
    fault: options.controller.fault,
    limits: {
      minRunningPercent: MIN_RUNNING_DUTY_PERCENT,
      maxPercent: MAX_DUTY_PERCENT,
      kickStartMs: KICK_START_MS,
      curve: {
        onTemperatureC: FAN_ON_TEMPERATURE_C,
        offTemperatureC: FAN_OFF_TEMPERATURE_C,
        ridingTopC: RIDING_CURVE_TOP_C,
        dcTopC: DC_CURVE_TOP_C,
        speedGateOnKmh: SPEED_GATE_ON_KMH,
        speedGateOffKmh: SPEED_GATE_OFF_KMH,
        temperatureGraceMs: TEMPERATURE_GRACE_MS,
      },
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
