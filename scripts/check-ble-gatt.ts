import assert from "node:assert/strict";
import dbus from "dbus-next";
import { startGattApplication, type GattHandlers } from "../src/ble-server/gatt-app.ts";
import { watchDevices } from "../src/ble-server/device-watch.ts";
import type { BusLink } from "../src/ble-server/dbus-link.ts";
import { Owner } from "../src/ble-server/owner.ts";
import { until } from "./ble-check-rig.ts";
import { bleClock } from "./ble-check-clock.ts";

export async function checkBleGatt(): Promise<void> {
  const bus = new FakeBus();
  const disconnected: string[] = [];
  const resets: string[] = [];
  let ready = 0;
  const stop = await watchDevices(bus, {
    disconnected: path => disconnected.push(path),
    reset: reason => resets.push(reason),
    ready: () => {
      ready++;
    },
  });
  const device = "/org/bluez/hci0/dev_PHONE";
  bus.signal(":attacker", "org.freedesktop.DBus.Properties", "PropertiesChanged", device, [
    "org.bluez.Device1",
    { Connected: { value: false } },
    [],
  ]);
  assert.equal(disconnected.length, 0, "untrusted signal released an owner");
  bus.signal(bus.owner, "org.freedesktop.DBus.Properties", "PropertiesChanged", device, [
    "org.bluez.Device1",
    { Connected: { value: false } },
    [],
  ]);
  assert.deepEqual(disconnected, [device], "actual property watcher missed departure");
  bus.signal(bus.owner, "org.freedesktop.DBus.ObjectManager", "InterfacesRemoved", "/", [
    device,
    ["org.bluez.Device1"],
  ]);
  assert.equal(disconnected.length, 2, "actual removal watcher missed departure");
  bus.signal(bus.owner, "org.freedesktop.DBus.Properties", "PropertiesChanged", "/org/bluez/hci0", [
    "org.bluez.Adapter1",
    { Powered: { value: false } },
    [],
  ]);
  assert.equal(resets.length, 1, "adapter loss did not reset owner");
  bus.replaceOwner(":bluez2");
  assert.equal(resets.length, 2, "daemon owner change did not reset owner");
  assert.equal(ready, 1);
  bus.signal(":bluez1", "org.freedesktop.DBus.Properties", "PropertiesChanged", device, [
    "org.bluez.Device1",
    { Connected: { value: false } },
    [],
  ]);
  assert.equal(disconnected.length, 2, "old daemon signal affected the new registration");
  stop();
  bus.signal(bus.owner, "org.freedesktop.DBus.Properties", "PropertiesChanged", device, [
    "org.bluez.Device1",
    { Connected: { value: false } },
    [],
  ]);
  assert.equal(disconnected.length, 2, "stopped watcher was still active");

  const applicationBus = new FakeBus();
  const applicationResets: string[] = [];
  const boundOwner = new Owner();
  const handlers: GattHandlers = {
    onRead: () => new Uint8Array([1]),
    onWrite: () => {
      throw new Error("no RX expected");
    },
    onSubscribed: () => undefined,
    onDeviceDisconnected: path => {
      if (boundOwner.device === path) {
        boundOwner.clear();
      }
    },
    onReset: reason => {
      applicationResets.push(reason);
      boundOwner.clear();
    },
  };
  const app = await startGattApplication(handlers, applicationBus);
  try {
    const advertisement = applicationBus.exported.get("/org/cooleva/ble/advertisement0") as unknown as Advertisement;
    assert.deepEqual(advertisement.ServiceUUIDs, ["7c0e0001-5f3a-4c8e-9d2b-c00e7a000001"]);
    assert.equal("LocalName" in advertisement, false, "advertisement exposed a local name");
    assert.equal(JSON.stringify(advertisement.$introspect()).includes("LocalName"), false);
    assert.equal(advertisement.Includes?.includes("local-name") ?? false, false);
    assert.equal(applicationResets.includes("GATT registration replaced"), true);
    boundOwner.claim(device);
    applicationBus.signal(applicationBus.owner, "org.freedesktop.DBus.Properties", "PropertiesChanged", device, [
      "org.bluez.Device1",
      { Connected: { value: false } },
      [],
    ]);
    assert.equal(boundOwner.device, null, "GATT application did not forward device departure");
    const owner = new Owner();
    owner.claim(device);
    applicationBus.connected = false;
    assert.equal(await owner.connected(app.isDeviceConnected), false);
    applicationBus.connected = true;
    assert.equal(await owner.connected(app.isDeviceConnected), true);
    applicationBus.readError = true;
    assert.equal(await owner.connected(app.isDeviceConnected), false, "read error did not release stale ownership");
    applicationBus.readError = false;
    boundOwner.claim(device);
    applicationBus.replaceOwner(":newDaemon");
    assert.equal(boundOwner.device, null, "GATT application did not forward daemon replacement");
    await until(() => applicationBus.registrations >= 2, "daemon return registered application");
    assert.ok(applicationResets.includes("bluetoothd owner changed"));
    boundOwner.claim(device);
    applicationBus.replaceOwner("");
    assert.equal(boundOwner.device, null, "daemon disappearance did not release owner");
    assert.ok(applicationBus.rules.every(rule => rule.includes("type='signal'")));
  } finally {
    await app.stop();
  }
  assert.equal(applicationBus.listeners.get("message")?.size ?? 0, 0);
  const clock = bleClock();
  const timeoutOwner = new Owner(clock);
  timeoutOwner.claim(device);
  let reads = 0;
  const hanging = () => {
    reads++;
    return new Promise<boolean>(() => {
      /* Exercises the actual bounded read. */
    });
  };
  const first = timeoutOwner.connected(hanging);
  assert.equal(await timeoutOwner.connected(hanging), null, "duplicate owner read was not coalesced");
  assert.equal(reads, 1);
  await clock.advance(3_000);
  assert.equal(await first, false, "owner read timeout never released stale owner");
  console.log("check-ble-gatt: all checks passed");
}
interface Advertisement {
  ServiceUUIDs: string[];
  Includes?: string[];
  $introspect: () => unknown;
}
class FakeBus implements BusLink {
  owner = ":bluez1";
  connected = true;
  readError = false;
  registrations = 0;
  rules: string[] = [];
  exported = new Map<string, InstanceType<typeof dbus.interface.Interface>>();
  listeners = new Map<string, Set<(value: unknown) => void>>();
  async getProxyObject(_service: string, _path: string) {
    return {
      getInterface: (name: string): unknown => {
        if (name === "org.freedesktop.DBus")
          return {
            AddMatch: async (rule: string) => {
              this.rules.push(rule);
            },
            GetNameOwner: async () => this.owner,
          };
        if (name === "org.freedesktop.DBus.Properties")
          return {
            Get: async () => {
              if (this.readError) {
                throw new Error("synthetic absent device");
              }
              return { value: this.connected };
            },
          };
        if (name === "org.bluez.GattManager1")
          return {
            RegisterApplication: async () => {
              this.registrations++;
            },
            UnregisterApplication: async () => undefined,
          };
        if (name === "org.bluez.LEAdvertisingManager1")
          return {
            RegisterAdvertisement: async () => undefined,
            UnregisterAdvertisement: async () => undefined,
          };
        throw new Error(`unexpected interface ${name}`);
      },
    };
  }
  export(path: string, implementation: InstanceType<typeof dbus.interface.Interface>): void {
    this.exported.set(path, implementation);
  }
  on(event: "error" | "message", listener: (value: unknown) => void): this {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }
  off(event: "error" | "message", listener: (value: unknown) => void): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }
  disconnect(): void {
    this.listeners.clear();
  }
  signal(sender: string, iface: string, member: string, path: string, body: unknown[]): void {
    for (const listener of this.listeners.get("message") ?? []) {
      listener({ type: 4, sender, interface: iface, member, path, body });
    }
  }
  replaceOwner(next: string): void {
    const previous = this.owner;
    this.owner = next;
    this.signal("org.freedesktop.DBus", "org.freedesktop.DBus", "NameOwnerChanged", "/org/freedesktop/DBus", [
      "org.bluez",
      previous,
      next,
    ]);
  }
}

await checkBleGatt();
