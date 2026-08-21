import { createHash } from "crypto";
import type { IncomingMessage, ServerResponse } from "http";
import { FAULT_INFOKEYS } from "../diagnostics/fault-infokeys.ts";
import { INFOKEY_TABLE } from "../diagnostics/infokey-table.ts";

// GET /fault-infokeys — Energica's own "what to look at for this fault" lists, so
// the Faults tab can say what a code means you should go and measure.
//
// An endpoint rather than a JS copy in public/, for exactly the reason
// ./dtc-table.ts gives: the dashboard has no build step and cannot import the
// TypeScript tables, and a hand-maintained duplicate of 944 references would
// drift silently in a direction nobody would notice. The two halves go separately
// (dictionary once, shortlists as id arrays) because inlining costs ~80 kB against
// ~16 kB — docs/diagnostics-and-checks.md §7.5.
//
// ⚠️ It NEVER touches the bus, and it cannot: both tables are static data compiled
// into the process. Nothing on this endpoint tells you what the bike actually
// recorded — for that a freeze frame has to be READ, which nothing in this repo
// does yet (see src/diagnostics/freeze-frame.ts).

/** One of the 120 fields, trimmed to what the dashboard renders. */
export interface InfokeyFieldRow {
  name: string;
  /** Empty for a flag or a status word. */
  unit: string;
  datatype: string;
}

export interface FaultInfokeysPayload {
  /** Infokey id (as a string key) → the field it names. */
  fields: Record<string, InfokeyFieldRow>;
  /**
   * `"44/0"` → the infokey ids for that fault, IN PAYLOAD ORDER.
   *
   * Keyed by component and symptom rather than by OBD code because the OBD column
   * is not unique — `U0182` is both (39,3) and (40,3) — and because that is the
   * key the bike's own active list speaks. A client holding only an OBD code has
   * to resolve it through /dtc-table first, and may legitimately find two.
   */
  shortlists: Record<string, number[]>;
}

export function handleFaultInfokeysEndpoint(req: IncomingMessage, res: ServerResponse): void {
  // Same caching argument as /dtc-table: `no-cache` means revalidate, not "do not
  // store", so a reload costs a 304 and no payload — while a corrected table still
  // reaches a phone that has the old one, which `immutable` would prevent for a day.
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

/** `44, 0` → `"44/0"`. The one place this key is spelled, so both sides cannot disagree. */
export function infokeyShortlistKey(component: number, symptom: number): string {
  return `${component}/${symptom}`;
}

// Exported so scripts/build-service-preview.ts can generate the design preview's stub
// from THIS table rather than a hand-copied one. The header above says why a duplicate
// is unacceptable — "a wrong description still *looks* like an answer" — and a preview
// that names a code wrongly is that failure on the one tab whose job is naming codes.
export function buildPayload(): FaultInfokeysPayload {
  const fields: Record<string, InfokeyFieldRow> = {};
  for (const field of INFOKEY_TABLE) {
    fields[String(field.id)] = { name: field.name, unit: field.unit, datatype: field.datatype };
  }
  const shortlists: Record<string, number[]> = {};
  for (const entry of FAULT_INFOKEYS) {
    // Copied, not aliased: the table's arrays are readonly and shared, and
    // JSON.stringify is the only consumer today — but handing out the live arrays
    // is the kind of thing that stops being harmless the moment someone sorts one.
    shortlists[infokeyShortlistKey(entry.component, entry.symptom)] = [...entry.infokeys];
  }
  return { fields, shortlists };
}

// Serialised once at import: neither table changes at runtime, and this runs on
// the same event loop as the CAN RX handler.
const SERIALISED = Buffer.from(JSON.stringify(buildPayload()), "utf-8");

// Derived from the bytes, so a corrected shortlist ships a new tag automatically.
const ETAG = `"${createHash("sha256").update(SERIALISED).digest("base64url").slice(0, 16)}"`;
