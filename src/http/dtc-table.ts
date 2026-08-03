import { createHash } from "crypto";
import type { IncomingMessage, ServerResponse } from "http";
import { DTC_TABLE, dtcSignalKey } from "../diagnostics/dtc-table.ts";

// GET /dtc-table — Energica's code table, so the dashboard can say
// "P0A07 — Water pump open circuit fault" instead of "0044/0".
//
// Why an endpoint rather than a JS copy in public/: the dashboard has no build
// step, so it cannot import the TypeScript table, and a hand-maintained JS
// duplicate of 148 transcribed codes would drift silently the first time one is
// corrected — in a direction nobody would notice, because a wrong description
// still *looks* like an answer.
//
// Keyed by SIGNAL KEY and built with the same `dtcSignalKey()` the recorder uses,
// so the two sides cannot disagree about padding. If that function changes, both
// the logged key and this map change with it.

export interface DtcTablePayload {
  /** `dtc_0044_0` → the code's meaning. */
  codes: Record<string, DtcTableRow>;
}

export interface DtcTableRow {
  component: number;
  symptom: number;
  obdCode: string;
  name: string;
  description: string;
  illuminatesMil: boolean;
}

export function handleDtcTableEndpoint(req: IncomingMessage, res: ServerResponse): void {
  // Deliberately NOT `immutable`. This URL is not content-addressed, so that would
  // be a promise the server cannot keep: browsers honour it hard — Safari and Chrome
  // skip revalidation even on an explicit reload — and the first time a transcribed
  // description is corrected, every phone that has opened the Faults tab would keep
  // serving the old text for a day with no in-app way to clear it. `git pull` +
  // restart would look like it did nothing, which is a bad thing to be debugging in
  // a garage with no reception.
  //
  // `no-cache` means "revalidate", not "don't store": a reload costs a 304 and no
  // payload, which is what the garage-over-a-hotspot case actually needed.
  if (req.headers["if-none-match"] === ETAG) {
    res.writeHead(304, { ETag: ETAG, "Cache-Control": "no-cache" });
    res.end();
    return;
  }
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(SERIALISED.length),
    ETag: ETAG,
    "Cache-Control": "no-cache",
  });
  res.end(SERIALISED);
}

function buildPayload(): DtcTablePayload {
  const codes: Record<string, DtcTableRow> = {};
  for (const entry of DTC_TABLE) {
    codes[dtcSignalKey(entry.component, entry.symptom)] = {
      component: entry.component,
      symptom: entry.symptom,
      obdCode: entry.obdCode,
      name: entry.name,
      description: entry.description,
      illuminatesMil: entry.illuminatesMil,
    };
  }
  return { codes };
}

// Serialised once at import: the table never changes at runtime, and this runs on
// the same event loop as the CAN RX handler.
const SERIALISED = Buffer.from(JSON.stringify(buildPayload()), "utf-8");

// Derived from the bytes, so a corrected description ships a new tag automatically
// and no deploy step has to remember to bump anything.
const ETAG = `"${createHash("sha256").update(SERIALISED).digest("base64url").slice(0, 16)}"`;
