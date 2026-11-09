// @ts-check

/** @param {import("./service-edits.js").ParameterAttempt | null} outcome */
export function parameterReadFailureText(outcome) {
  return outcome?.kind === "read-failed" ? `Read failed: ${shortReason(outcome.reason ?? "")}` : "";
}

/** @param {string} reason */
export function backupImportFailureText(reason) {
  return `Import failed: ${shortReason(reason)}`;
}

/** @param {boolean} canWrite @param {import("../../src/vcu/write-runner.ts").VcuWriteStatus|null} status */
export function parameterWriteBlockText(canWrite, status) {
  if (canWrite) return "";
  if (!status) return "Bike unavailable";
  if (!status.enabled) return "Writes disabled";
  if (!status.gate.safe) return "Park to confirm";
  if (status.busHeldBy !== null) return "Bike busy";
  if (!status.tableGate.writesAllowed) {
    return status.tableGate.noReadWillHelp ? "Table unsupported" : "Table unconfirmed";
  }
  return "Write unavailable";
}

/** @param {string} reason */
function shortReason(reason) {
  if (/simulator/i.test(reason)) return "disabled in simulator";
  if (/parameter read unavailable/i.test(reason)) return "bike unavailable";
  if (/refus/i.test(reason)) return "bike refused read";
  if (/could not reach|network|fetch|connection/i.test(reason)) return "connection lost";
  return reason.split(/[.;\n]| — /)[0].trim() || "bike unavailable";
}
