import type { IncomingMessage, ServerResponse } from "http";

// A ServerResponse that records what a handler wrote instead of writing it, and — the
// part that matters — NEVER EMITS "finish".
//
// ⚠️ THAT IS A SAFETY PROPERTY, NOT A CONVENIENCE. src/http/update.ts arms the service
// restart on the response's "finish" event, so a real http.ServerResponse under a check
// would spawn `sudo systemctl restart cool-eva` on whatever machine ran `npm test`. It
// counts the listeners instead, so "we avoided the restart" is a checked property rather
// than a hope: check-update-endpoint.ts §1 asserts one was armed and §2/§3 that none was.
//
// Its own module, and a PURE MOVE out of check-update-endpoint.ts, because that file has
// no exports and runs its whole suite at module scope — importing it would execute the
// update check inside whatever imported it. Two checks now stand on this recorder, and a
// safety property with two copies has two chances to drift.
//
// ⚠️ `once()` counts "finish" SPECIFICALLY. Generalising it to every event would make
// check-update-endpoint.ts's `finishListeners === 1` stop meaning anything.

export interface RecordingResponse {
  res: ServerResponse;
  statusCode: number | null;
  headers: Record<string, string>;
  body: string;
  finishListeners: number;
}

/**
 * `as unknown as ServerResponse` rather than an `any`, the same way
 * scripts/check-ride-log-status.ts fakes one.
 */
export function recordingResponse(): RecordingResponse {
  const recorded: RecordingResponse = {
    res: null as unknown as ServerResponse,
    statusCode: null,
    headers: {},
    body: "",
    finishListeners: 0,
  };
  recorded.res = {
    writeHead(statusCode: number, headers?: Record<string, string>) {
      recorded.statusCode = statusCode;
      Object.assign(recorded.headers, headers ?? {});
    },
    end(chunk?: string | Buffer) {
      if (chunk) {
        recorded.body = chunk.toString();
      }
    },
    once(event: string) {
      if (event === "finish") {
        recorded.finishListeners += 1;
      }
    },
  } as unknown as ServerResponse;
  return recorded;
}

/**
 * The request half of the same pair. Here rather than in either check because both call it
 * with recordingResponse() in the same expression, and it was written twice before this.
 */
export function postRequest(headers: Record<string, string> = {}): IncomingMessage {
  return { method: "POST", headers } as unknown as IncomingMessage;
}
