import dbus from "dbus-next";
import { bounded, type BusLink, type PropertiesInterface } from "./dbus-link.ts";
import { watchDevices } from "./device-watch.ts";
import {
  INFO_CHARACTERISTIC_UUID,
  RX_CHARACTERISTIC_UUID,
  SERVICE_UUID,
  TX_CHARACTERISTIC_UUID,
  type Bytes,
} from "../../public/lib/ble-wire.js";

// The Pi as a BLE peripheral: one GATT service and one advertisement, exported on the
// system bus and registered with bluetoothd. Only the D-Bus plumbing lives here; what the
// bytes mean is session.ts and ble-wire.js. BlueZ's contract for both objects is
// doc/org.bluez.GattManager.rst and doc/org.bluez.LEAdvertisingManager.rst in the BlueZ
// tree; docs/ble-server.md describes the exported shape and deployment limits.

const BLUEZ = "org.bluez";
const ADAPTER_PATH = "/org/bluez/hci0";
const APPLICATION_PATH = "/org/cooleva/ble";
const SERVICE_PATH = `${APPLICATION_PATH}/service0`;
const RX_PATH = `${SERVICE_PATH}/rx`;
const TX_PATH = `${SERVICE_PATH}/tx`;
const INFO_PATH = `${SERVICE_PATH}/info`;
const ADVERTISEMENT_PATH = `${APPLICATION_PATH}/advertisement0`;

/** How often to try again while unregistered — after an adapter reset, or a bluetoothd restart. */
const REREGISTER_INTERVAL_MS = 15_000;

const { Interface } = dbus.interface;
type Variant = InstanceType<typeof dbus.Variant>;
type Options = Record<string, Variant | undefined>;

export interface GattHandlers {
  /** A phone wrote a frame. `mtu` is the negotiated ATT MTU when BlueZ reports one. */
  onWrite: (frame: Bytes, mtu: number | undefined, device: string | undefined) => void;
  onRead: () => Bytes;
  onSubscribed: (subscribed: boolean) => void;
  onDeviceDisconnected: (device: string) => void;
  onReset: (reason: string) => void;
}

export interface GattApplication {
  notify: (frame: Bytes) => void;
  isDeviceConnected: (device: string) => Promise<boolean>;
  stop: () => Promise<void>;
  ready?: () => boolean;
}

export async function startGattApplication(
  handlers: GattHandlers,
  bus: BusLink = dbus.systemBus() as unknown as BusLink
): Promise<GattApplication> {
  const context: AppContext = {
    bus,
    registered: false,
    registering: false,
    stopped: false,
    generation: 0,
    reset: handlers.onReset,
  };

  const rx = new CharacteristicInterface(RX_CHARACTERISTIC_UUID, ["write"], handlers);
  const tx = new CharacteristicInterface(TX_CHARACTERISTIC_UUID, ["notify"], handlers);
  const info = new CharacteristicInterface(INFO_CHARACTERISTIC_UUID, ["read"], handlers);
  const service = new ServiceInterface("org.bluez.GattService1");
  const advertisement = new AdvertisementInterface("org.bluez.LEAdvertisement1");

  bus.export(
    APPLICATION_PATH,
    new ObjectManagerInterface(() => ({
      [SERVICE_PATH]: {
        "org.bluez.GattService1": {
          UUID: new dbus.Variant("s", SERVICE_UUID),
          Primary: new dbus.Variant("b", true),
        },
      },
      [RX_PATH]: { "org.bluez.GattCharacteristic1": rx.managedProperties() },
      [TX_PATH]: { "org.bluez.GattCharacteristic1": tx.managedProperties() },
      [INFO_PATH]: { "org.bluez.GattCharacteristic1": info.managedProperties() },
    }))
  );
  bus.export(SERVICE_PATH, service);
  bus.export(RX_PATH, rx);
  bus.export(TX_PATH, tx);
  bus.export(INFO_PATH, info);
  bus.export(ADVERTISEMENT_PATH, advertisement);

  bus.on("error", error => {
    console.warn(`ble-server: system bus error: ${String(error)}`);
    context.registered = false;
    context.generation++;
    tx.StopNotify();
    handlers.onReset("system bus error");
  });

  const stopWatching = await watchDevices(bus, {
    disconnected: handlers.onDeviceDisconnected,
    reset: reason => {
      context.registered = false;
      context.generation++;
      tx.StopNotify();
      handlers.onReset(reason);
    },
    ready: () => {
      if (!context.stopped) {
        void registerWithBluez(context);
      }
    },
  });
  await registerWithBluez(context);
  const supervisor = setInterval(() => {
    if (!context.registered && !context.stopped) {
      void registerWithBluez(context);
    }
  }, REREGISTER_INTERVAL_MS);

  return {
    ready: () => context.registered,
    notify: frame => tx.sendNotification(frame),
    isDeviceConnected: device => readConnected(bus, device),
    stop: async () => {
      context.stopped = true;
      clearInterval(supervisor);
      stopWatching();
      await unregisterFromBluez(context);
      bus.disconnect();
    },
  };
}

