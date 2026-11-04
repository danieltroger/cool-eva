import type { IncomingMessage, ServerResponse } from "http";

export function handleMutationGuard(req: IncomingMessage, res: ServerResponse, path: string): boolean {
  if (path === "/waypoint" && req.method === "GET") {
    const message =
      "This shortcut needs updating. Use POST and the Cool Eva header; see the dashboard. No waypoint was saved.";
    if (String(req.headers.accept ?? "").includes("application/json")) {
      const reply: LegacyWaypointReply = { saved: false, message: `Reload the page. ${message}` };
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(reply));
    } else {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      res.end(message);
    }
    return true;
  }
  if (
    (!["GET", "HEAD"].includes(req.method ?? "GET") || path === "/waypoint") &&
    (!req.headers["x-cool-eva"] || !/^application\/json(?:;|$)/i.test(String(req.headers["content-type"] ?? "")))
  ) {
    const message = "Reload the page before trying this action again.";
    const reply: MutationRefusal = { ok: false, message, reason: message };
    res.writeHead(403, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(reply));
    return true;
  }
  if (path === "/waypoint" && (req.method !== "POST" || req.headers["x-cool-eva"] !== "waypoint")) {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Save waypoints with POST from the dashboard.");
    return true;
  }
  return false;
}

interface MutationRefusal {
  ok: false;
  message: string;
  reason: string;
}
interface LegacyWaypointReply {
  saved: false;
  message: string;
}
