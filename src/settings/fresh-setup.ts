import { lstat } from "fs/promises";
import { join } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { captureLegacyEnvironment } from "./legacy.ts";

export async function requireFreshInstallation(
  codeDirectory: string,
  environment: Readonly<Record<string, string | undefined>>,
  options: FreshSetupOptions = {}
): Promise<void> {
  if (Object.keys(captureLegacyEnvironment(environment)).length) {
    throw new Error(
      "Legacy configuration is present. Start the existing service under its unchanged unit to migrate; offline fresh setup is refused."
    );
  }
  for (const name of ["ride-logs", "vcu-params", "wifi-diag", "ride-log-key.public.pem"]) {
    try {
      await lstat(join(codeDirectory, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    throw new Error(
      "Existing archive folders require the running service's migration; offline fresh setup is refused."
    );
  }
  const { stdout } = await (options.inspectUnits ?? inspectUnits)();
  if (stdout.split(/\r?\n/).includes("LoadState=loaded")) {
    throw new Error("An existing service unit must perform its own migration; offline fresh setup is refused.");
  }
}

interface FreshSetupOptions {
  inspectUnits?: () => Promise<{ stdout: string }>;
}
async function inspectUnits(): Promise<{ stdout: string }> {
  try {
    const { stdout } = await promisify(execFile)(
      "systemctl",
      ["show", "cool-eva", "thermometer", "--property=LoadState"],
      { timeout: 5_000 }
    );
    return { stdout };
  } catch (error) {
    const stdout: unknown = error instanceof Error && "stdout" in error ? error.stdout : undefined;
    if (
      typeof stdout === "string" &&
      stdout.includes("LoadState=not-found") &&
      !stdout.split(/\r?\n/).some(line => line.startsWith("LoadState=") && line !== "LoadState=not-found")
    ) {
      console.log("settings: no prior service units are installed");
      return { stdout };
    }
    throw error;
  }
}
