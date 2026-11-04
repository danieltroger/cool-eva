// @ts-check

/** @param {URL} url */
export function allowedBleOrigin(url) {
  if (url.protocol === "cooleva:" && url.hostname === "app" && url.port === "") {
    return true;
  }
  if (
    (url.protocol === "http:" || url.protocol === "https:") &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
    url.searchParams.get("transport") === "ble"
  ) {
    return true;
  }
  return url.protocol === "https:" && HOSTED_BLE_ORIGINS.includes(url.origin);
}

// Fork owners add their exact exclusive origin here; paths and wildcards do not isolate storage.
export const HOSTED_BLE_ORIGINS = ["https://cool-eva-dashboard.cool-eva.workers.dev"];
export const BLE_ORIGIN_MESSAGE = "Bluetooth needs its own address";
