import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { dirname, isAbsolute } from "path";
import { ensureDirectory } from "./directories.ts";
import { readErrorCode } from "./error-code.ts";

export async function acquireSettingsWriterLock(
  path: string,
  command: LockCommand = { executable: "flock", arguments: [] }
): Promise<SettingsWriterLock> {
  if (!isAbsolute(path)) {
    throw new Error("The settings writer lock needs an absolute path.");
  }
  await ensureDirectory(dirname(path), 0o700);
  const child = spawn(command.executable, [
    ...command.arguments,
    "--exclusive",
    "--nonblock",
    path,
    "/bin/sh",
    "-c",
    HOLDER,
  ]);
  const ended = childEnded(child);
  await waitUntilHeld(child, ended);
  let held = true;
  const lock: SettingsWriterLock = {
    assertHeld: () => {
      if (!held || child.exitCode !== null || child.signalCode !== null) {
        throw new Error("The settings writer lock is no longer held.");
      }
    },
    release: async () => {
      if (!held) return;
      held = false;
      HELD_LOCKS.delete(lock);
      child.stdin.end();
      await finishHolder(child, ended);
    },
  };
  HELD_LOCKS.add(lock);
  return lock;
}

export interface SettingsWriterLock {
  assertHeld: () => void;
  release: () => Promise<void>;
}

/** Tests can run the holder protocol with Node on hosts without Linux's flock utility. */
export interface LockCommand {
  executable: string;
  arguments: string[];
}

const HELD_LOCKS = new WeakSet<SettingsWriterLock>();
const READY = "cool-eva-settings-lock\n";
const HOLDER = 'printf "cool-eva-settings-lock\\n"; exec /bin/cat >/dev/null';
const HOLDER_TIMEOUT_MS = 5_000;

export function assertSettingsWriterLock(lock: SettingsWriterLock): void {
  if (!HELD_LOCKS.has(lock)) {
    throw new Error("The settings store requires an acquired writer lock.");
  }
  lock.assertHeld();
}

function childEnded(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("error", error => {
      const code = readErrorCode(error);
      reject(
        Object.assign(new Error(`The settings writer-lock utility could not start (${code ?? "unknown"}).`), { code })
      );
    });
    child.once("close", code => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error("The settings writer lock is busy or could not be acquired."));
      }
    });
  });
}

async function waitUntilHeld(child: ChildProcessWithoutNullStreams, ended: Promise<void>): Promise<void> {
  let output = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout.on("data", (data: Buffer) => {
      output += data.toString();
      if (output === READY) {
        resolve();
      } else if (output.length >= READY.length) {
        reject(new Error("The settings writer-lock holder gave an invalid reply."));
      }
    });
  });
  // Drain errors without echoing subprocess output into a credential-handling caller.
  child.stderr.resume();
  try {
    await Promise.race([
      ready,
      ended.then(() => {
        throw new Error("The settings writer-lock holder ended before becoming ready.");
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Timed out acquiring the settings writer lock.")), HOLDER_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    child.stdin.end();
    child.kill();
    await ended.catch(() => console.warn("settings: writer-lock holder failed during acquisition"));
    throw error;
  } finally {
    clearTimeout(timer);
    child.stdout.removeAllListeners("data");
  }
}

async function finishHolder(child: ChildProcessWithoutNullStreams, ended: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      ended,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          child.kill();
          reject(new Error("The settings writer-lock holder did not stop."));
        }, HOLDER_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
