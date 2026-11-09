// @ts-check

/** @param {"read" | "write"} kind
 * @param {Pick<import("../../src/http/vcu-write.ts").VcuWriteResponse, "result" | "message" | "chargeWriteAttempt"> | null} payload
 * @param {string} [message] */
export function chargeFailureText(kind, payload, message = "") {
  const detail = payload?.result?.message ?? payload?.message ?? message;
  const refused = payload?.result === null && payload.chargeWriteAttempt === "not-sent";
  const prefix = kind === "read" ? "Read failed" : refused ? "Not sent" : "Delivery uncertain";
  return `${prefix}: ${failureReason(detail)}`;
}

/** @param {string} message */
function failureReason(message) {
  if (/simulator/i.test(message)) return "disabled in simulator";
  if (/bus.*(?:busy|lease)|using the bus/i.test(message)) return "bike busy";
  if (/could not reach|network|fetch|connection|interrupted response/i.test(message)) return "connection lost";
  if (/no reply|did not answer|timeout|timed out/i.test(message)) return "no reply from bike";
  return message.split(/[.;\n]| — /)[0].trim() || "bike unavailable";
}
