// @ts-check

import { request } from "./transport.js";

/** @typedef {import("../../src/release/update-status.ts").ReleaseUpdateStatus} ReleaseUpdateStatus */

/**
 * A release trial stops HTTP briefly. Keep polling through that gap and show the updater's
 * result after reconnecting; accepting a queued systemd job is not a successful update.
 * @param {number} sequence
 * @param {(status: ReleaseUpdateStatus) => void} report
 */
export async function followUpdate(sequence, report) {
  const started = performance.now();
  let connectionWarningLogged = false;
  while (performance.now() - started < 31 * 60_000) {
    await new Promise(resolve => setTimeout(resolve, 2_000));
    try {
      const response = await request("/update-status");
      if (!response.ok) {
        throw new Error(`Update status HTTP ${response.status}`);
      }
      const status = /** @type {ReleaseUpdateStatus} */ (await response.json());
      if (status.sequence < sequence) continue;
      report(status);
      if (!status.running) return;
    } catch (error) {
      if (!connectionWarningLogged) {
        console.warn("update: waiting for the dashboard to reconnect:", error);
        connectionWarningLogged = true;
      }
    }
  }
  throw new Error("The update has not reported a result. Reconnect to the Pi and try again.");
}
