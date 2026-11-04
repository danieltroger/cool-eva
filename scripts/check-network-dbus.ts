import assert from "assert/strict";
import dbus from "dbus-next";
import { createNetworkBackend, type NetworkBus } from "../src/wifi/network-dbus.ts";
import type { NetworkProfile } from "../src/wifi/network-types.ts";
import { installNetworkSecretSpies } from "./network-secret-spies.ts";

export async function checkNetworkDbus(): Promise<void> {
  const settings = new Map<string, SettingsMap>();
  const calls: { method: string; parameters: unknown[] }[] = [];
  const checkpoints: string[] = [];
  let failMethod: string | null = null;
  let persistedBackend = "";
  let refusePersistence = false;
  const bus: NetworkBus = {
    getProxyObject: async (_service, path) => ({
      getInterface: () =>
        new Proxy(
          {},
          {
            get:
              (_target, method) =>
              async (...parameters: unknown[]) => {
                if (method === failMethod) {
                  throw Object.assign(new Error("synthetic-secret-must-not-escape"), {
                    type: "org.freedesktop.NetworkManager.SyntheticFailure",
                  });
                }
                calls.push({ method: String(method), parameters });
                switch (method) {
                  case "ListConnections":
                    return [...settings.keys()];
                  case "AddConnection2":
                    settings.set(PROFILE_PATH, parameters[0] as SettingsMap);
                    return [PROFILE_PATH, {}];
                  case "GetSettings": {
                    const reply = structuredClone(settings.get(path)!);
                    delete reply["802-11-wireless-security"].psk;
                    return reply;
                  }
                  case "GetSecrets":
                    return {
                      "802-11-wireless-security": { psk: new dbus.Variant("s", "synthetic-secret-must-not-escape") },
                    };
                  case "Update2":
                    settings.set(path, parameters[0] as SettingsMap);
                    return {};
                  case "Delete":
                    settings.delete(path);
                    return;
                  case "GetDeviceByIpIface":
                    return "/device/wlan0";
                  case "CheckpointCreate":
                    checkpoints.push(CHECKPOINT_PATH);
                    return CHECKPOINT_PATH;
                  case "CheckpointDestroy":
                    checkpoints.splice(checkpoints.indexOf(String(parameters[0])), 1);
                    return;
                  case "CheckpointRollback":
                    return { "/device/wlan0": 0 };
                  case "Get": {
                    if (parameters[1] === "Filename")
                      return new dbus.Variant(
                        "s",
                        `/run/NetworkManager/system-connections/netplan-${UUID}.nmconnection`
                      );
                    if (parameters[1] === "Checkpoints") return new dbus.Variant("ao", checkpoints);
                    if (parameters[1] === "ActiveConnection") return new dbus.Variant("o", "/active/1");
                    if (parameters[1] === "State") return new dbus.Variant("u", 100);
                    if (parameters[1] === "Uuid") return new dbus.Variant("s", UUID);
                    if (parameters[1] === "Ip4Config") return new dbus.Variant("o", "/ip/1");
                    if (parameters[1] === "AddressData")
                      return new dbus.Variant("aa{sv}", [{ address: new dbus.Variant("s", "192.0.2.30") }]);
                    throw new Error("Unexpected property");
                  }
                  default:
                    return "/active/1";
                }
              },
          }
        ) as Record<string, (...parameters: unknown[]) => Promise<unknown>>,
    }),
    on: () => {},
    disconnect: () => {},
  };
  const backend = createNetworkBackend(bus, async (_uuid, _filename, netplan, absent) => {
    if (refusePersistence && !absent) {
      throw new Error("Synthetic source verification failure");
    }
    persistedBackend = netplan ? "netplan" : "keyfile";
  });
  const profile: NetworkProfile = {
    uuid: UUID,
    name: `netplan-cool-eva-${UUID}`,
    ssid: "Synthetic network",
    priority: 12,
    autoconnect: false,
    authRetries: 1,
    security: "wpa-psk",
    backend: "netplan",
  };
  await backend.add(profile, "synthetic-secret-must-not-escape", true);
  const addition = calls.find(call => call.method === "AddConnection2")!;
  assert.equal(addition.parameters[1], 0x21);
  const added = addition.parameters[0] as SettingsMap;
  assert.equal(added.connection.autoconnect.value, false);
  assert.equal(added.connection["auth-retries"].value, 1);
  assert.equal(added["802-11-wireless"].band.value, "bg");
  assert.equal(added["802-11-wireless"].hidden.value, true);
  assert.equal(added["802-11-wireless-security"]["psk-flags"].value, 0);
  await backend.verify(UUID);
  assert.equal(persistedBackend, "netplan");
  assert.equal(await backend.secret(UUID), "synthetic-secret-must-not-escape");
  await backend.checkpoint(180);
  const checkpoint = calls.find(call => call.method === "CheckpointCreate")!;
  assert.deepEqual(checkpoint.parameters, [["/device/wlan0"], 180, 0]);
  await backend.destroy(CHECKPOINT_PATH);
  assert.deepEqual(await backend.checkpoints(), []);
  await backend.policy(UUID, 12);
  assert.equal(settings.get(PROFILE_PATH)!.connection["auth-retries"].value, 0);
  assert.equal(settings.get(PROFILE_PATH)!.connection["autoconnect-priority"].value, 12);
  await backend.policy(UUID, 12, false);
  assert.equal(settings.get(PROFILE_PATH)!.connection.autoconnect.value, false);
  assert.equal(settings.get(PROFILE_PATH)!.connection["auth-retries"].value, 1);
  assert.deepEqual(await backend.active(), { uuid: UUID, address: "192.0.2.30" });
  for (const method of ["AddConnection2", "Update2", "GetSecrets"]) {
    failMethod = method;
    const operation =
      method === "AddConnection2"
        ? backend.add(profile, "synthetic-secret-must-not-escape", true)
        : method === "Update2"
          ? backend.policy(UUID, 12)
          : backend.secret(UUID);
    await assert.rejects(operation, error => error instanceof Error && /did not confirm/.test(error.message));
  }
  failMethod = null;
  await backend.remove(UUID);
  assert.equal(settings.size, 0);
  await backend.verify(UUID, true, "netplan");
  await backend.add(profile, "synthetic-secret-must-not-escape", true);
  refusePersistence = true;
  await assert.rejects(backend.verify(UUID), /source verification/);
  await backend.discard(UUID);
  assert.equal(settings.size, 0, "candidate cleanup deletes NM's secret even when source verification failed");
  refusePersistence = false;
  failMethod = "ListConnections";
  await assert.rejects(backend.list(), error => error instanceof Error && !error.message.includes("synthetic-secret"));
  backend.close();
  console.log(
    "Wi-Fi D-Bus contract: persistent flags, Netplan source selection, server secrets, checkpoint scope, policy/readback and redacted errors pass (no real NM)."
  );
}

type SettingsMap = Record<string, Record<string, dbus.Variant<unknown>>>;
const UUID = "00000000-0000-4000-8000-000000000001";
const PROFILE_PATH = "/profile/1";
const CHECKPOINT_PATH = "/org/freedesktop/NetworkManager/Checkpoint/1";
installNetworkSecretSpies(["synthetic-secret-must-not-escape"]);
await checkNetworkDbus();
