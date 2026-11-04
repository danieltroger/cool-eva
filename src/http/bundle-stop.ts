import type { IncomingMessage, ServerResponse } from "node:http";
import { readSettingsBody, reserveSettingsRestart, type SettingsHttpContext } from "./settings.ts";

export async function handleBundleStop(
  request: IncomingMessage,
  response: ServerResponse,
  settings: SettingsHttpContext
): Promise<void> {
  if (
    request.method !== "POST" ||
    request.headers["x-cool-eva"] !== "update" ||
    !/^application\/json(?:;|$)/i.test(String(request.headers["content-type"] ?? "")) ||
    !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "")
  ) {
    respond(response, 403, false, "Only the local bundle updater can reserve this stop.");
    return;
  }
  try {
    const body = await readSettingsBody(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("Invalid stop request.");
    }
    const fields = Object.keys(body);
    if (fields.some(field => !["expectedGeneration", "revision", "bluetoothCodeId"].includes(field))) {
      throw new Error("Unsupported stop request.");
    }
    // The confirmation belongs to this process. A restart during download requires a new confirmation.
    const intent = fields.length
      ? { body: body as Record<string, unknown>, bluetooth: false }
      : stopIntents.get(settings);
    if (!intent) {
      throw new Error("Read settings and press Update again.");
    }
    request.headers["x-cool-eva-tunnel"] = intent.bluetooth ? "1" : undefined;
    if (!(await reserveSettingsRestart(request, intent.body, settings))) {
      throw new Error("The process changed or another restart is reserved.");
    }
    respond(response, 200, true, "Stop reserved until SIGTERM.");
  } catch (error) {
    const reason = error instanceof Error ? error.message : "The stop could not be reserved.";
    console.warn("update: stop refused:", reason);
    respond(response, 409, false, `Park and try again. ${reason}`);
  }
}

export function rememberBundleStop(
  settings: SettingsHttpContext,
  request: IncomingMessage,
  body: Record<string, unknown>
): () => void {
  const previous = stopIntents.get(settings);
  const intent = {
    body: { ...body },
    bluetooth:
      request.headers["x-cool-eva-tunnel"] === "1" &&
      ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? ""),
  };
  stopIntents.set(settings, intent);
  return () => {
    if (stopIntents.get(settings) !== intent) return;
    if (previous) {
      stopIntents.set(settings, previous);
    } else {
      stopIntents.delete(settings);
    }
  };
}

const stopIntents = new WeakMap<SettingsHttpContext, { body: Record<string, unknown>; bluetooth: boolean }>();

function respond(response: ServerResponse, status: number, ok: boolean, message: string): void {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify({ ok, message }));
}
