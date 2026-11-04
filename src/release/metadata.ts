import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { record } from "../settings/schema.ts";

export async function readReleaseMetadata(
  directory: string,
  executable = process.execPath
): Promise<RuntimeRelease | null> {
  let contents: string;
  try {
    contents = await readFile(join(directory, "release.json"), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      if (isBundleRuntime(directory, executable)) {
        throw new Error("The bundle release metadata is missing");
      }
      return null;
    }
    throw error;
  }
  const value = record(JSON.parse(contents), "release metadata");
  if (
    value.format !== 1 ||
    value.updaterProtocol !== 1 ||
    value.platform !== "linux-arm64" ||
    typeof value.release !== "string" ||
    !/^(main|branch-[a-z0-9.-]+)-[a-f0-9]{40}$/.test(value.release) ||
    typeof value.commit !== "string" ||
    !/^[a-f0-9]{40}$/.test(value.commit) ||
    typeof value.channel !== "string" ||
    !/^(main|branch-[a-z0-9.-]+)$/.test(value.channel) ||
    value.release !== `${value.channel}-${value.commit}` ||
    typeof value.branch !== "string" ||
    !Number.isSafeInteger(value.settingsSchemaVersion) ||
    Number(value.settingsSchemaVersion) < 1
  ) {
    throw new Error("Invalid release metadata");
  }
  return {
    release: value.release,
    commit: value.commit,
    channel: value.channel,
    branch: value.branch,
    settingsSchemaVersion: Number(value.settingsSchemaVersion),
  };
}

export function isBundleRuntime(directory: string, executable = process.execPath): boolean {
  return resolve(executable) === resolve(directory, "runtime/bin/node");
}

export interface RuntimeRelease {
  release: string;
  commit: string;
  channel: string;
  branch: string;
  settingsSchemaVersion: number;
}
