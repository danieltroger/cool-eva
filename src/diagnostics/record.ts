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
// Bounded because one confirmed code is not a survey of the 20-bit field (see
// decode.ts). If it really is a code everywhere, the set stops at however many
// distinct faults the bike has. If some other component's slot turns out to hold
// a counter or a timestamp instead, every report brings new keys — up to 200 a
// minute — and record() puts every one of them into liveState, which ws.ts
// broadcasts whole every 5 seconds. So past the
// cap a code is named in the journal but NOT recorded: bounding this set alone
// would not bound that. 256 is far above any plausible list (MAX_PAGES caps one
// report at 200 codes) and far below a leak; hitting it says the reading is
// wrong, so it says so out loud.
const SEEN_SIGNAL_KEY_LIMIT = 256;
let warnedSeenKeyLimit = false;
// null, not "": an empty list has an empty signature too, and starting at ""
// would swallow the one line saying the bike reported no codes at all.
let lastSignature: string | null = null;

// How the pages are numbered is inferred, not documented (see decode.ts), so the
// first list of a run is dumped byte-for-byte. If the assembler never completes
// a list because the hub ends it some other way, this is the only thing in the
// journal that says so — and on a bike parked out of wifi range, a second attempt
// costs a whole trip to the garage.
const RAW_FRAME_LOG_LIMIT = 24;
const rawFramesLogged = new Map<string, number>();

// Type 31 has no known meaning and is logged once per distinct payload, so a
// constant one costs a single line per boot but a change is impossible to miss.
// Capped like the raw dump above: two identical samples 60 s apart is thin
// evidence that six unknown bytes are constant, and if one of them is a counter
// or a session token then "once per distinct payload" is once a minute forever.
const SIDE_CHANNEL_PAYLOAD_LIMIT = 24;
const sideChannelPayloadsLogged = new Set<string>();
let warnedSideChannelLimit = false;

export function recordDiagnosticReport(report: DiagnosticReport, transport: string): void {
  const presentKeys = new Set(report.codes.map(diagnosticSignalKey));

  record("dtc_list_count", report.codes.length);
  record("dtc_unrecognised_count", report.codes.filter(code => code.entry === null).length);

  for (const key of presentKeys) {
    if (seenSignalKeys.size < SEEN_SIGNAL_KEY_LIMIT) {
      seenSignalKeys.add(key);
    } else if (!seenSignalKeys.has(key)) {
      // Stop at the cap instead of recording: record() writes into liveState for
      // any key at all, and liveState ships whole in the 5-second WS snapshot, so
      // a key recorded here would outlive this loop in memory and on the wire.
      // The journal line below still names the code, raw field and both readings,
      // which is where the evidence for settling the layout lives.
      if (!warnedSeenKeyLimit) {
        warnedSeenKeyLimit = true;
        console.warn(
          `diagnostics: more than ${SEEN_SIGNAL_KEY_LIMIT} distinct code keys this run — the 20-bit ` +
            "code field is almost certainly not (component, symptom). Codes past this point are still " +
            "named in the journal below but are no longer recorded as signals."
        );
      }
      continue;
    }
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
 * Logs the type-31 message the hub sends alongside the code list, once per
 * distinct payload. Nothing decodes it yet — see decode.ts for what is known.
 */
export function logDiagnosticsSideChannel(frame: Uint8Array, transport: string): void {
  const hex = Array.from(frame, byte => byte.toString(16).padStart(2, "0")).join(" ");
  if (sideChannelPayloadsLogged.size >= SIDE_CHANNEL_PAYLOAD_LIMIT) {
    // Reaching the cap IS the result: this message is logged at all only because
    // its payload might vary, so say so rather than going quiet — silence here
    // would otherwise look identical to the constant payload we expect.
    if (!warnedSideChannelLimit) {
      warnedSideChannelLimit = true;
      console.warn(
        `diagnostics: type-31 payload has taken ${SIDE_CHANNEL_PAYLOAD_LIMIT} distinct values this ` +
          "run — it is not the constant it looked like; no longer logging it."
      );
    }
    return;
  }
  if (sideChannelPayloadsLogged.has(hex)) {
    return;
  }
  sideChannelPayloadsLogged.add(hex);
  console.log(`diagnostics: type-31 message via ${transport}: ${hex}`);
}

/**
 * The signal key one code is logged under.
 *
 * Keyed on the matched table row, not on `code.component`: that field is the raw
 * low 16 bits, which only equals the table's COD. column under the component
 * reading of the 20 bits. When the OBD reading is the one that matched, keying on
 * the raw field would produce something like `dtc_4166_0` while src/can/registry.ts
 * generated `dtc_0049_0` from that very same table row — the signal would land in
 * `misc` with no unit, and one fault would end up as two series if the readings
 * ever swapped. A code neither reading names has no row, so it keeps the
 * raw-derived key; that is the only case where the key depends on the reading.
 */
function diagnosticSignalKey(code: DiagnosticCode): string {
  if (code.entry) {
    return dtcSignalKey(code.entry.component, code.entry.symptom);
  }
  return dtcSignalKey(code.component, code.symptom);
}

/**
 * One code as a log line. Always leads with the raw field: the layout is settled
 * on a single code (see decode.ts), and the raw value is the one part of this
 * that stays true whichever reading ends up naming a future code.
 */
export function formatCode(code: DiagnosticCode): string {
  const raw = `raw 0x${code.raw.toString(16).padStart(5, "0")}${code.flags ? ` flags 0x${code.flags.toString(16)}` : ""}`;
  if (code.entry && code.matchedBy === "component") {
    return `${raw} · component ${code.component} symptom ${code.symptom} · ${describeEntry(code.entry)}`;
  }
  if (code.entry && code.matchedBy === "obd") {
    // Name the table row's own component/symptom too: that pair, not the raw
    // field, is what the signal key is built from (see diagnosticSignalKey).
    return `${raw} · read as OBD code · component ${code.entry.component} symptom ${code.entry.symptom} · ${describeEntry(code.entry)}`;
  }
  return `${raw} · unrecognised (component ${code.component} symptom ${code.symptom}, or OBD ${code.obdCodeFromRaw})`;
}
