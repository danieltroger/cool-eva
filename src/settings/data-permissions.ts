import { chmod, chown, lstat, open, readdir } from "fs/promises";
import { join } from "path";
import { syncDirectory } from "../storage/durable.ts";

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
      const handle = await open(path, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } else {
      throw new Error("A legacy archive contains a link or special file; migration needs an explicit choice.");
    }
  }
  await syncDirectory(directory);
}
