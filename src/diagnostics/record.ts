import { record } from "../can/signals.ts";
import { describeEntry, dtcSignalKey } from "./dtc-table.ts";
import type { DiagnosticCode, DiagnosticReport } from "./decode.ts";

// Turns a decoded diagnostics list into logged signals. Kept out of decode.ts so
// that decoder stays pure and replayable; this is the side-effecting half.
//
// Both transports (Bluetooth and the CAN 0x410 mirror) funnel through here and
// share the "which codes were present last time" state on purpose: they carry
// the same list, so the second one to arrive is a free cross-check that costs
// nothing — record() only writes a row when a value actually changes.

/** Codes seen at least once this run, so a code that clears can be zeroed. */
const seenSignalKeys = new Set<string>();
let lastSignature = "";

// How the pages are numbered is inferred, not documented (see decode.ts), so the
// first list of a run is dumped byte-for-byte. If the assembler never completes
// a list because the hub ends it some other way, this is the only thing in the
// journal that says so — and on a bike parked out of wifi range, a second attempt
// costs a whole trip to the garage.
const RAW_FRAME_LOG_LIMIT = 24;
const rawFramesLogged = new Map<string, number>();

export function recordDiagnosticReport(report: DiagnosticReport, transport: string): void {
  const presentKeys = new Set(report.codes.map(code => dtcSignalKey(code.component, code.symptom)));

  record("dtc_list_count", report.codes.length);
  record("dtc_unrecognised_count", report.codes.filter(code => code.entry === null).length);

  for (const key of presentKeys) {
    seenSignalKeys.add(key);
    record(key, 1);
  }
  // A code that has cleared since the last list has to be written back to 0 —
  // otherwise it would sit at 1 on the dashboard forever.
  for (const key of seenSignalKeys) {
    if (!presentKeys.has(key)) {
      record(key, 0);
    }
  }

  // The list is re-requested on a timer, so only say something when it changes.
  const signature = report.codes.map(code => code.raw).join(",");
  if (signature === lastSignature) {
    return;
  }
  lastSignature = signature;
  console.log(`diagnostics: ${report.codes.length} code(s) over ${report.pages} page(s) via ${transport}`);
  for (const code of report.codes) {
    console.log(`diagnostics:   ${formatCode(code)}`);
  }
}

/** Dumps the first few diagnostics messages of a run verbatim. */
export function logRawDiagnosticsFrame(frame: Uint8Array, transport: string): void {
  const alreadyLogged = rawFramesLogged.get(transport) ?? 0;
  if (alreadyLogged >= RAW_FRAME_LOG_LIMIT) {
    return;
  }
  rawFramesLogged.set(transport, alreadyLogged + 1);
  const hex = Array.from(frame, byte => byte.toString(16).padStart(2, "0")).join(" ");
  console.log(`diagnostics: raw frame via ${transport}: ${hex}`);
}

/**
 * One code as a log line. Always leads with the raw field: until a live list
 * confirms how those 20 bits are laid out, the raw value is the only part of
 * this we know to be true, and it is what makes the reading settleable later.
 */
export function formatCode(code: DiagnosticCode): string {
  const raw = `raw 0x${code.raw.toString(16).padStart(5, "0")}${code.flags ? ` flags 0x${code.flags.toString(16)}` : ""}`;
  if (code.entry && code.matchedBy === "component") {
    return `${raw} · component ${code.component} symptom ${code.symptom} · ${describeEntry(code.entry)}`;
  }
  if (code.entry && code.matchedBy === "obd") {
    return `${raw} · read as OBD code · ${describeEntry(code.entry)}`;
  }
  return `${raw} · unrecognised (component ${code.component} symptom ${code.symptom}, or OBD ${code.obdCodeFromRaw})`;
}
