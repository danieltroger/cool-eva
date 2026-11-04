import type { WifiNetworks } from "./networks.ts";

export async function finaliseNetwork(networks: WifiNetworks): Promise<void> {
  const backend = networks.options.backend;
  let change = networks.state().change!;
  await backend.verify(change.uuid);
  if (change.phase === "confirming") {
    if (change.checkpoint && (await backend.checkpoints()).includes(change.checkpoint)) {
      await backend.destroy(change.checkpoint);
    }
    if (change.checkpoint && (await backend.checkpoints()).includes(change.checkpoint)) {
      throw new Error("The network checkpoint could not be removed.");
    }
    await networks.persist({ change: { ...change, phase: "promoting", checkpoint: null } });
  }
  change = networks.state().change!;
  if (change.phase === "promoting") {
    await backend.policy(change.uuid, change.priority);
    await backend.verify(change.uuid);
    await networks.persist({ change: { ...change, phase: "identity" } });
  }
  change = networks.state().change!;
  if (change.phase === "identity") {
    if (change.purpose === "hotspot") {
      if (!networks.reservation?.update) {
        throw new Error("The network settings reservation is unavailable.");
      }
      await networks.reservation.update({ phoneHotspotSsid: change.ssid });
      networks.options.hotspotChanged(change.ssid);
    }
    const state = networks.state();
    await networks.persist({
      purposes: { ...state.purposes, [change.uuid]: change.purpose },
      excluded: state.excluded.filter(uuid => uuid !== change.uuid),
      change: { ...change, phase: "retiring" },
    });
  }
  change = networks.state().change!;
  if (change.phase === "retiring") {
    if (change.replaced) {
      await backend.remove(change.replaced.uuid);
      await backend.verify(change.replaced.uuid, true, change.replaced.backend);
    }
    await networks.persist({
      change: {
        ...change,
        phase: "kept",
        message: change.resumedAtBoot
          ? "New network kept. Confirmation finished after a power cut; Wi-Fi may switch at power-on."
          : "New network kept.",
      },
    });
  }
}

export async function restoreNetwork(networks: WifiNetworks, reason: string): Promise<void> {
  const change = networks.state().change;
  if (!change) return;
  const backend = networks.options.backend;
  await networks.persist({ change: { ...change, phase: "restoring", message: reason } });
  await backend.deactivate(change.uuid);
  if (change.checkpoint && (await backend.checkpoints()).includes(change.checkpoint)) {
    await backend.rollback(change.checkpoint);
    if ((await backend.checkpoints()).includes(change.checkpoint)) {
      await backend.destroy(change.checkpoint);
    }
    if ((await backend.checkpoints()).includes(change.checkpoint)) {
      throw new Error("The previous network checkpoint could not be cleaned up.");
    }
  }
  const fallback = change.fallback;
  if (fallback) {
    await backend.activate(fallback.uuid);
  }
  const active = await backend.active();
  const restored = fallback !== null && active?.uuid === fallback.uuid;
  await networks.persist({
    change: {
      ...change,
      phase: restored ? "restored" : "failed",
      checkpoint: null,
      message: restored
        ? `Could not confirm ${change.ssid}. Reconnected to ${fallback.ssid}.`
        : fallback
          ? `${fallback.ssid} is still saved, but Cool Eva could not reconnect. ${reason}`
          : `No previous connection is available. ${reason}`,
    },
  });
}
