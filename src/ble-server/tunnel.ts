import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from "http";
import type { Bytes, RequestHeader } from "../../public/lib/ble-wire.js";

// Carries one dashboard request from BLE to this process's own HTTP server on loopback,
// and the answer back. A tunnel rather than a second set of handlers: every route in
// src/index.ts, every header gate in src/http/*, the write runner's locks and audit —
// all of it applies to a BLE request because it IS an HTTP request by the time it is
// handled. docs/ble-server.md §"Why a tunnel".

/** Uploads are tiny (query strings, a few JSON bodies); anything bigger is not ours. */
export const MAX_REQUEST_BODY_BYTES = 16 * 1024;

/** A response body is cut into chunks this size, each sealed as its own message. */
export const RESPONSE_CHUNK_BYTES = 4 * 1024;

/**
 * Longer than any endpoint takes over wifi: a VCU sweep (/vcu-read) runs for tens of
 * seconds before it answers. A hung handler must not hold a tunnel slot for ever.
 */
export const REQUEST_TIMEOUT_MS = 180_000;

/** Headers the tunnel owns. The phone may not set them, and they are not sent back. */
const HOP_HEADERS = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive", "upgrade"]);

export interface TunnelSink {
  head: (status: number, headers: Record<string, string>) => Promise<void>;
  body: (chunk: Bytes) => Promise<void>;
  end: (error?: string) => Promise<void>;
}

/**
 * Resolves once `sink.end` has been called — on success, on a loopback failure, and on a
 * timeout alike, so the caller can free the slot without a second code path. A sink that
 * throws (the session it was writing to has ended) aborts the loopback request.
 */
export async function forwardRequest(
  port: number,
  header: RequestHeader,
  body: Bytes,
  sink: TunnelSink
): Promise<void> {
  if (typeof header.path !== "string" || !header.path.startsWith("/")) {
    await sink.head(400, { "content-type": "text/plain; charset=utf-8" });
    await sink.end("path must start with /");
    return;
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(header.headers ?? {})) {
    if (typeof value === "string" && !HOP_HEADERS.has(name.toLowerCase())) {
      headers[name.toLowerCase()] = value;
    }
  }
  if (body.length > 0) {
    headers["content-length"] = String(body.length);
  }

  let incoming: IncomingMessage;
  try {
    incoming = await openLoopbackRequest(port, header, headers, body);
  } catch (error) {
    console.warn(`ble-server: tunnel ${header.method} ${header.path} failed on loopback: ${(error as Error).message}`);
    await sink.head(502, { "content-type": "text/plain; charset=utf-8" });
    await sink.end(`loopback request failed: ${(error as Error).message}`);
    return;
  }

  // Pulled with `for await` rather than on("data"), so each chunk waits for the sink —
  // and the sink waits for the radio. A push loop would read a multi-megabyte /dl off
  // loopback in a second and hold all of it in memory while BLE took minutes to send it.
  try {
    await sink.head(incoming.statusCode ?? 502, flattenHeaders(incoming.headers));
    for await (const chunk of incoming as AsyncIterable<Buffer>) {
      for (let offset = 0; offset < chunk.length; offset += RESPONSE_CHUNK_BYTES) {
        await sink.body(new Uint8Array(chunk.subarray(offset, offset + RESPONSE_CHUNK_BYTES)));
      }
    }
  } catch (error) {
    incoming.destroy();
    console.log(`ble-server: tunnel ${header.method} ${header.path} cut short: ${(error as Error).message}`);
    await sink.end(`response cut short: ${(error as Error).message}`);
    return;
  }
  await sink.end();
}

function openLoopbackRequest(
  port: number,
  header: RequestHeader,
  headers: Record<string, string>,
  body: Bytes
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: header.method || "GET",
        path: header.path,
        headers,
        timeout: REQUEST_TIMEOUT_MS,
      },
      resolve
    );
    outgoing.on("timeout", () => {
      outgoing.destroy(new Error(`no answer in ${REQUEST_TIMEOUT_MS / 1000} s`));
    });
    // After resolve this still fires for a socket that dies mid-body; the body loop sees
    // that as the stream erroring, so here it only needs to not be an uncaught `error`.
    outgoing.on("error", reject);
    outgoing.end(body.length > 0 ? Buffer.from(body) : undefined);
  });
}

function flattenHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_HEADERS.has(name)) continue;
    flat[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return flat;
}
