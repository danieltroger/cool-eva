import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { settingsPaths } from "../settings/paths.ts";

export async function readUpdateStatus(directory = settingsPaths().updaterDirectory): Promise<ReleaseUpdateStatus> {
  const value: unknown = JSON.parse(await readFile(join(directory, "state.json"), "utf8"));
  if (value === null || typeof value !== "object") {
    throw new Error("Invalid updater state");
  }
  const sequence = "sequence" in value && typeof value.sequence === "number" ? value.sequence : 0;
  if (!("status" in value)) return { sequence, running: false, ok: true, message: "Ready to check for an update." };
  const status = value.status;
  if (
    status === null ||
    typeof status !== "object" ||
    !("running" in status) ||
    typeof status.running !== "boolean" ||
    !("ok" in status) ||
    typeof status.ok !== "boolean" ||
    !("message" in status) ||
    typeof status.message !== "string"
  ) {
    throw new Error("Invalid updater status");
  }
  return { sequence, running: status.running, ok: status.ok, message: status.message };
}

export interface ReleaseUpdateStatus {
  sequence: number;
  running: boolean;
  ok: boolean;
  message: string;
}
