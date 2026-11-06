import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface WorkerPreview {
  process: ChildProcess;
  directory: string;
  url: string;
}

export async function startWorkerPreview(name: "keys" | "dashboard"): Promise<WorkerPreview> {
  const projectDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
  const directory = await mkdtemp(join(tmpdir(), "cool-eva-worker-"));
  const child = spawn(
    process.execPath,
    [
      join(projectDirectory, "workers/node_modules/wrangler/bin/wrangler.js"),
      "dev",
      "--local",
      "--config",
      join(projectDirectory, `workers/${name}/wrangler.jsonc`),
      "--ip",
      "127.0.0.1",
      "--port",
      "0",
      "--inspector-port",
      "0",
      "--persist-to",
      directory,
      "--show-interactive-dev-session=false",
    ],
    {
      cwd: projectDirectory,
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  try {
    const url = await new Promise<string>((resolve, reject) => {
      let output = "";
      const timeout = setTimeout(() => reject(new Error(`Local ${name} Worker did not start: ${output}`)), 30_000);
      const receive = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-6000);
        const match = /Ready on (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
        if (match !== null) {
          clearTimeout(timeout);
          resolve(match[1]);
        }
      };
      child.stdout?.on("data", receive);
      child.stderr?.on("data", receive);
      child.once("error", error => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("exit", code => {
        clearTimeout(timeout);
        reject(new Error(`Local ${name} Worker exited ${code}: ${output}`));
      });
    });
    return { process: child, directory, url };
  } catch (error) {
    await stopWorkerPreview({ process: child, directory, url: "" });
    throw error;
  }
}

export async function stopWorkerPreview(preview: WorkerPreview): Promise<void> {
  if (preview.process.pid !== undefined && preview.process.exitCode === null && preview.process.signalCode === null) {
    await new Promise<void>(resolve => {
      const timeout = setTimeout(() => preview.process.kill("SIGKILL"), 5000);
      preview.process.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
      preview.process.kill("SIGTERM");
    });
  }
  await rm(preview.directory, { recursive: true, force: true });
}
