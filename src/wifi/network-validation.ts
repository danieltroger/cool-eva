import { validUuid } from "./network-ledger.ts";
import { validNetworkPassword } from "../../public/lib/network-input.js";
import { NetworkRefusal, type NetworkDraft } from "./network-types.ts";

export function validateNetworkDraft(draft: NetworkDraft): void {
  if (
    !draft ||
    typeof draft.ssid !== "string" ||
    Buffer.byteLength(draft.ssid) < 1 ||
    Buffer.byteLength(draft.ssid) > 32 ||
    /[\x00-\x1f\x7f]/.test(draft.ssid)
  ) {
    throw new NetworkRefusal("Use a network name between 1 and 32 bytes without control characters.");
  }
  if (
    !["home", "hotspot"].includes(draft.purpose) ||
    !["keep", "change"].includes(draft.passwordMode) ||
    !(draft.replacedUuid === null || validUuid(draft.replacedUuid)) ||
    typeof draft.hidden !== "boolean" ||
    typeof draft.accessPointChange !== "boolean" ||
    typeof draft.bluetoothTested !== "boolean"
  ) {
    throw new NetworkRefusal("Choose a network purpose, password mode and valid saved profile.");
  }
  if (draft.passwordMode === "keep" && !draft.replacedUuid) {
    throw new NetworkRefusal("Enter the password for a new network.");
  }
  if (draft.passwordMode === "change" && !validNetworkPassword(draft.password)) {
    throw new NetworkRefusal("Enter a password of 8–63 ASCII characters or 64 hexadecimal digits.");
  }
}
