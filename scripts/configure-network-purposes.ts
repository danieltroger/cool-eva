import { join, dirname, resolve } from "path";
import { stat } from "fs/promises";
import { fileURLToPath } from "url";
import { acquireSettingsWriterLock } from "../src/settings/writer-lock.ts";
import { settingsPaths, DEFAULT_SETTINGS_LOCK } from "../src/settings/paths.ts";
import { openSettingsStore } from "../src/settings/store.ts";
import { openNetworkLedger, validUuid } from "../src/wifi/network-ledger.ts";
import { WifiNetworks } from "../src/wifi/networks.ts";
import { createNetworkBackend } from "../src/wifi/network-dbus.ts";
import type { NetworkPurpose } from "../src/wifi/network-types.ts";

export async function configureNetworkPurposes(): Promise<void> {
  if (process.getuid?.() !== 0) {
    throw new Error("Run the network-purpose writer as root with Cool Eva stopped.");
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > 4096) {
      throw new Error("The network-purpose input is too large.");
    }
    chunks.push(bytes);
  }
  let submitted: unknown;
  try {
    submitted = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Pass a UUID-to-purpose object as JSON on stdin.");
  }
  if (
    !submitted ||
    typeof submitted !== "object" ||
    Array.isArray(submitted) ||
    Object.entries(submitted).some(
      ([uuid, purpose]) => !validUuid(uuid) || !["home", "hotspot"].includes(String(purpose))
    )
  ) {
    throw new Error("Each key must be a profile UUID and each purpose home or hotspot.");
  }
  const lock = await acquireSettingsWriterLock(DEFAULT_SETTINGS_LOCK);
  let networks: WifiNetworks | null = null;
  try {
    const paths = settingsPaths();
    const directory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const settings = await openSettingsStore(paths, lock, (await stat(directory)).gid);
    const current = settings.read();
    if (current.kind !== "ready" || typeof current.raw.instanceId !== "string") {
      throw new Error("Initialise or repair settings before registering networks.");
    }
    const ledger = await openNetworkLedger(
      join(paths.privateDirectory, "network-trials.json"),
      current.raw.instanceId,
      lock
    );
    const backend = createNetworkBackend();
    networks = new WifiNetworks({
      ledger,
      settings,
      backend,
      generation: "offline-installer",
      motionBlockers: () => ["offline"],
      bluetoothReady: () => false,
      hotspotChanged: () => {},
      autoTick: false,
    });
    await networks.start();
    if (networks.fault) {
      throw new Error("Resolve the interrupted network change before installation writes network profiles.");
    }
    const profiles = await backend.list();
    const purposes = submitted as Record<string, NetworkPurpose>;
    for (const uuid of Object.keys(purposes)) {
      if (!profiles.some(profile => profile.uuid === uuid) || ledger.read().excluded.includes(uuid)) {
        throw new Error("Register only confirmed profiles that exist on this Pi.");
      }
    }
    await ledger.write({ ...ledger.read(), purposes: { ...ledger.read().purposes, ...purposes } });
    console.log("Network purposes registered. No new Wi-Fi trial was authorised.");
  } finally {
    await networks?.close();
    await lock.release();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await configureNetworkPurposes();
}
