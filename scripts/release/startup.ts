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
    console.warn("Native installer smoke import:", stderr);
  }
  console.log("Native installer smoke import passed; real-Pi default-flag acceptance is separate.");
}
