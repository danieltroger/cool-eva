import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { command, installFile, writeRootFile } from "./commands.ts";

export async function installSecurityUpdates(directory: string): Promise<void> {
  const release = await readFile("/etc/os-release", "utf8");
  const codename = /^VERSION_CODENAME=["']?([a-z0-9-]+)["']?$/m.exec(release)?.[1];
  if (!codename) {
    throw new Error("Cannot determine the installed OS codename for automatic security updates.");
  }
  await installFile(
    join(directory, "scripts/update/os-update-ready.sh"),
    "/usr/local/libexec/cool-eva-os-update-ready",
    0o755
  );
  await writeRootFile(
    "/etc/systemd/system/apt-daily-upgrade.service.d/50-cool-eva-power.conf",
    "[Service]\nExecCondition=/usr/local/libexec/cool-eva-os-update-ready\n",
    0o644
  );
  await command("systemctl", ["daemon-reload"]);
  if ((await command("dpkg-query", ["-W", "-f=${db:Status-Status}", "unattended-upgrades"])) !== "installed") {
    throw new Error("Automatic-update packages are missing; rerun the published shell installer.");
  }
  await writeRootFile("/etc/apt/apt.conf.d/99-cool-eva-security", securityPolicy(codename), 0o644);
  await writeRootFile(
    "/etc/systemd/system/cool-eva-security.timer",
    "[Unit]\nDescription=Retry deferred automatic OS security updates while charging\n[Timer]\nOnBootSec=5min\nOnUnitInactiveSec=15min\nUnit=apt-daily-upgrade.service\n[Install]\nWantedBy=timers.target\n",
    0o644
  );
  await command("systemctl", ["daemon-reload"]);
  await command("systemctl", [
    "enable",
    "--now",
    "apt-daily.timer",
    "apt-daily-upgrade.timer",
    "cool-eva-security.timer",
  ]);
  console.log(
    "Automatic OS updates, including kernel/firmware, wait for two minutes of fresh parked charging at or below 70% SOC. No automatic reboot."
  );
}

export function securityPolicy(codename: string): string {
  if (!/^[a-z0-9-]+$/.test(codename)) {
    throw new Error("Invalid OS codename for security policy");
  }
  return `#clear Unattended-Upgrade::Allowed-Origins;
#clear Unattended-Upgrade::Origins-Pattern;
Unattended-Upgrade::Origins-Pattern {
 "origin=Debian,codename=${codename}";
 "origin=Debian,codename=${codename}-security";
 "origin=Debian,codename=${codename}-updates";
 "origin=Raspberry Pi Foundation,codename=${codename}";
};
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::InstallOnShutdown "false";
APT::Periodic::Enable "1";
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
`;
}
