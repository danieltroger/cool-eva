import dbus from "dbus-next";
import { verifyNetworkPersistence } from "./network-persistence.ts";
import { NetworkRefusal, type NetworkAddress, type NetworkBackend, type NetworkProfile } from "./network-types.ts";

export function createNetworkBackend(
  bus: NetworkBus = dbus.systemBus(),
  persistence = verifyNetworkPersistence
): NetworkBackend {
  const connection = new NetworkDbus(bus, persistence);
  bus.on("error", () => console.warn("wifi-settings: NetworkManager D-Bus connection failed; no values logged"));
  return {
    list: () => connection.list(),
    active: () => connection.active(),
    add: (profile, password, hidden) => connection.add(profile, password, hidden),
    secret: uuid => connection.secret(uuid),
    verify: (uuid, absent, backend) => connection.verify(uuid, absent, backend),
    policy: (uuid, priority, confirmed) => connection.policy(uuid, priority, confirmed),
    remove: uuid => connection.remove(uuid),
    discard: uuid => connection.remove(uuid, false),
    activate: async uuid => {
      await connection.manager("ActivateConnection", await connection.path(uuid), await connection.device(), "/");
    },
    deactivate: uuid => connection.deactivate(uuid),
    checkpoint: async seconds =>
      String(await connection.manager("CheckpointCreate", [await connection.device()], seconds, 0)),
    checkpoints: async () => strings(await connection.property(ROOT, SERVICE, "Checkpoints")),
    destroy: async path => {
      await connection.manager("CheckpointDestroy", path);
    },
    rollback: async path => {
      const results = await connection.manager("CheckpointRollback", path);
      if (!results || typeof results !== "object" || Object.values(results).some(value => value !== 0)) {
        throw new NetworkRefusal(
          "NetworkManager could not restore the previous connection. Restore the hotspot's previous settings or use Bluetooth."
        );
      }
    },
    scan: () => connection.scan(),
    close: () => bus.disconnect(),
  };
}

class NetworkDbus {
  readonly bus: NetworkBus;
  readonly persistence: typeof verifyNetworkPersistence;
  readonly proxies = new Map<string, ReturnType<NetworkBus["getProxyObject"]>>();
  readonly known = new Map<string, { filename: string; netplan: boolean }>();
  constructor(bus: NetworkBus, persistence: typeof verifyNetworkPersistence) {
    this.bus = bus;
    this.persistence = persistence;
  }

