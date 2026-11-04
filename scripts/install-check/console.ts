import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { monotonicNow, since } from "../../src/monotonic.ts";
import { availableParallelism, freemem, loadavg } from "node:os";

export function startConsole(executable: string, arguments_: string[], log: string): GuestConsole {
  const child = spawn(executable, arguments_, { stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  let finished = false;
  let failure: Error | null = null;
  let writes = Promise.resolve();
  const collect = (chunk: Buffer): void => {
    output = (output + chunk.toString()).slice(-1024 * 1024);
    writes = writes.then(() => appendFile(log, chunk));
    writes.catch(error => {
      failure = error instanceof Error ? error : new Error("Cannot write guest log");
    });
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  child.once("error", error => {
    failure = error;
    finished = true;
  });
  child.once("exit", () => {
    finished = true;
  });
  const sampler = setInterval(() => {
    collect(
      Buffer.from(
        "\nCOOL_EVA_QEMU_HOST " +
          JSON.stringify({
            at: new Date().toISOString(),
            cpus: availableParallelism(),
            freeBytes: freemem(),
            load: loadavg(),
          }) +
          "\n"
      )
    );
  }, 15_000);
  sampler.unref();
  return {
    child,
    output: () => output,
    send: text => {
      child.stdin.write(text);
    },
    wait: async (pattern, timeout = 180_000) => {
      const started = monotonicNow();
      while (!pattern.test(output)) {
        if (failure) {
          throw failure;
        }
        if (finished || since(started) > timeout) {
          throw new Error(`Guest did not reach ${pattern}; see ${log}`);
        }
        await delay(100);
      }
    },
    stop: async () => {
      clearInterval(sampler);
      if (!finished) {
        child.kill("SIGTERM");
      }
      const started = monotonicNow();
      while (!finished && since(started) < 10_000) {
        await delay(100);
      }
      if (!finished) {
        child.kill("SIGKILL");
      }
      await writes;
    },
  };
}

export interface GuestConsole {
  child: ChildProcessWithoutNullStreams;
  output: () => string;
  send: (text: string) => void;
  wait: (pattern: RegExp, timeout?: number) => Promise<void>;
  stop: () => Promise<void>;
}
