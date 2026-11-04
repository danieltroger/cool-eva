import type { NetworkLedger, NetworkProfile } from "./network-types.ts";

export function registeredHotspot(state: NetworkLedger, profiles: NetworkProfile[]): NetworkProfile | null {
  const change = state.change;
  const canonicalUuid =
    state.hotspotUuid ?? (change?.phase === "kept" && change.purpose === "hotspot" ? change.uuid : null);
  const hotspots = profiles.filter(
    profile => state.purposes[profile.uuid] === "hotspot" && !state.excluded.includes(profile.uuid)
  );
  return canonicalUuid
    ? (hotspots.find(profile => profile.uuid === canonicalUuid) ?? null)
    : hotspots.length === 1
      ? hotspots[0]
      : null;
}
