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
