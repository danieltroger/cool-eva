import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { RunningVersion } from "../version.ts";
import type { RuntimeRelease } from "./metadata.ts";
import { settingsPaths } from "../settings/paths.ts";
import { monotonicNow, since } from "../monotonic.ts";

export async function readBundleVersion(directory: string, metadata: RuntimeRelease): Promise<RunningVersion> {
  let dirty = false;
  let trustworthy = true;
  try {
    await diagnosticCommand("sha256sum", ["--check", "--strict", "--quiet", "files.sha256"], {
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

export function readBundleNotices(
  directory: string,
  updaterDirectory = settingsPaths().updaterDirectory
): Promise<string[]> {
  if (
    noticeCache === null ||
    noticeCache.directory !== directory ||
    noticeCache.updaterDirectory !== updaterDirectory ||
    since(noticeCache.started) >= 60_000
  ) {
    noticeCache = {
      started: monotonicNow(),
      directory,
      updaterDirectory,
      result: loadBundleNotices(directory, updaterDirectory),
    };
  }
  return noticeCache.result;
}

let noticeCache: { started: number; directory: string; updaterDirectory: string; result: Promise<string[]> } | null =
  null;

async function loadBundleNotices(directory: string, updaterDirectory: string): Promise<string[]> {
  const notices: string[] = [];
  let state: unknown;
  try {
    state = JSON.parse(await readFile(join(updaterDirectory, "state.json"), "utf8"));
    const notice = rollbackNotice(state);
    if (notice) {
      notices.push(notice);
    }
  } catch (error) {
    console.warn("version: could not read updater status:", error);
  }
  try {
    const tested = promotedOsPackages(state, basename(await realpath(directory)));
    if (tested !== null) {
      const { stdout } = await diagnosticCommand("dpkg-query", ["-W", "-f=${binary:Package}\t${Version}\n"], {
        timeout: 10_000,
      });
      if (osPackagesChanged(tested, stdout)) {
        notices.push("OS updated since this release was tested");
      }
    }
  } catch (error) {
    console.warn("version: could not compare OS package versions:", error);
  }
  return notices;
}

export function osPackagesChanged(tested: string, installed: string): boolean {
  const versions = new Map<string, string>();
  for (const line of installed.trim().split("\n")) {
    const [name, version] = line.split("\t");
    versions.set(name.replace(/:arm64$/, ""), version);
  }
  for (const line of tested.trim().split("\n")) {
    const [name, version] = line.split("\t");
    const packageName = name.replace(/:arm64$/, "");
    if (
      packageName &&
      /^(bluez|network-manager|raspi-firmware|linux-image-rpi-v8|libc6|libstdc\+\+6|systemd)$/.test(packageName)
    ) {
      if (versions.get(packageName) !== version) return true;
    }
  }
  return false;
}

function promotedOsPackages(state: unknown, target: string): string | null {
  if (state === null || typeof state !== "object" || !("osPackages" in state)) return null;
  const packages = state.osPackages;
  if (packages === null || typeof packages !== "object" || !(target in packages)) return null;
  const baseline = (packages as Record<string, unknown>)[target];
  return typeof baseline === "string" ? baseline : null;
}

export function rollbackNotice(state: unknown): string | null {
  if (state === null || typeof state !== "object" || !("lastRollback" in state)) return null;
  const rollback = state.lastRollback;
  if (rollback === null || typeof rollback !== "object" || !("from" in rollback) || typeof rollback.from !== "string") {
    return null;
  }
  if ("reason" in rollback && rollback.reason === "interrupted") return "Update interrupted — press Update again";
  const edited = "reason" in rollback && rollback.reason === "edited-release-failed" ? " (edited release)" : "";
  return `Rolled back from ${rollback.from}${edited}`;
}

const execFileAsync = promisify(execFile);

function diagnosticCommand(
  executable: string,
  arguments_: string[],
  options: { cwd?: string; timeout: number }
): Promise<{ stdout: string; stderr: string }> {
  // A priority-setup failure must not impersonate sha256sum's exit 1 (edited).
  return execFileAsync(
    "nice",
    [
      "-n",
      "19",
      "sh",
      "-c",
      'ionice -c 3 -p "$$" || exit 125; exec "$@"',
      "cool-eva-version-check",
      executable,
      ...arguments_,
    ],
    options
  );
}
