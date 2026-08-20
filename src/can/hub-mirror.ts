import { DiagnosticListAssembler, isDiagnosticsInfoMessage, isDiagnosticsMessage } from "../diagnostics/decode.ts";
import { logDiagnosticsSideChannel, logRawDiagnosticsFrame, recordDiagnosticReport } from "../diagnostics/record.ts";

// CAN 0x410 is the Connectivity Hub echoing its own Bluetooth messages onto the
// VDB bus byte-for-byte, which makes it a second, PASSIVE way to read anything the
// hub sends — including a diagnostics list, which only appears once something has
// asked for it over Bluetooth. Useful precisely because it needs no BLE connection
// of its own: the hub accepts one at a time and the service already holds it.
//
// Only the two diagnostics types are handled here on purpose. Everything else on
// this ID either duplicates a value we already take from the Bluetooth link or a
// broadcast frame — two sources for one signal can only disagree — or is the GPS
// multiplex, which src/can/gps.ts decodes off these same frames.
//
// So 0x410 is one id with two readers, and the id constant is GPS_CAN_ID over in
// gps.ts rather than being declared a second time here. src/index.ts hands every
// 0x410 frame to both, which is why its dispatch deliberately does not return
// after calling this. Framing evidence: docs/can-decode-findings.md § "0x410".

const assembler = new DiagnosticListAssembler();

/** Feeds one 0x410 frame to the diagnostics decoder; ignores every other type. */
export function handleHubMirrorFrame(data: Buffer): void {
  if (isDiagnosticsInfoMessage(data)) {
    logDiagnosticsSideChannel(data, "can 0x410");
    return;
  }
  if (!isDiagnosticsMessage(data)) {
    return;
  }
  logRawDiagnosticsFrame(data, "can 0x410");
  const report = assembler.push(data);
  if (report) {
    recordDiagnosticReport(report, "can 0x410");
  }
}
