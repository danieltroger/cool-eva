// @ts-check
import van from "../vendor/van-1.6.1.js";

export const pageReloadRequired = van.state(false);

/** @param {{status: number}} response */
export function requireCurrentPage(response) {
  if (response.status === 403) {
    pageReloadRequired.val = true;
    throw new Error("Reload the page before trying this action again.");
  }
}
