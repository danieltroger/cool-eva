import { execFile } from "node:child_process";
import type { ServerResponse } from "node:http";
import { promisify } from "node:util";
import type { UpdateReply } from "./update.ts";
import { isBundleRuntime, readReleaseMetadata } from "../release/metadata.ts";
import { readUpdateStatus } from "../release/update-status.ts";

export async function tryBundleUpdate(
  res: ServerResponse,
  directory: string,
  context: BundleUpdateContext = {}
): Promise<boolean> {
  try {
    if (!isBundleRuntime(directory, context.executable) && !(await readReleaseMetadata(directory, context.executable)))
      return false;
    await handleBundleUpdate(res, context.statusDirectory);
  } catch (error) {
    console.warn("update: cannot read bundle identity:", error);
    respond(res, 500, { ok: false, message: "Cannot verify this release. Check its release.json before updating." });
  }
  return true;
}

export interface BundleUpdateContext {
  executable?: string;
  statusDirectory?: string;
}

export async function handleBundleUpdate(res: ServerResponse, statusDirectory?: string): Promise<void> {
  try {
    const previous = await readUpdateStatus(statusDirectory);
    // A separate unit survives stopping this app's cgroup during the trial.
    await execFileAsync("systemctl", ["start", "--no-block", "cool-eva-update.service"], { timeout: 10_000 });
    respond(res, 202, {
      ok: true,
      message: "Checking for an update. The dashboard will reconnect after the release is checked.",
      sequence: previous.running ? previous.sequence : previous.sequence + 1,
    });
  } catch (error) {
    console.warn("update: could not start the bundle updater:", error);
    respond(res, 500, { ok: false, message: "Could not start the update. Check the service log and try again." });
  }
}

export async function handleUpdateStatus(res: ServerResponse): Promise<void> {
  try {
    const status = await readUpdateStatus();
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(status));
  } catch (error) {
    console.warn("update: could not read bundle status:", error);
    respond(res, 503, { ok: false, message: "Update status is unavailable. Check the service log." });
  }
}

const execFileAsync = promisify(execFile);

function respond(res: ServerResponse, status: number, body: UpdateReply): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}
