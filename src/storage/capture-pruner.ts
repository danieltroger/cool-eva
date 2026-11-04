import { execFile, spawn } from "child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { promisify } from "util";
import { replaceFileDurably } from "./durable.ts";

export async function installCapturePruner(
  archiveGroupName: string,
  options: PrunerInstallOptions = {}
): Promise<void> {
  const paths = options.paths ?? capturePrunerPaths();
  const inspect = options.inspect ?? inspectDirectory;
  const replace = options.replace ?? replaceFileDurably;
  if ((options.userId?.() ?? process.getuid?.()) !== 0) {
    throw new Error("Installing the capture pruner requires root.");
  }
  const rule = capturePruneSudoers(archiveGroupName, paths.helper);
  await mkdir(dirname(paths.helper), { recursive: true, mode: 0o755 });
  await assertRootOwnedAncestors(dirname(paths.helper), inspect);
  await assertRootOwnedAncestors(paths.sudoersDirectory, inspect);
  const script = await readFile(new URL("./capture-pruner.sh", import.meta.url), "utf-8");
  await replace(paths.helper, script, { mode: 0o755, userId: 0, groupId: 0 });
  const directory = await mkdtemp(join(paths.sudoersDirectory, ".cool-eva-prune-"));
  try {
    const candidate = join(directory, "rule");
    await writeFile(candidate, rule, { mode: 0o440 });
    await chmod(candidate, 0o440);
    await (options.run ?? runPrunerCommand)("visudo", ["-cf", candidate]);
    await replace(join(paths.sudoersDirectory, "cool-eva-prune-captures"), rule, {
      mode: 0o440,
      userId: 0,
      groupId: 0,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export const CAPTURE_PRUNE_HELPER = "/usr/local/libexec/cool-eva-prune-captures";
const execFileAsync = promisify(execFile);

export function capturePruneSudoers(archiveGroupName: string, helper = CAPTURE_PRUNE_HELPER): string {
  if (!/^[a-z_][a-z0-9_-]*[$]?$/i.test(archiveGroupName)) {
    throw new Error("The archive group needs a valid system group name.");
  }
  return `%${archiveGroupName} ALL=(root) NOPASSWD: ${helper} ""\n`;
}

async function assertRootOwnedAncestors(
  directory: string,
  inspect: (path: string) => Promise<DirectoryAccess>
): Promise<void> {
  let current = directory;
  for (;;) {
    const metadata = await inspect(current);
    if (!metadata.directory || metadata.symlink || metadata.userId !== 0 || (metadata.mode & 0o022) !== 0) {
      throw new Error(
        `Capture-pruner parent ${current} must be root-owned and not group/world-writable. Repair it before retrying migration.`
      );
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export async function verifyCapturePruner(ownerUid: number, options: PrunerProbeOptions = {}): Promise<void> {
  if (!Number.isSafeInteger(ownerUid) || ownerUid < 0) {
    throw new Error("Invalid checkout owner uid.");
  }
  const helper = (options.paths ?? capturePrunerPaths()).helper;
  const result = await (options.probe ?? runPrunerProbe)(
    "/usr/bin/sudo",
    ["-n", "-u", `#${ownerUid}`, "--", "/usr/bin/sudo", "-n", helper],
    "COOL_EVA_STDIN_PROBE\n"
  );
  if (result.code !== 0 || !result.stdout.split(/\r?\n/).includes("COOL_EVA_PRUNE_STDIN_OK")) {
    throw new Error(
      "Capture-pruner sudo stdin preflight failed; repair the owner's non-interactive sudo access before migration. No data was moved."
    );
  }
}

async function runPrunerProbe(
  command: string,
  arguments_: string[],
  input: string
): Promise<{ code: number | null; stdout: string }> {
  return new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
    const child = spawn(command, arguments_, { stdio: ["pipe", "pipe", "pipe"] });
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
      resolve({ code, stdout: output });
    });
    child.stdin.on("error", error => {
      console.warn("capture-pruner preflight stdin failed:", error.message);
    });
    child.stdin.end(input);
  });
}

export interface PrunerPaths {
  helper: string;
  sudoersDirectory: string;
}
export interface DirectoryAccess {
  directory: boolean;
  symlink: boolean;
  userId: number;
  mode: number;
}
export interface PrunerInstallOptions {
  paths?: PrunerPaths;
  inspect?: (path: string) => Promise<DirectoryAccess>;
  replace?: typeof replaceFileDurably;
  run?: (command: string, arguments_: string[]) => Promise<{ stdout: string }>;
  userId?: () => number;
}
export interface PrunerProbeOptions {
  paths?: PrunerPaths;
  probe?: (command: string, arguments_: string[], input: string) => Promise<{ code: number | null; stdout: string }>;
}
export function capturePrunerPaths(root = "/"): PrunerPaths {
  return {
    helper: join(root, "usr/local/libexec/cool-eva-prune-captures"),
    sudoersDirectory: join(root, "etc/sudoers.d"),
  };
}
async function inspectDirectory(path: string): Promise<DirectoryAccess> {
  const metadata = await lstat(path);
  return {
    directory: metadata.isDirectory(),
    symlink: metadata.isSymbolicLink(),
    userId: metadata.uid,
    mode: metadata.mode,
  };
}
async function runPrunerCommand(command: string, arguments_: string[]): Promise<{ stdout: string }> {
  const result = await execFileAsync(command, arguments_, { timeout: 5_000 });
  return { stdout: result.stdout };
}
