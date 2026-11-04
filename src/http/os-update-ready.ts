import type { IncomingMessage, ServerResponse } from "node:http";
import type { OsUpdateGate } from "../os-updates.ts";

export function handleOsUpdateReady(request: IncomingMessage, response: ServerResponse, gate: OsUpdateGate): void {
  const local =
    request.method === "GET" &&
    !Object.hasOwn(request.headers, "x-cool-eva-tunnel") &&
    ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "");
  response.writeHead(local ? 200 : 403, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify({ ok: local && gate.ready() }));
}
