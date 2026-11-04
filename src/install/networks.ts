import { randomUUID } from "node:crypto";
import type { InstallChoices, WifiChoice } from "./questions.ts";
import { command, exists, writeRootFile } from "./commands.ts";
import { readFile } from "node:fs/promises";

export async function installNetworks(choices: InstallChoices): Promise<void> {
  for (const [name, choice] of [
    ["home", choices.home],
    ["hotspot", choices.hotspot],
  ] as const) {
    const path = `/etc/NetworkManager/system-connections/cool-eva-${name}.nmconnection`;
    const previous = (await exists(path)) ? await readFile(path, "utf8") : "";
    if (!choice) {
      await writeRootFile(path, previous);
    } else {
      const uuid = /^uuid=([a-f0-9-]{36})$/im.exec(previous)?.[1] ?? randomUUID();
      await writeRootFile(path, networkProfile(choice, uuid));
    }
    try {
      await command("nmcli", ["connection", "load", path]);
    } catch (error) {
      console.warn(
        "setup: NetworkManager could not load a saved profile",
        error instanceof Error && "code" in error ? error.code : "unknown"
      );
      throw new Error("A Wi-Fi profile could not be loaded. Check the network's WPA2 settings and rerun setup.");
    }
    console.log(
      `${name === "home" ? "Home Wi-Fi" : "Phone hotspot"} profile saved without changing the current connection.`
    );
  }
}

export function networkProfile(choice: WifiChoice, uuid: string = randomUUID()): string {
  const ssid = Array.from(Buffer.from(choice.ssid, "utf8")).join(";") + ";";
  return `[connection]\nid=Cool Eva Wi-Fi\nuuid=${uuid}\ntype=wifi\nautoconnect=true\nautoconnect-priority=10\n\n[wifi]\nmode=infrastructure\nssid=${ssid}\n\n[wifi-security]\nkey-mgmt=wpa-psk\npsk=${escapeKeyfile(choice.password)}\n\n[ipv4]\nmethod=auto\n\n[ipv6]\nmethod=auto\n`;
}

function escapeKeyfile(value: string): string {
  if (/[\0\r\n]/.test(value)) {
    throw new Error("Wi-Fi passwords must be a single line.");
  }
  return value.replaceAll("\\", "\\\\").replaceAll(" ", "\\s").replaceAll("\t", "\\t");
}
