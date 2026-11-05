import type { IncomingMessage, ServerResponse } from "http";
import type { PsuHold, PsuHoldAction, PsuHoldStatus } from "../psu/hold.ts";
import { SERVICE_WRITE_HEADER, SERVICE_WRITE_HEADER_VALUE } from "./vcu-write.ts";
import { csrfRefusal } from "./mutation-guard.ts";

export function handlePsuHoldEndpoint(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  hold: PsuHold
): void {
  if (request.method === "GET") {
    respond(response, 200, { state: hold.status(), ok: true, message: "" });
    return;
  }
  if (request.method !== "POST") {
    response.setHeader("Allow", "GET, POST");
    respond(response, 405, { state: hold.status(), ok: false, message: "Use GET or POST." });
    return;
  }
  if (
    !request.headers[SERVICE_WRITE_HEADER] ||
    !/^application\/json(?:;|$)/i.test(String(request.headers["content-type"] ?? ""))
  ) {
    const message = "Reload the page before trying this action again.";
    respond(response, 403, { state: hold.status(), ...csrfRefusal(message) });
    return;
  }
  if (request.headers[SERVICE_WRITE_HEADER] !== SERVICE_WRITE_HEADER_VALUE) {
    respond(response, 403, { state: hold.status(), ok: false, message: "PSU hold needs the service-write header." });
    return;
  }
  const action = url.searchParams.get("action");
  if (action !== "stop" && url.searchParams.get("instance") !== hold.status().instance) {
    respond(response, 409, {
      state: hold.status(),
      ok: false,
      message: "The service restarted. Read the current hold and confirm again.",
    });
    return;
  }
  const revision = url.searchParams.get("revision");
  if (
    (action !== "start" && action !== "stop" && action !== "extend") ||
    url.searchParams.get("confirm") !== `psu-hold-${action}` ||
    (action !== "stop" && (revision === null || !/^\d+$/.test(revision) || !Number.isSafeInteger(Number(revision))))
  ) {
    respond(response, 400, {
      state: hold.status(),
      ok: false,
      message: "Confirm a start, stop or extend action; starting or extending also needs the current revision.",
    });
    return;
  }
  const result = hold.perform(action as PsuHoldAction, action === "stop" ? 0 : Number(revision));
  respond(response, result.statusCode, result);
}

export interface PsuHoldReply {
  state: PsuHoldStatus;
  ok: boolean;
  message: string;
  csrfRefusal?: true;
  reason?: string;
}

function respond(response: ServerResponse, status: number, reply: PsuHoldReply): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(reply));
}
