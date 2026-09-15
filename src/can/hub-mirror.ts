import { DiagnosticListAssembler, isDiagnosticsInfoMessage, isDiagnosticsMessage } from "../diagnostics/decode.ts";
import { logDiagnosticsSideChannel, logRawDiagnosticsFrame, recordDiagnosticReport } from "../diagnostics/record.ts";

// CAN 0x410 carries the Connectivity-Hub message set byte-for-byte, which makes it a
// second, PASSIVE way to read anything on it — including a diagnostics list, which only
// appears once something has asked for it over Bluetooth. Useful precisely because it
// needs no BLE connection of its own: the hub accepts one at a time and the service
// already holds it.
//
// 🚨 The EMITTER is the instrument cluster, not the hub. docs/can-0x410.md.
//
// Only the two diagnostics types are handled HERE: the GPS multiplex is src/can/gps.ts and
// sub-type 3's drive triple is src/can/hub-output.ts, so this id has three readers and the
// id constant stays GPS_CAN_ID rather than being declared again. src/index.ts hands every
// 0x410 frame to this one, which is why its dispatch deliberately does not return after
// calling it. Why types 2 and 4 stay undecoded, and where the readers are listed:
// docs/can-0x410.md.

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
