import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  command,
  exists,
  installFile,
  removeOwnFile,
  selectInitialRelease,
  unitLoadState,
  writeRootFile,
} from "./commands.ts";
import { parseSettingsDocument } from "../settings/schema.ts";
import { settingsPaths } from "../settings/paths.ts";
import { verifyReleaseStorage } from "../http/release-health.ts";

export async function prepareExistingService(directory: string): Promise<ServiceBackup | null> {
  const source = await findInstalledService();
  if (!source) {
    await selectInitialRelease(directory);
    return null;
  }
  const unit = `/etc/systemd/system/${source}`;
  const original = (await exists(unit)) ? await readFile(unit, "utf8") : null;
  if (original !== null && !(await exists("/var/cache/cool-eva-install/cool-eva.service.previous"))) {
    await writeRootFile("/var/cache/cool-eva-install/cool-eva.service.previous", original);
  }
  const backup: ServiceBackup = { service: source, original, unit };
  if (await exists(settingsPaths().settingsFile)) {
    const document = parseSettingsDocument(JSON.parse(await readFile(settingsPaths().settingsFile, "utf8"))).document;
    if (document.migration.complete) {
      await verifyReleaseStorage(settingsPaths());
      await command("systemctl", ["stop", source]);
      await selectInitialRelease(directory);
      return backup;
    }
  }
  const workingDirectory = await command("systemctl", ["show", source, "--property=WorkingDirectory", "--value"]);
  if (
    !workingDirectory.startsWith("/") ||
    /[\r\n%]/.test(workingDirectory) ||
    !(await exists(join(workingDirectory, "src/index.ts")))
  ) {
    throw new Error("The existing service's checkout could not be identified. Its unit and data are unchanged.");
  }
  console.log("Asking the existing service to migrate its own settings and data; its environment sources stay intact.");
  const dropIn = migrationDropIn(source);
  await selectInitialRelease(directory);
  await writeRootFile(
    dropIn,
    `[Service]\nType=oneshot\nRemainAfterExit=yes\nUser=root\nGroup=root\nRestart=no\nTimeoutStartSec=1800\nExecStartPre=\nExecStartPost=\nExecStart=\nExecStart=${systemdArgument(join(directory, "runtime/bin/node"))} --experimental-strip-types ${systemdArgument(join(directory, "src/install/migrate-service.ts"))} ${systemdArgument(workingDirectory)} ${source}\n`
  );
  await command("systemctl", ["daemon-reload"]);
  await command("systemctl", ["restart", source], 1800_000);
  await verifyReleaseStorage(settingsPaths());
  await command("systemctl", ["stop", source]);
  await removeOwnFile(dropIn);
  console.log("Existing data is ready. The checkout is retained for recovery and scratch work.");
  return backup;
}

export async function installBundleUnits(directory: string, channel: string): Promise<void> {
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
  for (const name of ["cool-eva", "cool-eva-update", "cool-eva-rollback", "cool-eva-update-repair"]) {
    await installFile(join(directory, `scripts/update/${name}.service`), `/etc/systemd/system/${name}.service`, 0o644);
  }
  if (await exists("/etc/systemd/system/thermometer.service")) {
    await command("systemctl", ["disable", "thermometer.service"]);
    await command("mv", [
      "/etc/systemd/system/thermometer.service",
      "/var/cache/cool-eva-install/thermometer.service.previous",
    ]);
  }
  await command("systemctl", ["daemon-reload"]);
  const executable = await command("systemctl", ["show", "cool-eva.service", "--property=ExecStart", "--value"]);
  if (!executable.includes("/usr/local/libexec/cool-eva-launch")) {
    throw new Error(
      "An existing service override changes the bundle launcher. The service was not started; review its drop-ins."
    );
  }
  if ((await command("systemctl", ["show", "cool-eva.service", "--property=ActiveState", "--value"])) === "failed") {
    await command("systemctl", ["reset-failed", "cool-eva.service"]);
  }
  await command("systemctl", ["enable", "--now", "cool-eva.service"]);
}

export async function preserveCaptureChoice(): Promise<boolean> {
  const marker = "/var/cache/cool-eva-install/capture-opt-in";
  const resuming =
    (await exists(migrationDropIn("cool-eva.service"))) || (await exists(migrationDropIn("thermometer.service")));
  if (resuming && (await exists(marker))) {
    return (await readFile(marker, "utf8")).trim() === "enabled";
  }
  let enabled = false;
  const load = await unitLoadState("can-capture.service");
  if (load !== "not-found") {
    enabled =
      (await command("systemctl", ["show", "can-capture.service", "--property=UnitFileState", "--value"])) ===
      "enabled";
    await command("systemctl", ["disable", "--now", "can-capture.service"]);
  }
  await writeRootFile(marker, enabled ? "enabled\n" : "disabled\n");
  return enabled;
}

export async function installCaptureChoice(directory: string, enabled: boolean): Promise<void> {
  if (!enabled) {
    console.log("Raw CAN capture is OFF. It is unencrypted developer data.");
    return;
  }
  await command("apt-get", ["-o", "DPkg::Lock::Timeout=300", "install", "-y", "can-utils"], 600_000);
  await installFile(join(directory, "scripts/can-capture/capture.sh"), "/usr/local/libexec/cool-eva-capture", 0o755);
  await writeRootFile(
    "/etc/systemd/system/can-capture.service",
    `[Unit]\nDescription=Raw CAN capture (existing owner opt-in)\nAfter=cool-eva.service\nWants=cool-eva.service\n[Service]\nType=simple\nExecStart=/bin/sh /usr/local/libexec/cool-eva-capture\nRestart=on-failure\nRestartSec=5\nUser=root\nUMask=0027\n[Install]\nWantedBy=multi-user.target\n`,
    0o644
  );
  await command("systemctl", ["daemon-reload"]);
  await command("systemctl", ["enable", "--now", "can-capture.service"]);
  console.log("Preserved the existing owner's explicit raw-capture opt-in.");
}

export async function restoreService(backup: ServiceBackup | null): Promise<void> {
  if (!backup) return;
  // Completed migration leaves compatibility paths for the old code. An unfinished
  // move must stay quiescent, so this function is called only after verification.
  await verifyReleaseStorage(settingsPaths());
  await command("systemctl", ["stop", "cool-eva.service"]);
  if (backup.original === null) {
    await removeOwnFile(backup.unit);
  } else {
    await writeRootFile(backup.unit, backup.original, 0o644);
  }
  if (backup.service !== "cool-eva.service") {
    await command("systemctl", ["disable", "cool-eva.service"]);
    await removeOwnFile("/etc/systemd/system/cool-eva.service");
  }
  await command("systemctl", ["daemon-reload"]);
  await command("systemctl", ["reset-failed", backup.service]);
  await command("systemctl", ["enable", "--now", backup.service]);
  console.warn(
    "The new service failed its checks; the previous service unit was restored. Ride data stays in its service-managed location."
  );
}

export interface ServiceBackup {
  service: string;
  original: string | null;
  unit: string;
}

export async function findInstalledService(): Promise<string | null> {
  for (const service of ["cool-eva.service", "thermometer.service"]) {
    const load = await unitLoadState(service);
    if (load !== "not-found") {
      return service;
    }
  }
  return null;
}

function migrationDropIn(service: string): string {
  return `/etc/systemd/system/${service}.d/zz-cool-eva-install-migration.conf`;
}
function systemdArgument(value: string): string {
  return JSON.stringify(value.replaceAll("%", "%%"));
}
