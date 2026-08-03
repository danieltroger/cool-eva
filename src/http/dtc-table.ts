import type { ServerResponse } from "http";
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

export function handleDtcTableEndpoint(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(SERIALISED.length),
    // The table is a compile-time constant transcribed from a PDF; it can only
    // change when this binary does. Cache it hard so a garage reload over a phone
    // hotspot doesn't re-fetch 148 entries.
    "Cache-Control": "public, max-age=86400, immutable",
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
