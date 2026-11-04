// @ts-check
export const INCOMPLETE_RECOVERY_MESSAGE =
  "Recovery incomplete. The connection at the next power-on is unconfirmed. Use previous to retry the saved connection.";

/** @param {import("../../src/wifi/network-types.ts").NetworkChange | null | undefined} change */
export function incompleteRecoveryMessage(change) {
  return change?.fallback
    ? INCOMPLETE_RECOVERY_MESSAGE
    : "Recovery incomplete. The connection at the next power-on is unconfirmed. Use previous to stop the incomplete change.";
}

/** @param {import("../../src/wifi/network-types.ts").NetworkView | null} current */
export function networkRecoveryIncomplete(current) {
  const phase = current?.change?.phase;
  return (
    !!phase &&
    (["restoring", "confirming", "promoting", "identity", "retiring"].includes(phase) ||
      (["trying", "waiting"].includes(phase) && !!current?.message))
  );
}
