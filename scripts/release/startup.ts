import { cpus } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hashFile } from "./files.ts";

export async function verifyInstallerStartup(directory: string): Promise<void> {
  if (process.platform !== "linux" || process.arch !== "arm64") {
    throw new Error("The installer startup comparison requires native Linux ARM64");
  }
  const executable = join(directory, "runtime/bin/node");
  console.log(`Native ARM64 installer imports: ${cpus()[0]?.model}; Node sha256 ${await hashFile(executable)}`);
  for (let iteration = 1; iteration <= 100; iteration++) {
    console.log(`Native installer import ${iteration}/100 starting; 60-second limit.`);
    const { stderr } = await promisify(execFile)(
      executable,
      [
        "--no-wasm-lazy-compilation",
        "--experimental-strip-types",
        "--input-type=module",
        "--eval",
        "await import('./src/install/main.ts')",
      ],
      {
        cwd: directory,
        env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", HOME: "/nonexistent", NODE_PATH: "" },
        timeout: 60_000,
        killSignal: "SIGKILL",
      }
    );
    if (stderr) {
      console.warn(`Native installer import ${iteration}:`, stderr);
    }
    if (iteration % 10 === 0) {
      console.log(`Native installer imports passed ${iteration}/100; any failure stops the build.`);
    }
  }
}
