// @ts-check
/** @param {import("../../src/charge/acknowledge.ts").ChargeAckVerdict|null} verdict @returns {number|string} */
export function chargeReply(verdict) {
  if (verdict === null) return "—";
  switch (verdict.kind) {
    case "took":
      return verdict.toAmps;
    case "not-acknowledged":
      return verdict.heldAmps;
    case "station-limited":
      return verdict.gotAmps;
    case "no-change-expected":
      return verdict.atAmps;
    case "waiting":
      return "Waiting";
    case "superseded":
      return "Replaced";
    case "no-evidence":
      return "Unknown";
  }
}

/** @param {number} amps @param {Pick<import("../../src/http/vcu-write.ts").VcuWriteResponse,"result"|"message"|"chargeCurrentAttempt">} payload */
export function chargeAttemptText(amps, payload) {
  const detail = payload.result?.message ?? payload.message ?? "";
  if (payload.result) return `${amps} A request: ${detail}`;
  return payload.chargeCurrentAttempt === "not-sent"
    ? `${amps} A request NOT sent. ${detail}`
    : `${amps} A request: delivery uncertain. ${detail} Check the bike before retrying.`;
}
