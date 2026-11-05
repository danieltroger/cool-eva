import { execFile } from "node:child_process";
import { chmod, chown, lstat, mkdir, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { promisify } from "node:util";
import { replaceFileDurably } from "../storage/durable.ts";
import { monotonicNow, since } from "../monotonic.ts";

export async function command(executable: string, arguments_: string[], timeout?: number): Promise<string> {
  const systemManager = basename(executable) === "systemctl";
  const started = monotonicNow();
  try {
    // Killing the client does not cancel the manager's reload or queued unit job.
    const { stdout } = await promisify(execFile)(executable, arguments_, {
      timeout: timeout ?? (systemManager ? 0 : 30_000),
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    if (!systemManager) {
      throw error;
    }
    const failure = new InstallerSystemctlError(arguments_[0], since(started), error);
    console.error(failure.message);
    throw failure;
  }
}

export class InstallerSystemctlError extends Error {
  code: string | number | null;
  signal: string | null;
  killed: boolean;
  durationMs: number;
  stdout: string;
  constructor(operation: string | undefined, durationMs: number, cause: unknown) {
    const details = cause instanceof Error ? cause : null;
    const code =
      details && "code" in details && (typeof details.code === "number" || typeof details.code === "string")
        ? details.code
        : null;
    const signal = details && "signal" in details && typeof details.signal === "string" ? details.signal : null;
    const killed = details !== null && "killed" in details && details.killed === true;
    const safeOperation = operation && /^[a-z-]+$/.test(operation) ? operation : "operation";
    super(
      `systemctl ${safeOperation} failed: exit=${code ?? "none"}, signal=${signal ?? "none"}, killed=${killed}, duration=${durationMs.toFixed(0)} ms.`,
      { cause }
    );
    this.code = code;
    this.signal = signal;
    this.killed = killed;
    this.durationMs = durationMs;
    this.stdout = details && "stdout" in details && typeof details.stdout === "string" ? details.stdout : "";
  }
}

export async function unitLoadState(service: string): Promise<string> {
  try {
    return await command("systemctl", ["show", service, "--property=LoadState", "--value"]);
  } catch (error) {
    if (
      error instanceof Error &&
      "stdout" in error &&
      typeof error.stdout === "string" &&
      error.stdout.trim() === "not-found"
    ) {
      return "not-found";
    }
    throw error;
  }
}

export async function writeRootFile(path: string, contents: string, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o755 });
  await assertRootDirectories(dirname(path));
  await replaceFileDurably(path, contents, { mode, userId: 0, groupId: 0 });
}

async function assertRootDirectories(directory: string): Promise<void> {
  let current = directory;
  for (;;) {
    const metadata = await lstat(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== 0 || (metadata.mode & 0o022) !== 0) {
      throw new Error(`Setup needs a root-owned directory without group/world write access: ${current}`);
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function removeOwnFile(path: string): Promise<void> {
  if (await exists(path)) {
    await unlink(path);
  }
}

export async function installFile(source: string, destination: string, mode: number): Promise<void> {
  await writeRootFile(destination, await readFile(source, "utf8"), mode);
}

export async function setReleaseGroup(directory: string, groupId: number): Promise<void> {
  await chown(directory, 0, groupId);
  await chmod(directory, 0o750);
}

export async function selectInitialRelease(directory: string): Promise<void> {
  const temporary = "/opt/cool-eva/current.install-next";
  await removeOwnFile(temporary);
  await command("ln", ["-s", directory, temporary]);
  await rename(temporary, "/opt/cool-eva/current");
  await command("sync", []);
}
