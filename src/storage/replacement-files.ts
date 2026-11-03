import { readdir, unlink } from "fs/promises";
import { join } from "path";
import { syncDirectory } from "./durable.ts";

// Caller holds the writer lock; otherwise a temporary file may still be in use.
export async function sweepReplacementFiles(directory: string): Promise<number> {
  const entries = await readdir(directory, { withFileTypes: true });
  let removed = 0;
  for (const entry of entries) {
    if (entry.isFile() && REPLACEMENT_NAME.test(entry.name)) {
      await unlink(join(directory, entry.name));
      removed += 1;
    }
  }
  if (removed > 0) {
    await syncDirectory(directory);
    console.warn(`durable: removed ${removed} interrupted replacement file(s) from ${directory}`);
  }
  return removed;
}

const REPLACEMENT_NAME = /^\.cool-eva-replace-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;
