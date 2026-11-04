import { randomUUID } from "crypto";
import type { WifiNetworks } from "./networks.ts";
import { validateNetworkDraft } from "./network-validation.ts";
import { NetworkRefusal, type NetworkDraft } from "./network-types.ts";

export async function saveNetworkDraft(
  networks: WifiNetworks,
  draft: NetworkDraft,
  fromBluetooth: boolean,
  settingsRevision: number | null
): Promise<void> {
  validateNetworkDraft(draft);
  if (draft.accessPointChange && (!fromBluetooth || !draft.bluetoothTested || !networks.options.bluetoothReady())) {
    throw new NetworkRefusal(
      "Activate and test the Bluetooth dashboard first, then enter and save these details there."
    );
  }
  await networks.take(settingsRevision);
  try {
    const state = networks.state();
    if (state.change && !["saved", "failed", "restored", "kept"].includes(state.change.phase)) {
      throw new NetworkRefusal("Finish the current network change first.");
    }
    const profiles = await networks.listProfiles();
    const replaced = draft.replacedUuid
      ? profiles.find(profile => profile.uuid === draft.replacedUuid && !state.excluded.includes(profile.uuid))
      : null;
    if (draft.replacedUuid && !replaced) {
      throw new NetworkRefusal("The saved network changed. Read it again.");
    }
    if (replaced && replaced.security !== "wpa-psk") {
      throw new NetworkRefusal("This network security type cannot be changed here. Use installation help.");
    }
    if (replaced) {
      await networks.options.backend.verify(replaced.uuid);
    }
    const active = await networks.options.backend.active();
    const fallback =
      profiles.find(profile => profile.uuid === active?.uuid && !state.excluded.includes(profile.uuid)) ??
      replaced ??
      null;
    const priorities = profiles
      .filter(profile => state.purposes[profile.uuid] === draft.purpose && !state.excluded.includes(profile.uuid))
      .map(profile => profile.priority);
    const priority = replaced?.priority ?? (priorities.length ? Math.max(...priorities) : 0);
    const uuid = randomUUID();
    const password =
      draft.passwordMode === "keep" && replaced ? await networks.options.backend.secret(replaced.uuid) : draft.password;
    validateNetworkDraft({ ...draft, passwordMode: "change", password });
    // Publish the exclusion before NM sees this UUID; a partial save must never reach recovery.
    await networks.persist({ excluded: [...state.excluded, uuid] });
    try {
      await networks.options.backend.add(
        {
          uuid,
          name: `${replaced?.backend === "netplan" ? "netplan-" : ""}cool-eva-${uuid}`,
          ssid: draft.ssid,
          priority,
          autoconnect: false,
          authRetries: 1,
          security: "wpa-psk",
          backend: replaced?.backend ?? "keyfile",
        },
        password,
        draft.hidden
      );
      await networks.options.backend.verify(uuid);
      const candidate = (await networks.listProfiles()).find(profile => profile.uuid === uuid);
      if (replaced?.backend === "netplan" && candidate?.backend !== "netplan") {
        throw new NetworkRefusal(
          "This image cannot replace that Netplan connection safely. Use Add to keep the old network separately."
        );
      }
    } catch (error) {
      await networks.options.backend.discard(uuid);
      throw error;
    }
    const previous = state.change;
    const settings = networks.options.settings.read();
    await networks.persist({
      revision: state.revision + 1,
      change: {
        uuid,
        ssid: draft.ssid,
        purpose: draft.purpose,
        replaced: replaced ?? null,
        fallback,
        phase: "saved",
        checkpoint: null,
        priority,
        attempts: 0,
        message: "Saved. Ready to try.",
        resumedAtBoot: false,
        ...(settings.kind === "ready"
          ? { previousHotspot: { ssid: settings.document.values.phoneHotspotSsid, uuid: state.hotspotUuid } }
          : {}),
      },
    });
    if (previous && previous.phase !== "kept") {
      await networks.options.backend.remove(previous.uuid);
    }
  } finally {
    await networks.release();
  }
}
