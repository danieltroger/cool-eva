import { execFile } from "child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { promisify } from "util";
import { replaceFileDurably } from "../../src/storage/durable.ts";

export async function installCapturePruner(archiveGroupName: string): Promise<void> {
  if (process.getuid?.() !== 0) {
    throw new Error("Installing the capture pruner requires root.");
  }
  const rule = capturePruneSudoers(archiveGroupName);
  await mkdir(dirname(CAPTURE_PRUNE_HELPER), { recursive: true, mode: 0o755 });
  await assertRootOwnedAncestors(dirname(CAPTURE_PRUNE_HELPER));
  await assertRootOwnedAncestors(SUDOERS_DIRECTORY);
  const script = await readFile(new URL("./prune-helper.sh", import.meta.url), "utf-8");
  await replaceFileDurably(CAPTURE_PRUNE_HELPER, script, { mode: 0o755, userId: 0, groupId: 0 });
  const directory = await mkdtemp(join(SUDOERS_DIRECTORY, ".cool-eva-prune-"));
  try {
    const candidate = join(directory, "rule");
    await writeFile(candidate, rule, { mode: 0o440 });
    await chmod(candidate, 0o440);
    await execFileAsync("visudo", ["-cf", candidate]);
    await replaceFileDurably(join(SUDOERS_DIRECTORY, "cool-eva-prune-captures"), rule, {
      mode: 0o440,
      userId: 0,
      groupId: 0,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export const CAPTURE_PRUNE_HELPER = "/usr/local/libexec/cool-eva-prune-captures";
const SUDOERS_DIRECTORY = "/etc/sudoers.d";
const execFileAsync = promisify(execFile);

export function capturePruneSudoers(archiveGroupName: string): string {
  if (!/^[a-z_][a-z0-9_-]*[$]?$/i.test(archiveGroupName)) {
    throw new Error("The archive group needs a valid system group name.");
  }
  return `%${archiveGroupName} ALL=(root) NOPASSWD: ${CAPTURE_PRUNE_HELPER} ""\n`;
}

async function assertRootOwnedAncestors(directory: string): Promise<void> {
  let current = directory;
  for (;;) {
    const metadata = await lstat(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== 0 || (metadata.mode & 0o022) !== 0) {
      throw new Error("The capture pruner requires root-owned, non-writable parent directories.");
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
