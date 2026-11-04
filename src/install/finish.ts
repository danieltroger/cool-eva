import { readFile } from "node:fs/promises";
import { readReleaseMetadata } from "../release/metadata.ts";
import { parseSettingsDocument } from "../settings/schema.ts";
import { settingsPaths } from "../settings/paths.ts";
import { command, writeRootFile } from "./commands.ts";
import { accessoryDevicesMissing } from "./accessories.ts";
import { checkInstalledApp, printInstallResults } from "./health.ts";

async function finishAfterReboot(): Promise<void> {
  if (process.getuid?.() !== 0) {
    throw new Error("Post-reboot setup must run as the root system service.");
  }
  const directory = "/opt/cool-eva/current";
  const metadata = await readReleaseMetadata(directory);
  if (!metadata) {
    throw new Error("No selected bundle after reboot.");
  }
  const view = await checkInstalledApp(metadata.release);
  const { document } = parseSettingsDocument(JSON.parse(await readFile(settingsPaths().settingsFile, "utf8")));
  await printInstallResults(view, document.values.rideLogPublicKeyPem);
  const missing = await accessoryDevicesMissing(document.values);
  const result = missing.length
    ? "Wired accessory checks need attention. Check Settings and the documented probe/fan wiring.\n"
    : "Post-reboot service and wired-accessory device checks passed. Verify actual readings/fan behavior on the parked bike.\n";
  await writeRootFile("/var/cache/cool-eva-install/after-reboot.txt", result);
  console.log(result.trim());
  await command("systemctl", ["disable", "cool-eva-install-finish.service"]);
  if (missing.length) {
    throw new Error("A selected SPI/PWM device is missing after reboot.");
  }
}

await finishAfterReboot();
