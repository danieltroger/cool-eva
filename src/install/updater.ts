import { join } from "node:path";
import { command, exists, installFile, writeRootFile } from "./commands.ts";
import { settingsPaths } from "../settings/paths.ts";

export async function prepareBundleUpdater(directory: string, channel: string): Promise<void> {
  await installFile(join(directory, "scripts/update/dispatch.sh"), "/usr/local/libexec/cool-eva-update", 0o755);
  await installFile(join(directory, "scripts/update/launch.sh"), "/usr/local/libexec/cool-eva-launch", 0o755);
  await writeRootFile(
    "/etc/cool-eva/update.json",
    JSON.stringify({
      format: 1,
      releaseRoot: "/opt/cool-eva",
      dataRoot: settingsPaths().dataRoot,
      settingsLock: "/run/cool-eva/settings.lock",
      service: "cool-eva.service",
      channel,
      healthUrl: "http://127.0.0.1/release-health",
    }) + "\n"
  );
  if (!(await exists(join(settingsPaths().updaterDirectory, "state.json")))) {
    await command("sh", [join(directory, "scripts/update/run.sh"), "initialise"]);
  }
  await validateInstalledHelper();
}

export async function validateInstalledHelper(): Promise<void> {
  const helper = "/opt/cool-eva/updater/current/run.sh";
  if (!(await exists(helper))) {
    throw new Error("The updater helper is missing. Setup must finish before starting the app.");
  }
  // install.sh can hold update.lock here; recover would silently skip its work.
  await command("sh", ["-n", helper]);
  await command("sh", [helper, "self-test"]);
}