class ServiceInterface extends Interface {
  get UUID(): string {
    return SERVICE_UUID;
  }
  get Primary(): boolean {
    return true;
  }
}
ServiceInterface.configureMembers({
  properties: {
    UUID: { signature: "s", access: "read" },
    Primary: { signature: "b", access: "read" },
  },
});

/** One class for all three characteristics; BlueZ calls only what `Flags` advertises. */
class CharacteristicInterface extends Interface {
  #uuid: string;
  #flags: string[];
  #handlers: GattHandlers;
  #value: Buffer = Buffer.alloc(0);
  #notifying = false;

  constructor(uuid: string, flags: string[], handlers: GattHandlers) {
    super("org.bluez.GattCharacteristic1");
    this.#uuid = uuid;
    this.#flags = flags;
    this.#handlers = handlers;
  }

  get UUID(): string {
    return this.#uuid;
  }
  get Service(): string {
    return SERVICE_PATH;
  }
  get Flags(): string[] {
    return this.#flags;
  }
  get Value(): Buffer {
    return this.#value;
  }
  get Notifying(): boolean {
    return this.#notifying;
  }

  ReadValue(_options: Options): Buffer {
    return Buffer.from(this.#handlers.onRead());
  }

  WriteValue(value: Buffer, options: Options): void {
    const mtu = options.mtu?.value;
    const device = options.device?.value;
    this.#handlers.onWrite(
      new Uint8Array(value),
      typeof mtu === "number" ? mtu : undefined,
      typeof device === "string" ? device : undefined
    );
  }

