import { join } from "path";
import type { SettingsRuntime } from "../settings/startup.ts";
import type { NetworksHttpRuntime } from "../http/networks.ts";
import { WifiNetworks } from "./networks.ts";
import { openNetworkLedger } from "./network-ledger.ts";
import { createNetworkBackend } from "./network-dbus.ts";
import { pauseWifiRecovery } from "./operation.ts";

export async function startNetworkSettings(
  runtime: SettingsRuntime,
  generation: string,
  motionBlockers: () => string[],
  hotspotChanged: (ssid: string) => void
): Promise<NetworksHttpRuntime> {
  pauseWifiRecovery(true);
  const settings = runtime.store.read();
  if (settings.kind !== "ready" || typeof settings.raw.instanceId !== "string" || !runtime.dataWritable) {
    return {
      controller: null,
      fault:
        "Repair the settings/data fault first. Saved Wi-Fi stays with NetworkManager; automatic recovery is paused.",
    };
  }
  try {
    const ledger = await openNetworkLedger(
      join(runtime.paths.privateDirectory, "network-trials.json"),
      settings.raw.instanceId,
      runtime.lock
    );
    const controller = new WifiNetworks({
      ledger,
      backend: createNetworkBackend(),
      settings: runtime.store,
      generation,
      motionBlockers,
      hotspotChanged,
      bluetoothReady: () => {
        const current = runtime.store.read();
        return (
          !!runtime.activeCodeId && current.kind === "ready" && current.raw.bluetoothCodeId === runtime.activeCodeId
        );
      },
    });
    await controller.start();
    pauseWifiRecovery(!!controller.fault);
    return { controller, fault: controller.fault };
  } catch {
    console.warn("wifi-settings: network settings unavailable; original state retained and recovery paused");
    return {
      controller: null,
      fault:
        "Network change state needs repair. Restore state/network-trials.json from backup or use the installation guide; HTTP and Bluetooth remain available.",
    };
  }
}
