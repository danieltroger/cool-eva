import type { ServerResponse } from "http";
import {
  troubleCodeSnapshot,
  type TroubleCodeListState,
  type TroubleCodeRow,
  type TroubleCodeSnapshot,
} from "../diagnostics/stored-codes.ts";

// GET /stored-dtcs — the OBD-II trouble-code lists, so the Faults tab can show the
// 39 codes mode 03 hands over rather than just the number 39.
//
// An endpoint rather than more WebSocket signals: the list is 39 codes that change
// about as often as the bike is serviced, and every signal in liveState is
// re-broadcast whole every 5 seconds (src/ws.ts). Names and descriptions are folded
// in server-side because the codes are keyed by OBD code here, not by the
// (component, symptom) pair /dtc-table is keyed on — see the encoding warning in
// src/diagnostics/obd-dtc.ts. Resolving them in one place is what stops the
// dashboard doing that lookup wrong.
//
// It NEVER touches the bus. It serves whatever the poller last read, so hitting
// refresh cannot make the bike answer questions — `ageMs` is how the page knows how
// old that answer is.

// Re-exported so public/views/faults.js has one place to import the wire shape
// from, the way it already pulls DtcTableRow out of ./dtc-table.ts. checkJs covers
// public/**/*.js, so renaming a field here fails `npm run typecheck` instead of
// showing `undefined` on a card.
export type { TroubleCodeListState, TroubleCodeRow, TroubleCodeSnapshot };

export function handleStoredDtcsEndpoint(res: ServerResponse): void {
  const body = Buffer.from(JSON.stringify(troubleCodeSnapshot()), "utf-8");
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(body.length),
    // Live data with an age in it: a cached copy would put a stale age on screen,
    // which is worse than no age at all. No ETag either — unlike /dtc-table there
    // is nothing content-addressed to revalidate against.
    "Cache-Control": "no-store",
  });
  res.end(body);
}
