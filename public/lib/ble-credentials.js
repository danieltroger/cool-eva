// @ts-check
import { normalizeBleSecret, validBleSecret } from "./ble-secret.js";

/** @param {import("./ble-state.js").BleState} state */
export function storedBleSecret(state) {
  const secret = state.environment.storage.getItem(SECRET_STORAGE_KEY) ?? "";
  return validBleSecret(secret) ? secret : "";
}
/** @param {import("./ble-state.js").BleState} state @param {string} secret */
export function rememberBleSecret(state, secret) {
  state.environment.storage.setItem(SECRET_STORAGE_KEY, normalizeBleSecret(secret));
}
const SECRET_STORAGE_KEY = "cool-eva.ble-secret";
