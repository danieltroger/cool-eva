import type { WifiNetworks } from "./networks.ts";
import type { NetworkProof, NetworkView } from "./network-types.ts";

export async function networkView(networks: WifiNetworks, proof: NetworkProof): Promise<NetworkView> {
  const state = networks.state();
  const profiles = await networks.options.backend.list();
  const active = await networks.options.backend.active();
  return {
    ok: !networks.fault,
    message: networks.fault,
    instanceId: state.instanceId,
    generation: networks.generation,
    viaBluetooth: proof.tunnel,
    revision: state.revision,
    settingsRevision: networks.settingsRevision(),
    profiles: profiles
      .filter(profile => !state.excluded.includes(profile.uuid))
      .map(profile => ({ ...profile, purpose: state.purposes[profile.uuid] ?? null })),
    active,
    change: state.change,
    remainingMs: networks.deadline === null ? null : Math.max(0, networks.deadline - networks.now()),
    canKeep:
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
