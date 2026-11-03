import { chmod, chown, lstat, mkdir } from "fs/promises";
import { dirname, resolve } from "path";
import { syncDirectory } from "../storage/durable.ts";
import type { SettingsPaths } from "./paths.ts";

export async function prepareSettingsDirectories(paths: SettingsPaths, archiveGroupId: number): Promise<void> {
  if (!Number.isSafeInteger(archiveGroupId) || archiveGroupId < 0) {
    throw new Error("The archive group id is invalid.");
  }
  await ensureDirectory(paths.dataRoot, 0o750, archiveGroupId);
  await ensureDirectory(paths.privateDirectory, 0o700);
  await ensureDirectory(paths.updaterDirectory, 0o700);
}

export async function prepareArchiveDirectories(paths: SettingsPaths, archiveGroupId: number): Promise<void> {
  for (const directory of [
    paths.rideLogDirectory,
    paths.vcuParameterDirectory,
    paths.wifiDiagnosticDirectory,
    paths.captureDirectory,
  ]) {
    // setgid keeps new archives readable by the owner's group without making the directory owner-writable.
    await ensureDirectory(directory, 0o2750, archiveGroupId);
  }
}

export async function ensureDirectory(directory: string, mode: number, groupId?: number): Promise<void> {
  const firstCreated = await mkdir(directory, { recursive: true, mode });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("A settings directory must be a real directory, not a link.");
  }
  const ownerId = process.getuid?.();
  if (ownerId === undefined) {
    throw new Error("Settings directory ownership requires a POSIX system.");
  }
  const desiredGroup = groupId ?? process.getgid!();
  const ownershipChanged = metadata.uid !== ownerId || metadata.gid !== desiredGroup;
  if (ownershipChanged) {
    await chown(directory, ownerId, desiredGroup);
  }
  if (ownershipChanged || (metadata.mode & 0o7777) !== mode) {
    await chmod(directory, mode);
  }
  if (firstCreated !== undefined) {
    const stopAt = dirname(resolve(firstCreated));
    let current = resolve(directory);
    while (current !== stopAt) {
      await syncDirectory(dirname(current));
      current = dirname(current);
    }
  }
  await syncDirectory(directory);
}
