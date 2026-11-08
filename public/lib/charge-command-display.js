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

/** @param {number|null} attemptedAmps @param {number|null} latestRequest @param {import("../../src/charge/ack-watch.ts").ChargeAckState|null} acknowledgement */
export function chargeConfirmationText(attemptedAmps, latestRequest, acknowledgement) {
  if (attemptedAmps === null || latestRequest !== attemptedAmps || acknowledgement === null) return "Waiting for bike…";
  const verdict = acknowledgement.verdict;
  if (verdict.kind === "took")
    return verdict.toAmps === attemptedAmps ? `Bike confirmed ${verdict.toAmps} A` : "Waiting for bike…";
  if (verdict.kind === "no-change-expected")
    return verdict.atAmps === attemptedAmps ? `Bike confirmed ${verdict.atAmps} A` : "Waiting for bike…";
  if (verdict.kind === "not-acknowledged") return `${attemptedAmps} A · Not confirmed`;
  if (verdict.kind === "station-limited") return "Station limited";
  if (verdict.kind === "no-evidence" || verdict.kind === "superseded") return "Delivery uncertain";
  return "Waiting for bike…";
}
