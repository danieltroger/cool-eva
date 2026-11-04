import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { RunningVersion } from "../version.ts";
import type { RuntimeRelease } from "./metadata.ts";
import { settingsPaths } from "../settings/paths.ts";
import { monotonicNow, since } from "../monotonic.ts";

export async function readBundleVersion(directory: string, metadata: RuntimeRelease): Promise<RunningVersion> {
  let dirty = false;
  let trustworthy = true;
  try {
    await execFileAsync("sha256sum", ["--check", "--strict", "--quiet", "files.sha256"], {
      cwd: directory,
      timeout: 30_000,
    });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === 1) {
      dirty = true;
    } else {
      console.warn("version: could not verify the release inventory:", error);
      trustworthy = false;
    }
  }
  const commit = metadata.commit.slice(0, 7);
  const suffix = trustworthy ? (dirty ? "+edited" : "") : "+unverified";
  return { commit, dirty, trustworthy, label: `${metadata.branch}@${commit}${suffix}` };
}

export function readBundleNotices(directory: string): Promise<string[]> {
  if (noticeCache === null || since(noticeCache.started) >= 60_000) {
    noticeCache = { started: monotonicNow(), result: loadBundleNotices(directory) };
  }
  return noticeCache.result;
}

let noticeCache: { started: number; result: Promise<string[]> } | null = null;

async function loadBundleNotices(directory: string): Promise<string[]> {
  const notices: string[] = [];
  try {
    const tested = await readFile(join(directory, "tested-os-packages.txt"), "utf8");
    const { stdout } = await execFileAsync("dpkg-query", ["-W", "-f=${binary:Package}\t${Version}\n"], {
      timeout: 10_000,
    });
    if (osPackagesChanged(tested, stdout)) {
      notices.push("OS updated since this release was tested");
    }
  } catch (error) {
    console.warn("version: could not compare OS package versions:", error);
  }
  try {
    const status: unknown = JSON.parse(await readFile(join(settingsPaths().updaterDirectory, "state.json"), "utf8"));
    const notice = rollbackNotice(status);
    if (notice) {
      notices.push(notice);
    }
  } catch (error) {
    console.warn("version: could not read updater status:", error);
  }
  return notices;
}

export function osPackagesChanged(tested: string, installed: string): boolean {
  const versions = new Map<string, string>();
  for (const line of installed.trim().split("\n")) {
    const [name, version] = line.split("\t");
    versions.set(name.replace(/:arm64$/, ""), version);
  }
  for (const line of tested.split("\n")) {
    const match = /^ii\s+(\S+)\s+(\S+)/.exec(line);
    const packageName = match?.[1].replace(/:arm64$/, "");
    if (
      match &&
      packageName &&
      /^(bluez|network-manager|raspi-firmware|linux-image-rpi-v8|libc6|libstdc\+\+6|systemd)$/.test(packageName)
    ) {
      if (versions.get(packageName) !== match[2]) return true;
    }
  }
  return false;
}

export function rollbackNotice(state: unknown): string | null {
  if (state === null || typeof state !== "object" || !("lastRollback" in state)) return null;
  const rollback = state.lastRollback;
  if (rollback === null || typeof rollback !== "object" || !("from" in rollback) || typeof rollback.from !== "string")
    return null;
  if ("reason" in rollback && rollback.reason === "interrupted") return "Update interrupted — press Update again";
  const edited = "reason" in rollback && rollback.reason === "edited-release-failed" ? " (edited release)" : "";
  return `Rolled back from ${rollback.from}${edited}`;
}

const execFileAsync = promisify(execFile);
