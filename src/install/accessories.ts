import { readFile, readdir } from "node:fs/promises";
import { command, exists, writeRootFile } from "./commands.ts";
import type { StartupSettings } from "../settings/schema.ts";

export async function configureAccessories(settings: StartupSettings): Promise<boolean> {
  if (!settings.coolantProbesEnabled && !settings.radiatorFanEnabled) {
    console.log("Optional coolant probes and radiator fan are OFF.");
    return false;
  }
  const config = "/boot/firmware/config.txt";
  const include = "include cool-eva-accessories.txt";
  const previous = await readFile(config, "utf8");
  if (!(await exists("/var/cache/cool-eva-install/boot-config.previous"))) {
    await writeRootFile("/var/cache/cool-eva-install/boot-config.previous", previous);
  }
  const desired = accessoryBootConfiguration(settings);
  const accessoryPath = "/boot/firmware/cool-eva-accessories.txt";
  const current = (await exists(accessoryPath)) ? await readFile(accessoryPath, "utf8") : "";
  const includes = previous.replaceAll("\r\n", "\n").includes("\n[all]\n" + include + "\n");
  if (current !== desired) {
    await writeRootFile(accessoryPath, desired, 0o644);
  }
  if (!includes) {
    await writeRootFile(config, previous + "\n[all]\n" + include + "\n", 0o644);
  }
  const missing = await accessoryDevicesMissing(settings);
  if (current !== desired || !includes || missing.length) {
    await writeRootFile(
      "/etc/systemd/system/cool-eva-install-finish.service",
      `[Unit]\nDescription=Finish Cool Eva wired-accessory setup after reboot\nWants=cool-eva.service\nAfter=cool-eva.service network.target\n[Service]\nType=oneshot\nTimeoutStartSec=300\nExecStart=/opt/cool-eva/current/runtime/bin/node --experimental-strip-types /opt/cool-eva/current/src/install/finish.ts\n[Install]\nWantedBy=multi-user.target\n`,
      0o644
    );
    await command("systemctl", ["daemon-reload"]);
    await command("systemctl", ["enable", "cool-eva-install-finish.service"]);
    return true;
  }
  return false;
}

export function accessoryBootConfiguration(
  settings: Pick<StartupSettings, "coolantProbesEnabled" | "radiatorFanEnabled">
): string {
  return (
    "# Only explicitly selected, already-wired hardware.\n" +
    (settings.coolantProbesEnabled ? "dtparam=spi=on\n" : "") +
    (settings.radiatorFanEnabled ? "gpio=17,op,dl\ngpio=27,op,dl\ndtoverlay=pwm,pin=18,func=2\n" : "")
  );
}

export async function accessoryDevicesMissing(
  settings: Pick<StartupSettings, "coolantProbesEnabled" | "radiatorFanEnabled">
): Promise<string[]> {
  const paths = [
    ...(settings.coolantProbesEnabled ? ["/dev/spidev0.0", "/dev/spidev0.1"] : []),
    ...(settings.radiatorFanEnabled ? ["/usr/bin/pinctrl"] : []),
  ];
  const missing: string[] = [];
  for (const path of paths) {
    if (!(await exists(path))) {
      missing.push(path);
    }
  }
  if (settings.radiatorFanEnabled) {
    const chips = (await exists("/sys/class/pwm")) ? await readdir("/sys/class/pwm") : [];
    if (!chips.some(name => /^pwmchip\d+$/.test(name))) {
      missing.push("a PWM chip");
    }
  }
  return missing;
}
