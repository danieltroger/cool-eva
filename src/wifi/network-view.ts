import type { WifiNetworks } from "./networks.ts";
import type { NetworkProof, NetworkView } from "./network-types.ts";
import { observeNetworkRestoration } from "./network-reconciliation.ts";

export async function networkView(networks: WifiNetworks, proof: NetworkProof): Promise<NetworkView> {
  const profiles = await networks.listProfiles();
  const active = await networks.options.backend.active();
  const change = networks.state().change;
  if (!change || profiles.some(profile => profile.uuid === change.uuid)) {
    await observeNetworkRestoration(networks, active);
  }
  const state = networks.state();
  return {
    ok: true,
    message: networks.fault,
    instanceId: state.instanceId,
    generation: networks.generation,
    viaBluetooth: proof.tunnel,
    observingRestoration: networks.restorationDeadline !== null && networks.now() < networks.restorationDeadline,
    revision: state.revision,
    settingsRevision: networks.settingsRevision(),
    profiles: profiles
      .filter(profile => !state.excluded.includes(profile.uuid))
      .map(profile => ({ ...profile, purpose: state.purposes[profile.uuid] ?? null })),
    active,
    change: state.change,
    remainingMs: networks.deadline === null ? null : Math.max(0, networks.deadline - networks.now()),
    canKeep:
      !networks.fault &&
      state.change?.phase === "waiting" &&
      networks.deadline !== null &&
      networks.now() < networks.deadline &&
      active?.uuid === state.change.uuid &&
      directWifi(proof, active.address),
  };
}

function directWifi(proof: NetworkProof, address: string): boolean {
  return (
    !proof.tunnel &&
    proof.localAddress.replace(/^::ffff:/, "") === address &&
    !["127.0.0.1", "::1", ""].includes(proof.remoteAddress.replace(/^::ffff:/, ""))
  );
}
