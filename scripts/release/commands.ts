import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";

export async function runCommand(command: string, argumentsList: string[], options: CommandOptions): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, argumentsList, { ...options, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} failed (${signal ?? code})`));
      }
    });
  });
}

export interface CommandOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

const execFileAsync = promisify(execFile);

export async function captureCommand(
  command: string,
  argumentsList: string[],
  options: CommandOptions
): Promise<string> {
  const result = await execFileAsync(command, argumentsList, { ...options, maxBuffer: 16 * 1024 * 1024 });
  return result.stdout;
}