  async call(path: string, iface: string, method: string, ...parameters: unknown[]): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      let proxy = this.proxies.get(path);
      if (!proxy) {
        proxy = this.bus.getProxyObject(SERVICE, path);
        if (this.proxies.size >= 128) {
          this.proxies.delete(this.proxies.keys().next().value!);
        }
        this.proxies.set(path, proxy);
      }
      return await Promise.race([
        proxy.then(proxy => proxy.getInterface(iface)[method](...parameters)),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("deadline")), 8_000);
        }),
      ]);
    } catch (error) {
      console.warn(`wifi-settings: NetworkManager ${method} failed (${dbusErrorName(error)}); no values logged`);
      this.proxies.delete(path);
      // NM errors can echo the settings dictionary, including a submitted secret.
      throw new NetworkRefusal("NetworkManager did not confirm the operation. Read this Pi again before trying it.");
    } finally {
      clearTimeout(timer);
    }
  }
  manager(method: string, ...parameters: unknown[]): Promise<unknown> {
    return this.call(ROOT, SERVICE, method, ...parameters);
  }
  async property(path: string, iface: string, name: string): Promise<unknown> {
    return variantValue(await this.call(path, "org.freedesktop.DBus.Properties", "Get", iface, name));
  }
  async device(): Promise<string> {
    return String(await this.manager("GetDeviceByIpIface", "wlan0"));
  }
  async settings(path: string): Promise<SettingsMap> {
    return (await this.call(path, CONNECTION, "GetSettings")) as SettingsMap;
  }
  async paths(): Promise<string[]> {
    return strings(await this.call(`${ROOT}/Settings`, `${SERVICE}.Settings`, "ListConnections"));
  }
  async path(uuid: string): Promise<string> {
    for (const path of await this.paths()) {
      if (value(await this.settings(path), "connection", "uuid") === uuid) return path;
    }
    throw new NetworkRefusal("The saved network profile is missing. Enter its details again.");
  }
  async list(): Promise<NetworkProfile[]> {
    const profiles: NetworkProfile[] = [];
    for (const path of await this.paths()) {
      const settings = await this.settings(path);
      if (value(settings, "connection", "type") !== "802-11-wireless") continue;
      const uuid = String(value(settings, "connection", "uuid"));
      const filename = String(await this.property(path, CONNECTION, "Filename"));
      const name = String(value(settings, "connection", "id"));
      const netplan = name.startsWith("netplan-") && filename.startsWith("/run/NetworkManager/");
      this.known.set(uuid, { filename, netplan });
      const ssid = value(settings, "802-11-wireless", "ssid");
      profiles.push({
        uuid,
        name,
        ssid: Buffer.from(ssid as number[]).toString("utf8"),
        priority: Number(value(settings, "connection", "autoconnect-priority") ?? 0),
        autoconnect: value(settings, "connection", "autoconnect") !== false,
        authRetries: Number(value(settings, "connection", "auth-retries") ?? -1),
        security: String(value(settings, "802-11-wireless-security", "key-mgmt") ?? "open"),
        backend: netplan ? "netplan" : "keyfile",
      });
    }
    return profiles;
  }
  async active(): Promise<NetworkAddress | null> {
    const device = await this.device();
    if (Number(await this.property(device, `${SERVICE}.Device`, "State")) !== 100) return null;
    const activePath = String(await this.property(device, `${SERVICE}.Device`, "ActiveConnection"));
    if (activePath === "/") return null;
    const uuid = String(await this.property(activePath, `${SERVICE}.Connection.Active`, "Uuid"));
    const ipPath = String(await this.property(device, `${SERVICE}.Device`, "Ip4Config"));
    if (ipPath === "/") return null;
    const addresses = (await this.property(ipPath, `${SERVICE}.IP4Config`, "AddressData")) as Record<
      string,
      dbus.Variant<unknown>
    >[];
    const address = addresses?.[0]?.address?.value;
    return typeof address === "string" ? { uuid, address } : null;
  }
  async add(profile: NetworkProfile, password: string, hidden: boolean): Promise<void> {
    const settings: SettingsMap = {
      connection: {
        id: new dbus.Variant("s", profile.name),
        uuid: new dbus.Variant("s", profile.uuid),
        type: new dbus.Variant("s", "802-11-wireless"),
        "interface-name": new dbus.Variant("s", "wlan0"),
        autoconnect: new dbus.Variant("b", profile.autoconnect),
        "autoconnect-priority": new dbus.Variant("i", profile.priority),
        "auth-retries": new dbus.Variant("i", profile.authRetries),
      },
      "802-11-wireless": {
        ssid: new dbus.Variant("ay", [...Buffer.from(profile.ssid)]),
        mode: new dbus.Variant("s", "infrastructure"),
        band: new dbus.Variant("s", "bg"),
        hidden: new dbus.Variant("b", hidden),
      },
      "802-11-wireless-security": {
        "key-mgmt": new dbus.Variant("s", "wpa-psk"),
        psk: new dbus.Variant("s", password),
        "psk-flags": new dbus.Variant("u", 0),
      },
      ipv4: { method: new dbus.Variant("s", "auto") },
      ipv6: { method: new dbus.Variant("s", "auto") },
    };
    await this.call(`${ROOT}/Settings`, `${SERVICE}.Settings`, "AddConnection2", settings, 0x21, {});
    await this.list();
  }
  async secret(uuid: string): Promise<string> {
    const settings = (await this.call(
      await this.path(uuid),
      CONNECTION,
      "GetSecrets",
      "802-11-wireless-security"
    )) as SettingsMap;
    const password = value(settings, "802-11-wireless-security", "psk");
    if (typeof password !== "string") {
      throw new NetworkRefusal("The saved password is unavailable. Choose Change password.");
    }
    return password;
  }
  async policy(uuid: string, priority: number, confirmed = true): Promise<void> {
    const path = await this.path(uuid);
    const settings = await this.settings(path);
    const secret = await this.secret(uuid);
    settings.connection.autoconnect = new dbus.Variant("b", confirmed);
    settings.connection["auth-retries"] = new dbus.Variant("i", confirmed ? 0 : 1);
    settings.connection["autoconnect-priority"] = new dbus.Variant("i", priority);
    settings["802-11-wireless-security"].psk = new dbus.Variant("s", secret);
    await this.call(path, CONNECTION, "Update2", settings, 1, {});
    const readback = await this.settings(path);
    if (
      value(readback, "connection", "autoconnect") !== confirmed ||
      value(readback, "connection", "auth-retries") !== (confirmed ? 0 : 1) ||
      value(readback, "connection", "autoconnect-priority") !== priority
    ) {
      throw new NetworkRefusal("The confirmed network policy could not be verified.");
    }
  }
  async verify(uuid: string, absent = false, backend?: NetworkProfile["backend"]): Promise<void> {
    const profiles = await this.list();
    const profile = profiles.find(profile => profile.uuid === uuid);
    if (absent && profile) {
      throw new NetworkRefusal("The previous network is still present. Retirement needs repair.");
    }
    if (!absent && !profile) {
      throw new NetworkRefusal("Saved network change could not be restored; enter its details again.");
    }
    const known = this.known.get(uuid) ?? (absent && backend ? { filename: "", netplan: backend === "netplan" } : null);
    if (!known) {
      throw new NetworkRefusal("The network's persistent source is unknown. Use installation help.");
    }
    await this.persistence(uuid, absent ? null : known.filename, known.netplan, absent);
  }
  async remove(uuid: string, verifyBefore = true): Promise<void> {
    const profiles = await this.list();
    if (!profiles.some(profile => profile.uuid === uuid)) return;
    if (verifyBefore) {
      await this.verify(uuid);
    }
    await this.call(await this.path(uuid), CONNECTION, "Delete");
    await this.verify(uuid, true);
  }
  async deactivate(uuid: string): Promise<void> {
    const path = String(await this.property(await this.device(), `${SERVICE}.Device`, "ActiveConnection"));
    if (path !== "/" && (await this.property(path, `${SERVICE}.Connection.Active`, "Uuid")) === uuid) {
      await this.manager("DeactivateConnection", path);
    }
  }
  async scan(): Promise<string[]> {
    const device = await this.device();
    await this.call(device, `${SERVICE}.Device.Wireless`, "RequestScan", {});
    const paths = strings(await this.call(device, `${SERVICE}.Device.Wireless`, "GetAllAccessPoints"));
    const names: string[] = [];
    for (const path of paths) {
      const frequency = Number(await this.property(path, `${SERVICE}.AccessPoint`, "Frequency"));
      if (frequency < 3000) {
        names.push(
          Buffer.from((await this.property(path, `${SERVICE}.AccessPoint`, "Ssid")) as number[]).toString("utf8")
        );
      }
    }
    return names;
  }
}

export interface NetworkBus {
  getProxyObject: (
    service: string,
    path: string
  ) => Promise<{ getInterface: (iface: string) => Record<string, (...parameters: unknown[]) => Promise<unknown>> }>;
  on: (event: "error", callback: () => void) => unknown;
  disconnect: () => void;
}
type SettingsMap = Record<string, Record<string, dbus.Variant<unknown>>>;
const SERVICE = "org.freedesktop.NetworkManager";
const ROOT = "/org/freedesktop/NetworkManager";
const CONNECTION = `${SERVICE}.Settings.Connection`;
function dbusErrorName(error: unknown): string {
  const name = error && typeof error === "object" && "type" in error ? error.type : null;
  return typeof name === "string" && /^(?:[A-Za-z_][A-Za-z0-9_]*\.)+[A-Za-z_][A-Za-z0-9_]*$/.test(name)
    ? name
    : "UnknownError";
}
function value(settings: SettingsMap, group: string, key: string): unknown {
  return settings[group]?.[key]?.value;
}
function variantValue(value: unknown): unknown {
  return (value as dbus.Variant<unknown>).value;
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every(item => typeof item === "string")) {
    throw new NetworkRefusal("NetworkManager returned an unsupported reply.");
  }
  return value;
}
