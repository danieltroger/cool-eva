import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configureSettings } from "../settings/configure.ts";
import { settingsPaths } from "../settings/paths.ts";
import { readReleaseMetadata } from "../release/metadata.ts";
import { verifyReleaseStorage } from "../http/release-health.ts";
import { command, exists, setReleaseGroup } from "./commands.ts";
import { readInstallChoices } from "./questions.ts";
import { installNetworks } from "./networks.ts";
import { ensureSwap } from "./swap.ts";
import { installBundleUnits, installCaptureChoice, preserveCaptureChoice, findInstalledService } from "./service.ts";
import { checkInstalledApp, printInstallResults } from "./health.ts";
import { installSecurityUpdates } from "./security.ts";
import { printInstallationFailure } from "./errors.ts";
import { failAfterServiceRecovery, prepareServiceWithRecovery } from "./failure-recovery.ts";
import { configureAccessories } from "./accessories.ts";
import { readFile } from "node:fs/promises";
import { parseSettingsDocument } from "../settings/schema.ts";

export async function installBundle(directory: string): Promise<void> {
  if (process.getuid?.() !== 0 || !(await realpath(directory)).startsWith("/opt/cool-eva/releases/")) {
    throw new Error("Run the published installer as root.");
  }
  const metadata = await readReleaseMetadata(directory);
  if (!metadata) {
    throw new Error("The release identity is missing.");
  }
  const userId = Number(process.env.SUDO_UID ?? "0");
  const groupId = Number(process.env.SUDO_GID ?? "0");
  if (![userId, groupId].every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error("The installing user's ownership could not be verified.");
  }
  await setReleaseGroup(directory, groupId);
  await installSecurityUpdates(directory);
  const existingInstallation = (await exists(settingsPaths().settingsFile)) || (await findInstalledService()) !== null;
  const choices = await readInstallChoices(existingInstallation, {
    home: await exists("/etc/NetworkManager/system-connections/cool-eva-home.nmconnection"),
    hotspot: await exists("/etc/NetworkManager/system-connections/cool-eva-hotspot.nmconnection"),
  });
  await installNetworks(choices);
  await ensureSwap();
  const captureEnabled = await preserveCaptureChoice();
  const backup = await prepareServiceWithRecovery(directory);
  const changes: Record<string, unknown> = {
    ...choices.accessories,
    ...(choices.hotspot ? { phoneHotspotSsid: choices.hotspot.ssid } : {}),
    ...(choices.rideLogPublicKeyPem ? { rideLogPublicKeyPem: choices.rideLogPublicKeyPem } : {}),
  };
  let view;
  let reboot = false;
  try {
    await configureSettings(directory, changes, { userId, groupId });
    await verifyReleaseStorage(settingsPaths());
    const { document } = parseSettingsDocument(JSON.parse(await readFile(settingsPaths().settingsFile, "utf8")));
    reboot = await configureAccessories(document.values);
    await installBundleUnits(directory, metadata.channel);
    console.log("Checking the running service for 60 seconds. No bike connection is required to finish setup.");
    view = await checkInstalledApp(metadata.release);
  } catch (error) {
    return failAfterServiceRecovery(backup, error);
  }
  if (!(await exists(settingsPaths().updaterDirectory + "/state.json"))) {
    await command("sh", [directory + "/scripts/update/run.sh", "initialise"]);
  }
  await installCaptureChoice(directory, captureEnabled);
  await printInstallResults(view, choices.rideLogPublicKeyPem);
  if (reboot) {
    console.log(
      "Setup saved the wired-accessory boot settings. Rebooting now; keep bench power on. The service finishes device checks automatically. Open the dashboard in about two minutes."
    );
    await command("systemctl", ["reboot", "--no-block"]);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await installBundle(process.argv[2]);
  } catch (error) {
    printInstallationFailure(error);
    process.exitCode = 1;
  }
}
