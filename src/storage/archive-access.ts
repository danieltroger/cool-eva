import { chmod, mkdir } from "fs/promises";
import { dirname, resolve } from "path";
import { settingsPaths, type SettingsPaths } from "../settings/paths.ts";

export async function ensureArchiveDirectory(directory: string): Promise<void> {
  const root = managedArchiveRoot(directory);
  await mkdir(directory, { recursive: true, ...(root ? { mode: 0o750 } : {}) });
  if (!root) return;
  let current = resolve(directory);
  while (current !== dirname(root)) {
    await chmod(current, 0o2750);
    current = dirname(current);
  }
}

export function configureArchiveAccess(paths: SettingsPaths = settingsPaths()): void {
  archiveRoots = [
    paths.rideLogDirectory,
    paths.vcuParameterDirectory,
    paths.wifiDiagnosticDirectory,
    paths.captureDirectory,
  ].map(path => resolve(path));
}

export function managedArchiveFileMode(path: string): number | undefined {
  return managedArchiveRoot(path) ? 0o640 : undefined;
}

let archiveRoots: string[] = [];
configureArchiveAccess();

function managedArchiveRoot(path: string): string | undefined {
  const absolute = resolve(path);
  return archiveRoots.find(root => absolute === root || absolute.startsWith(`${root}/`));
}
