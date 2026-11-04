// @ts-check

import { requireCurrentPage } from "./page-reload.js";
import { BLE_MODE, nativeShell, tunnelRequest } from "./ble-link.js";

// How the dashboard reaches the Pi's endpoints: `fetch` when the page was served by the
// Pi, the BLE tunnel on the hosted HTTPS dashboard or iOS app (./ble-link.js BLE_MODE).
// Every endpoint call in public/ goes through request() — a stray `fetch` would work
// on wifi and 404 against the static host, only failing once the rider is away from wifi.

/**
 * The part of `Response` the dashboard actually uses. Narrow on purpose, so the tunnel's
 * answer can satisfy it without impersonating the whole Fetch API.
 * @typedef {object} EndpointResponse
 * @property {boolean} ok
 * @property {number} status
 * @property {() => Promise<unknown>} json
 * @property {() => Promise<string>} text
 * @property {() => Promise<Blob>} blob
 */

/**
 * @typedef {object} EndpointRequestInit
 * @property {string} [method]
 * @property {HeadersInit} [headers]
 * @property {string} [body]
 * @property {RequestCache} [cache] honoured over HTTP; the tunnel never caches anyway
 * @property {(receivedBytes: number, totalBytes: number | null) => void} [onProgress] BLE only
 */

/**
 * @param {string} path absolute path on the Pi, query string included
 * @param {EndpointRequestInit} [init]
 * @returns {Promise<EndpointResponse>}
 */
export async function request(path, init = {}) {
  if (init.method && !["GET", "HEAD"].includes(init.method)) {
    init = { ...init, headers: { "Content-Type": "application/json", ...init.headers } };
  }
  if (!BLE_MODE) {
    const { onProgress: _unused, ...fetchInit } = init;
    const response = await fetch(path, fetchInit);
    if (response.status === 403) {
      await requireCurrentPage(response.clone());
    }
    return response;
  }
  const answer = await tunnelRequest(path, init);
  const contentType = answer.headers["content-type"] ?? "";
  const response = {
    ok: answer.status >= 200 && answer.status < 300,
    status: answer.status,
    json: async () => JSON.parse(new TextDecoder().decode(answer.body)),
    text: async () => new TextDecoder().decode(answer.body),
    blob: async () => new Blob([answer.body], { type: contentType }),
  };
  await requireCurrentPage(response);
  return response;
}

/**
 * Saves a file the Pi serves. Over HTTP a plain navigation, so the browser's own download
 * manager handles a large ride log (pausing, backgrounding, progress) better than this
 * page could. Over BLE there is nothing to navigate to, so the file is pulled through the
 * tunnel into memory and handed to the browser as a blob.
 * @param {string} path
 * @param {string} fileName used only when the Pi's Content-Disposition names none
 * @param {(receivedBytes: number, totalBytes: number | null) => void} [onProgress]
 */
export async function download(path, fileName, onProgress) {
  if (!BLE_MODE) {
    location.href = path;
    return;
  }
  const answer = await tunnelRequest(path, { onProgress });
  if (answer.status < 200 || answer.status >= 300) {
    throw new Error(`${path} answered ${answer.status}: ${new TextDecoder().decode(answer.body)}`);
  }
  const disposition = /filename="([^"]+)"/.exec(answer.headers["content-disposition"] ?? "");
  const name = disposition?.[1] ?? fileName;
  const mimeType = answer.headers["content-type"] ?? "application/octet-stream";
  // WKWebView ignores `<a download>` on a blob, so inside the iOS app the bytes go to
  // the native share sheet instead — Save to Files, AirDrop to the laptop.
  const shell = nativeShell();
  if (shell !== undefined) {
    await shell.saveFile(name, answer.body, mimeType);
    return;
  }
  const blob = new Blob([answer.body], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoked late: some browsers read the blob after click() returns.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
