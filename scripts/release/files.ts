import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readlink, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

export function selectSourcePaths(trackedPaths: string[]): string[] {
  const buildFiles = new Set(["package-lock.json", ".npmrc", "install.sh"]);
  const selected = trackedPaths.filter(
    path => isRuntimeSourcePath(path) || path.startsWith("scripts/release/") || buildFiles.has(path)
  );
  for (const path of selected) {
    validateArchivePath(path);
  }
  for (const required of [
    "package.json",
    "package-lock.json",
    "LICENSE",
    "src/index.ts",
    "install.sh",
    "scripts/release/inputs.json",
  ]) {
    if (!selected.includes(required)) {
      throw new Error(`Source archive is missing ${required}`);
    }
  }
  return selected.sort();
}

export const RUNTIME_SCRIPTS = [
  "scripts/can-capture/capture.sh",
  "scripts/update/run.sh",
  "scripts/update/common.sh",
  "scripts/update/settings.sh",
  "scripts/update/download.sh",
  "scripts/update/lifecycle.sh",
  "scripts/update/helpers.sh",
  "scripts/update/dispatch.sh",
  "scripts/update/launch.sh",
  "scripts/update/os-update-ready.sh",
  "scripts/update/cool-eva.service",
  "scripts/update/cool-eva-update.service",
  "scripts/update/cool-eva-rollback.service",
  "scripts/update/cool-eva-update-repair.service",
] as const;

export function isRuntimeSourcePath(path: string): boolean {
  return (
    path.startsWith("src/") ||
    path.startsWith("public/") ||
    path === "package.json" ||
    path === "LICENSE" ||
    RUNTIME_SCRIPTS.some(script => script === path)
  );
}

export function validateArchivePath(path: string): void {
  if (
    isAbsolute(path) ||
    /[\r\n\\\0]/.test(path) ||
    path.split("/").some(part => part === ".." || part === "." || part === "")
  ) {
    throw new Error(`Unsafe bundle path: ${path}`);
  }
  if (
    /\.private\.pem$|\.celog$|(?:^|\/)(?:ride-logs|vcu-params|wifi-diag|ride-captures|captures|\.git)(?:\/|$)/.test(
      path
    )
  ) {
    throw new Error(`Persistent or private material cannot enter a bundle: ${path}`);
  }
}

export async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export async function writeFileInventory(directory: string): Promise<void> {
  const files = await listBundleFiles(directory, directory);
  const inventory: string[] = [];
  for (const path of files.sort()) {
    if (path === "files.sha256") {
      continue;
    }
    inventory.push(`${await hashFile(join(directory, path))}  ${path}`);
  }
  await writeFile(join(directory, "files.sha256"), inventory.join("\n") + "\n", { mode: 0o644 });
}

async function listBundleFiles(root: string, directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    const relativePath = relative(root, path);
    validateArchivePath(relativePath);
    const details = await lstat(path);
    if (details.isSymbolicLink()) {
      const target = await readlink(path);
      const resolved = relative(root, resolve(directory, target));
      if (isAbsolute(target) || resolved === ".." || resolved.startsWith("../")) {
        throw new Error(`Bundle symlink escapes its release: ${relativePath}`);
      }
      files.push(relativePath);
    } else if (details.isDirectory()) {
      files.push(...(await listBundleFiles(root, path)));
    } else if (details.isFile()) {
      files.push(relativePath);
    } else {
      throw new Error(`Bundle contains a special file: ${relativePath}`);
    }
  }
  return files;
}
