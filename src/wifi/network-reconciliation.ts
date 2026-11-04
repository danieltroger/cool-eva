import type { WifiNetworks } from "./networks.ts";
import type { NetworkAddress, NetworkProfile } from "./network-types.ts";
import { finaliseNetwork, restoreNetwork } from "./network-transitions.ts";
import { registeredHotspot } from "./network-hotspot.ts";

export async function reconcileNetworkStart(networks: WifiNetworks): Promise<void> {
  let profiles: NetworkProfile[];
  try {
    profiles = await networks.listProfiles();
  } catch {
    console.warn("wifi-settings: startup profile listing unavailable; existing Wi-Fi recovery remains available");
    if (!pendingNetworkChange(networks)) return;
    throw new Error("Interrupted network change could not be read");
  }
  const state = networks.state();
  const orphans = profiles
    .filter(profile => /^(?:netplan-)?cool-eva-/.test(profile.name) && !profile.autoconnect)
    .map(profile => profile.uuid)
    .filter(uuid => !state.excluded.includes(uuid));
  if (orphans.length) {
    await networks.persist({ excluded: [...state.excluded, ...orphans] });
  }
  const change = networks.state().change;
  if (!pendingNetworkChange(networks)) {
    await reconcileHotspotName(networks, profiles);
  }
  if (!change || change.phase === "kept") return;
  if (!pendingNetworkChange(networks)) {
    if (!profiles.some(profile => profile.uuid === change.uuid)) {
      await networks.persist({
        change: {
          ...change,
          phase: "failed",
          message: "Saved network change could not be restored; enter its details again.",
        },
      });
    }
    return;
  }
  await networks.take(networks.settingsRevision());
  try {
    await networks.persist({ change: { ...change, resumedAtBoot: true } });
    if (["confirming", "promoting", "identity", "retiring"].includes(change.phase)) {
      await finaliseNetwork(networks);
    } else {
      await restoreNetwork(networks, "The network change was interrupted.");
    }
  } finally {
    await networks.release();
  }
}

export function pendingNetworkChange(networks: WifiNetworks): boolean {
  const change = networks.state().change;
  return !!change && !["saved", "failed", "restored", "kept"].includes(change.phase);
}

export async function observeNetworkRestoration(networks: WifiNetworks, active?: NetworkAddress | null): Promise<void> {
  const change = networks.state().change;
  if (change?.phase !== "failed" || !change.fallback) {
    networks.restorationDeadline = null;
    return;
  }
  if (active === undefined) {
    if (networks.restorationDeadline === null) return;
    if (networks.now() >= networks.restorationDeadline) {
      networks.restorationDeadline = null;
      return;
    }
    active = await networks.options.backend.active();
  }
  if (active?.uuid === change.fallback.uuid) {
    await networks.persist({
      change: {
        ...change,
        phase: "restored",
        message: `Could not confirm ${change.ssid}. Reconnected to ${change.fallback.ssid}.`,
      },
    });
    networks.restorationDeadline = null;
  }
}

export const RESTORATION_MS = 15_000;

async function reconcileHotspotName(networks: WifiNetworks, profiles: NetworkProfile[]): Promise<void> {
  const state = networks.state();
  const hotspot = registeredHotspot(state, profiles);
  const settings = networks.options.settings.read();
  if (!hotspot || settings.kind !== "ready") return;
  const renamed = settings.document.values.phoneHotspotSsid !== hotspot.ssid;
  if (!renamed && state.hotspotUuid === hotspot.uuid) return;
  await networks.take(networks.settingsRevision());
  try {
    if (renamed) {
      await networks.reservation!.update!({ phoneHotspotSsid: hotspot.ssid });
      networks.options.hotspotChanged(hotspot.ssid);
    }
    if (state.hotspotUuid !== hotspot.uuid) {
      await networks.persist({ hotspotUuid: hotspot.uuid });
    }
  } finally {
    await networks.release();
  }
}
