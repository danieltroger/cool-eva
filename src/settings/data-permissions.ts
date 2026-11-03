import { chmod, chown, lstat, readdir } from "fs/promises";
import { join } from "path";
import { syncFilesystems } from "../storage/durable.ts";

export async function normaliseArchivePermissions(directory: string, archiveGroupId: number): Promise<void> {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("An archive directory must be a real directory.");
  }
  const ownerId = process.getuid?.();
  if (ownerId === undefined) {
    throw new Error("Archive permissions require a POSIX system.");
  }
  await chown(directory, ownerId, archiveGroupId);
  await chmod(directory, 0o2750);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await normaliseArchivePermissions(path, archiveGroupId);
    } else if (entry.isFile()) {
      if ((await lstat(path)).nlink !== 1) {
        throw new Error("A legacy archive contains a hard link; migration needs an explicit choice.");
      }
      await chown(path, ownerId, archiveGroupId);
      await chmod(path, 0o640);
    } else {
      throw new Error("A legacy archive contains a link or special file; migration needs an explicit choice.");
    }
  }
}

export async function validateArchiveTree(directory: string): Promise<void> {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new UnsafeArchiveError();
  }
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    const entry = await lstat(path);
    if (entry.isDirectory()) {
      await validateArchiveTree(path);
    } else if (!entry.isFile() || entry.nlink !== 1) {
      throw new UnsafeArchiveError();
    }
  }
}

export async function flushArchivePermissions(): Promise<void> {
  const failure = await syncFilesystems();
  if (failure !== null) {
    throw new Error(`Archive permissions could not be flushed: ${failure}`);
  }
}

export class UnsafeArchiveError extends Error {
  readonly code = "unsafe-archive";

  constructor() {
    super("A legacy archive contains a symlink, hard link or special file. Repair it before retrying the data move.");
    this.name = "UnsafeArchiveError";
  }
}
