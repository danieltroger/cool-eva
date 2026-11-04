import { execFile, spawn } from "child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { promisify } from "util";
import { replaceFileDurably } from "./durable.ts";

export async function installCapturePruner(archiveGroupName: string): Promise<void> {
  if (process.getuid?.() !== 0) {
    throw new Error("Installing the capture pruner requires root.");
  }
  const rule = capturePruneSudoers(archiveGroupName);
  await mkdir(dirname(CAPTURE_PRUNE_HELPER), { recursive: true, mode: 0o755 });
  await assertRootOwnedAncestors(dirname(CAPTURE_PRUNE_HELPER));
  await assertRootOwnedAncestors(SUDOERS_DIRECTORY);
  const script = await readFile(new URL("./capture-pruner.sh", import.meta.url), "utf-8");
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
      throw new Error(
        `Capture-pruner parent ${current} must be root-owned and not group/world-writable. Repair it before retrying migration.`
      );
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export async function verifyCapturePruner(ownerUid: number): Promise<void> {
  if (!Number.isSafeInteger(ownerUid) || ownerUid < 0) {
    throw new Error("Invalid checkout owner uid.");
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "/usr/bin/sudo",
      ["-n", "-u", `#${ownerUid}`, "--", "/usr/bin/sudo", "-n", CAPTURE_PRUNE_HELPER],
      {
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Capture-pruner stdin preflight timed out; no data was moved."));
    }, 5_000);
    child.stdout.on("data", chunk => {
      output = (output + String(chunk)).slice(-4_096);
    });
    // The fixed probe contains no credentials. The visible fault is intentionally independent of sudo's output.
    child.stderr.on("data", chunk => {
      console.warn("capture-pruner preflight:", String(chunk).trim());
    });
    child.once("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", code => {
      clearTimeout(timer);
      if (code === 0 && output.split(/\r?\n/).includes("COOL_EVA_PRUNE_STDIN_OK")) {
        resolve();
      } else {
        reject(
          new Error(
            "Capture-pruner sudo stdin preflight failed; repair the owner's non-interactive sudo access before migration. No data was moved."
          )
        );
      }
    });
    child.stdin.on("error", error => {
      console.warn("capture-pruner preflight stdin failed:", error.message);
    });
    child.stdin.end("COOL_EVA_STDIN_PROBE\n");
  });
}
