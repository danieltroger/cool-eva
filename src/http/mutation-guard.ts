import type { IncomingMessage, ServerResponse } from "http";

export function handleMutationGuard(req: IncomingMessage, res: ServerResponse, path: string): boolean {
  if (path === "/waypoint" && req.method === "GET") {
    const message =
      "No waypoint was saved. Your Siri shortcut needs updating. Open Cool Eva, then Settings, Advanced, Update Siri shortcut.";
    if (String(req.headers.accept ?? "").includes("application/json")) {
      const reply: LegacyWaypointReply = { saved: false, message };
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
    const reply = csrfRefusal(message);
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

export function csrfRefusal(message: string): CsrfRefusal {
  return { ok: false, csrfRefusal: true, message, reason: message };
}

export interface CsrfRefusal {
  ok: false;
  csrfRefusal: true;
  message: string;
  reason: string;
}
interface LegacyWaypointReply {
  saved: false;
  message: string;
}
