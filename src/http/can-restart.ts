import type { IncomingMessage, ServerResponse } from "http";
import { restartCanLink } from "../can/restart.ts";

// POST /can-restart — re-up can0 after the link has dropped.
//
// The dashboard's recovery button when the CAN dot goes red. It runs the two `ip link`
// commands (src/can/restart.ts restartCanLink) and nothing else: it touches the Pi's own
// interface, never the bike's bus at the frame level. POST rather than GET so a prefetch
// or a crawler cannot re-initialise the bus by following a link.

/**
 * What the endpoint says, for the caller that acts on it. A named type imported through
 * JSDoc in public/views/sheet.js, for the reason CLAUDE.md gives about DashboardMessage:
 * the dashboard has no build step, so this is what stops the two ends drifting.
 */
export interface CanRestartReply {
  ok: boolean;
  message: string;
}

/**
 * The header a POST must carry, and a value that is no other endpoint's.
 *
 * ⚠️ A CSRF barrier, not authentication — the same reason ./update.ts has one. POST alone
 * is not enough: this server sends no `Access-Control-*` headers and has no auth, so a bare
 * cross-origin `<form method="POST" action="http://cool-eva.local/can-restart">` is a SIMPLE
 * request that drops the bus. A custom header NAME forces a preflight nothing here answers.
 */
export const CAN_RESTART_HEADER = "x-cool-eva";

export const CAN_RESTART_HEADER_VALUE = "can-restart";

export async function handleCanRestartEndpoint(
  req: IncomingMessage,
  res: ServerResponse,
  iface: string
): Promise<void> {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8", "Allow": "POST" });
    res.end("POST to restart the CAN bus\n");
    return;
  }
  if (req.headers[CAN_RESTART_HEADER] !== CAN_RESTART_HEADER_VALUE) {
    // 403 and plain text, like /fan and /update: a caller here is `curl` without the
    // header or a cross-origin form, and neither reads JSON.
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`restarting the CAN link needs the ${CAN_RESTART_HEADER}: ${CAN_RESTART_HEADER_VALUE} header\n`);
    return;
  }
  try {
    await restartCanLink(iface);
    respond(res, 200, { ok: true, message: `${iface} restarted at 500 kbit/s.` });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.warn(`can-restart: ${iface} restart failed:`, detail);
    respond(res, 500, { ok: false, message: `Restart failed: ${detail}` });
  }
}

function respond(res: ServerResponse, statusCode: number, reply: CanRestartReply): void {
  const body = Buffer.from(JSON.stringify(reply), "utf-8");
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(body.length),
    "Cache-Control": "no-store",
  });
  res.end(body);
}
