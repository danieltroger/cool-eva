import { lstat, readdir } from "fs/promises";
import { join } from "path";
import { sweepReplacementFiles } from "../storage/replacement-files.ts";
import type { SettingsPaths } from "./paths.ts";
import { assertSettingsWriterLock, type SettingsWriterLock } from "./writer-lock.ts";

export async function sweepArchiveReplacementFiles(paths: SettingsPaths, lock: SettingsWriterLock): Promise<void> {
  assertSettingsWriterLock(lock);
  const existing = new Set((await readdir(paths.dataRoot)).map(name => join(paths.dataRoot, name)));
  for (const directory of [
    paths.rideLogDirectory,
    paths.vcuParameterDirectory,
    paths.wifiDiagnosticDirectory,
    paths.captureDirectory,
  ]) {
    if (existing.has(directory)) {
      await sweepArchiveDirectory(directory, lock);
    }
  }
}

async function sweepArchiveDirectory(directory: string, lock: SettingsWriterLock): Promise<void> {
  assertSettingsWriterLock(lock);
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Archive replacement cleanup requires a real directory.");
  }
  await sweepReplacementFiles(directory);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      await sweepArchiveDirectory(join(directory, entry.name), lock);
    }
  }
}
