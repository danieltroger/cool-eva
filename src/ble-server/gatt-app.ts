import dbus from "dbus-next";
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
// tree; docs/ble-server.md §"BlueZ objects" has the shape and what was verified on the Pi.

const BLUEZ = "org.bluez";
const ADAPTER_PATH = "/org/bluez/hci0";
const APPLICATION_PATH = "/org/cooleva/ble";
const SERVICE_PATH = `${APPLICATION_PATH}/service0`;
const RX_PATH = `${SERVICE_PATH}/rx`;
const TX_PATH = `${SERVICE_PATH}/tx`;
const INFO_PATH = `${SERVICE_PATH}/info`;
const ADVERTISEMENT_PATH = `${APPLICATION_PATH}/advertisement0`;

/** "cool-eva" + a 128-bit UUID + flags is exactly the 31-byte legacy advertising budget. */
const LOCAL_NAME = "cool-eva";

/** dbus-next installs no call timeout of its own, so every call to bluetoothd is bounded. */
const BLUEZ_CALL_TIMEOUT_MS = 10_000;

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
}

export interface GattApplication {
  notify: (frame: Bytes) => void;
  stop: () => Promise<void>;
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
  get LocalName(): string {
    return LOCAL_NAME;
  }

  Release(): void {
    console.log("ble-server: bluetoothd released the advertisement");
  }
}
AdvertisementInterface.configureMembers({
  properties: {
    Type: { signature: "s", access: "read" },
    ServiceUUIDs: { signature: "as", access: "read" },
    LocalName: { signature: "s", access: "read" },
  },
  methods: { Release: { inSignature: "", outSignature: "" } },
});

interface AppContext {
  bus: ReturnType<typeof dbus.systemBus>;
  registered: boolean;
  registering: boolean;
  stopped: boolean;
}

export async function startGattApplication(handlers: GattHandlers): Promise<GattApplication> {
  const bus = dbus.systemBus();
  const context: AppContext = { bus, registered: false, registering: false, stopped: false };

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

  bus.on("error", (error: Error) => {
    console.warn(`ble-server: system bus error: ${error.message}`);
    context.registered = false;
  });

  await watchAdapter(context);
  await registerWithBluez(context);
  const supervisor = setInterval(() => {
    if (!context.registered && !context.stopped) {
      void registerWithBluez(context);
    }
  }, REREGISTER_INTERVAL_MS);

  return {
    notify: frame => tx.sendNotification(frame),
    stop: async () => {
      context.stopped = true;
      clearInterval(supervisor);
      await unregisterFromBluez(context);
      bus.disconnect();
    },
  };
}

/**
 * Both registrations die with the adapter: an rfkill toggle, the wedge power-cycle in
 * src/ble/adapter.ts, a bluetoothd restart. Powered → false marks us unregistered, and
 * the supervisor in startGattApplication() registers again once the adapter is back.
 */
async function watchAdapter(context: AppContext): Promise<void> {
  try {
    const adapter = await bounded(context.bus.getProxyObject(BLUEZ, ADAPTER_PATH), "adapter lookup");
    const properties = adapter.getInterface("org.freedesktop.DBus.Properties");
    properties.on("PropertiesChanged", (iface: string, changed: Record<string, Variant>) => {
      if (iface !== "org.bluez.Adapter1" || changed.Powered === undefined) return;
      const powered = changed.Powered.value === true;
      console.log(`ble-server: adapter powered ${powered ? "on" : "off"}`);
      context.registered = false;
      if (powered && !context.stopped) {
        void registerWithBluez(context);
      }
    });
  } catch (error) {
    console.warn(
      `ble-server: cannot watch ${ADAPTER_PATH}; re-registration falls back to the supervisor: ${(error as Error).message}`
    );
  }
}

async function registerWithBluez(context: AppContext): Promise<void> {
  if (context.registering) return;
  context.registering = true;
  try {
    const adapter = await bounded(context.bus.getProxyObject(BLUEZ, ADAPTER_PATH), "adapter lookup");
    const gattManager = adapter.getInterface("org.bluez.GattManager1");
    const advertisingManager = adapter.getInterface("org.bluez.LEAdvertisingManager1");
    // Unregister first, ignoring "does not exist": after a bluetoothd restart nothing is
    // registered, but after a Powered toggle BlueZ may still hold the old registration and
    // would answer AlreadyExists.
    await unregisterFromBluez(context);
    await bounded(gattManager.RegisterApplication(APPLICATION_PATH, {}), "RegisterApplication");
    await bounded(advertisingManager.RegisterAdvertisement(ADVERTISEMENT_PATH, {}), "RegisterAdvertisement");
    context.registered = true;
    console.log(`ble-server: advertising as "${LOCAL_NAME}" (service ${SERVICE_UUID})`);
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
        () => adapter.getInterface("org.bluez.LEAdvertisingManager1").UnregisterAdvertisement(ADVERTISEMENT_PATH),
      ],
      [
        "UnregisterApplication",
        () => adapter.getInterface("org.bluez.GattManager1").UnregisterApplication(APPLICATION_PATH),
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

async function bounded<Result>(call: Promise<Result>, what: string): Promise<Result> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what}: bluetoothd did not answer in ${BLUEZ_CALL_TIMEOUT_MS / 1000} s`)),
      BLUEZ_CALL_TIMEOUT_MS
    );
  });
  try {
    return await Promise.race([call, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
