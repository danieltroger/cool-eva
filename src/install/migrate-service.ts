import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { command } from "./commands.ts";
import { startSettings } from "../settings/startup.ts";
import { verifyReleaseStorage } from "../http/release-health.ts";
import { settingsPaths } from "../settings/paths.ts";

export async function migrateInstalledService(directory: string, service: string): Promise<void> {
  if (!["cool-eva.service", "thermometer.service"].includes(service) || process.getuid?.() !== 0) {
    throw new Error("Migration must run as the installed service, as root.");
  }
  if ((await command("systemctl", ["show", service, "--property=MainPID", "--value"])) !== String(process.pid)) {
    throw new Error("Only the installed service may import its configuration and move its data.");
  }
  const runtime = await startSettings({
    codeDirectory: directory,
    workingDirectory: directory,
    environment: process.env,
    isLegacyInstallation: async () => true,
    afterDataMove: async () => {
      console.log("setup: capture remains stopped until bundle cutover completes");
    },
  });
  try {
    await verifyReleaseStorage(settingsPaths());
    console.log("Service-owned settings and data migration is complete.");
  } finally {
    await runtime.store.settled();
    await runtime.lock.release();
  }
}

if (process.argv[1] && (await realpath(process.argv[1])) === fileURLToPath(import.meta.url)) {
  await migrateInstalledService(process.argv[2], process.argv[3]);
}
