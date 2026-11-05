import type { CanMessage } from "socketcan";

/** Observed PSU-on request; the repeat/stop contract is in docs/psu-hold.md. */
export function psuHoldFrame(): CanMessage {
  return { id: 0x500, ext: false, rtr: false, data: Buffer.from([1, 0, 0, 0, 0, 0, 0, 0]) };
}
