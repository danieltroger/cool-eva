import type { IncomingMessage, ServerResponse } from "http";
import { flushEncryptedLog } from "../storage/encrypted-log.ts";

export async function handleRecordingFlushEndpoint(
  req: IncomingMessage,
  res: ServerResponse,
  flush = flushEncryptedLog
): Promise<void> {
  if (req.method !== "POST") {
    respond(res, 405, { ok: false, message: "Use POST before downloading the current ride." });
    return;
  }
  if (
    req.headers["x-cool-eva"] !== "recording" ||
    !/^application\/json(?:;|$)/i.test(String(req.headers["content-type"] ?? ""))
  ) {
    respond(res, 403, { ok: false, message: "Use the dashboard to seal the current recording." });
    return;
  }
  try {
    await flush();
    respond(res, 200, { ok: true, message: "Recording sealed for download." });
  } catch (error) {
    console.warn("ride-log: could not seal before download", error);
    respond(res, 500, { ok: false, message: "Recording could not be sealed. Retry after checking the storage fault." });
  }
}
export interface RecordingFlushReply {
  ok: boolean;
  message: string;
}
function respond(res: ServerResponse, status: number, reply: RecordingFlushReply): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(reply));
}
