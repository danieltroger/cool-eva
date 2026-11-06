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

// The HTTPS origins allowed to open the Bluetooth link, one per line. The key lives in the origin's
// localStorage, so each must be an exact origin dedicated to this dashboard alone: no path, trailing
// slash or wildcard, no shared host (a <user>.github.io serves every Pages site on that account)
// and no preview. Fork owners add theirs here.
export const HOSTED_BLE_ORIGINS = [
  "https://cool-eva.athegen.com", // GitHub Pages custom domain, .github/workflows/pages.yml
];
export const BLE_ORIGIN_MESSAGE = "Bluetooth needs its own address";