  StartNotify(): void {
    if (this.#notifying) return;
    this.#notifying = true;
    Interface.emitPropertiesChanged(this, { Notifying: true }, []);
    this.#handlers.onSubscribed(true);
  }

  StopNotify(): void {
    if (!this.#notifying) return;
    this.#notifying = false;
    Interface.emitPropertiesChanged(this, { Notifying: false }, []);
    this.#handlers.onSubscribed(false);
  }

  /** A notification IS a PropertiesChanged on Value; bluetoothd turns it into ATT. */
  sendNotification(frame: Bytes): void {
    if (!this.#notifying) return;
    this.#value = Buffer.from(frame);
    Interface.emitPropertiesChanged(this, { Value: this.#value }, []);
  }

  managedProperties(): Record<string, Variant> {
    return {
      UUID: new dbus.Variant("s", this.#uuid),
      Service: new dbus.Variant("o", SERVICE_PATH),
      Flags: new dbus.Variant("as", this.#flags),
    };
  }
}
CharacteristicInterface.configureMembers({
  properties: {
    UUID: { signature: "s", access: "read" },
    Service: { signature: "o", access: "read" },
    Flags: { signature: "as", access: "read" },
    Value: { signature: "ay", access: "read" },
    Notifying: { signature: "b", access: "read" },
  },
  methods: {
    ReadValue: { inSignature: "a{sv}", outSignature: "ay" },
    WriteValue: { inSignature: "aya{sv}", outSignature: "" },
    StartNotify: { inSignature: "", outSignature: "" },
    StopNotify: { inSignature: "", outSignature: "" },
  },
});

class ObjectManagerInterface extends Interface {
  #objects: () => Record<string, Record<string, Record<string, Variant>>>;

  constructor(objects: () => Record<string, Record<string, Record<string, Variant>>>) {
    super("org.freedesktop.DBus.ObjectManager");
    this.#objects = objects;
  }

  GetManagedObjects(): Record<string, Record<string, Record<string, Variant>>> {
    return this.#objects();
  }
}
ObjectManagerInterface.configureMembers({
  methods: { GetManagedObjects: { inSignature: "", outSignature: "a{oa{sa{sv}}}" } },
});

class AdvertisementInterface extends Interface {
  get Type(): string {
    return "peripheral";
  }
  get ServiceUUIDs(): string[] {
    return [SERVICE_UUID];
  }

  Release(): void {
    console.log("ble-server: bluetoothd released the advertisement");
  }
}
AdvertisementInterface.configureMembers({
  properties: {
    Type: { signature: "s", access: "read" },
    ServiceUUIDs: { signature: "as", access: "read" },
  },
  methods: { Release: { inSignature: "", outSignature: "" } },
});

interface AppContext {
  bus: BusLink;
  reset: (reason: string) => void;
  registered: boolean;
  registering: boolean;
  stopped: boolean;
  generation: number;
}

async function registerWithBluez(context: AppContext): Promise<void> {
  if (context.registering) return;
  context.registering = true;
  const generation = context.generation;
  try {
    const adapter = await bounded(context.bus.getProxyObject(BLUEZ, ADAPTER_PATH), "adapter lookup");
    const gattManager = adapter.getInterface("org.bluez.GattManager1") as GattManager;
    const advertisingManager = adapter.getInterface("org.bluez.LEAdvertisingManager1") as AdvertisingManager;
    // Unregister first, ignoring "does not exist": after a bluetoothd restart nothing is
    // registered, but after a Powered toggle BlueZ may still hold the old registration and
    // would answer AlreadyExists.
    context.reset("GATT registration replaced");
    await unregisterFromBluez(context);
    if (context.stopped || context.generation !== generation) return;
    await bounded(gattManager.RegisterApplication(APPLICATION_PATH, {}), "RegisterApplication");
    await bounded(advertisingManager.RegisterAdvertisement(ADVERTISEMENT_PATH, {}), "RegisterAdvertisement");
    if (context.stopped || context.generation !== generation) return;
    context.registered = true;
    console.log(`ble-server: advertising dashboard service ${SERVICE_UUID}`);
  } catch (error) {
    context.registered = false;
    console.warn(
      `ble-server: registration failed, retrying in ${REREGISTER_INTERVAL_MS / 1000} s: ${(error as Error).message}`
    );
  } finally {
    context.registering = false;
  }
}

async function unregisterFromBluez(context: AppContext): Promise<void> {
  try {
    const adapter = await bounded(context.bus.getProxyObject(BLUEZ, ADAPTER_PATH), "adapter lookup");
    const steps: [string, () => Promise<unknown>][] = [
      [
        "UnregisterAdvertisement",
        () =>
          (adapter.getInterface("org.bluez.LEAdvertisingManager1") as AdvertisingManager).UnregisterAdvertisement(
            ADVERTISEMENT_PATH
          ),
      ],
      [
        "UnregisterApplication",
        () => (adapter.getInterface("org.bluez.GattManager1") as GattManager).UnregisterApplication(APPLICATION_PATH),
      ],
    ];
    for (const [name, step] of steps) {
      try {
        await bounded(step(), name);
      } catch (error) {
        if ((error as { type?: string }).type === "org.bluez.Error.DoesNotExist") continue;
        console.log(`ble-server: ${name}: ${(error as Error).message}`);
      }
    }
  } catch (error) {
    console.log(`ble-server: could not reach ${ADAPTER_PATH} to unregister: ${(error as Error).message}`);
  }
  context.registered = false;
}

async function readConnected(bus: BusLink, device: string): Promise<boolean> {
  const proxy = await bus.getProxyObject(BLUEZ, device);
  const properties = proxy.getInterface("org.freedesktop.DBus.Properties") as PropertiesInterface;
  return (await properties.Get("org.bluez.Device1", "Connected")).value === true;
}
interface GattManager {
  RegisterApplication(path: string, options: Record<string, never>): Promise<void>;
  UnregisterApplication(path: string): Promise<void>;
}
interface AdvertisingManager {
  RegisterAdvertisement(path: string, options: Record<string, never>): Promise<void>;
  UnregisterAdvertisement(path: string): Promise<void>;
}
