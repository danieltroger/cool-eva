// @ts-check
import { BLE_ORIGIN_MESSAGE } from "./ble-origin.js";
import { normalizeBleSecret } from "./ble-secret.js";

/** @param {import("./ble-state.js").BleState} state */
export function storedBleSecret(state) {
  if (!bleOriginAllowed(state)) {
    purgeBleSecret(state);
    return "";
  }
  return state.environment.storage.getItem(SECRET_STORAGE_KEY) ?? "";
}
/** @param {import("./ble-state.js").BleState} state @param {string} secret */
export function rememberBleSecret(state, secret) {
  requireBleOrigin(state);
  state.environment.storage.setItem(SECRET_STORAGE_KEY, normalizeBleSecret(secret));
}
/** @param {import("./ble-state.js").BleState} state */
export function bleOriginAllowed(state) {
  if (!state.allowed) return false;
  if (state.environment.url.protocol !== "cooleva:") return true;
  const shell = state.environment.shell();
  return shell?.platform === "ios" && typeof shell.saveFile === "function";
}
/** @param {import("./ble-state.js").BleState} state */
export function requireBleOrigin(state) {
  if (!bleOriginAllowed(state)) {
    throw new Error(BLE_ORIGIN_MESSAGE);
  }
}
/** @param {import("./ble-state.js").BleState} state */
export function purgeBleSecret(state) {
  try {
    state.environment.storage.removeItem(SECRET_STORAGE_KEY);
  } catch (error) {
    console.warn("ble: could not remove key from unsupported origin", error);
  }
}
const SECRET_STORAGE_KEY = "cool-eva.ble-secret";
