// @ts-check
import van from "../vendor/van-1.6.1.js";

export const pageReloadRequired = van.state(false);

/** @param {Pick<import("./transport.js").EndpointResponse, "status" | "json">} response */
export async function requireCurrentPage(response) {
  if (response.status !== 403) return;
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    console.warn(
      "transport: could not inspect a forbidden response",
      error instanceof Error ? error.name : "unknown error"
    );
    return;
  }
  if (!payload || typeof payload !== "object" || !("csrfRefusal" in payload) || payload.csrfRefusal !== true) return;
  pageReloadRequired.val = true;
  throw new Error("Reload the page before trying this action again.");
}
