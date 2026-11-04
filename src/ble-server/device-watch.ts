import { bounded, type BusLink } from "./dbus-link.ts";

export async function watchDevices(bus: BusLink, events: DeviceEvents): Promise<() => void> {
  const proxy = await bounded(bus.getProxyObject("org.freedesktop.DBus", "/org/freedesktop/DBus"), "bus daemon lookup");
  const control = proxy.getInterface("org.freedesktop.DBus") as BusControl;
  const state: WatchState = { owner: "", events, stopped: false, epoch: 0 };
  const listener = (message: unknown) => receiveSignal(state, message);
  bus.on("message", listener);
  try {
    for (const rule of RULES) {
      await bounded(control.AddMatch(rule), "signal subscription");
    }
    const epoch = state.epoch;
    try {
      const owner = await bounded(control.GetNameOwner("org.bluez"), "BlueZ owner lookup");
      if (state.epoch === epoch) {
        state.owner = owner;
      }
    } catch (error) {
      console.warn(`ble-server: cannot identify bluetoothd yet: ${(error as Error).message}`);
    }
  } catch (error) {
    bus.off("message", listener);
    throw error;
  }
  return () => {
    state.stopped = true;
    bus.off("message", listener);
  };
}

export interface DeviceEvents {
  disconnected: (device: string) => void;
  reset: (reason: string) => void;
  ready: () => void;
}
interface BusControl {
  AddMatch(rule: string): Promise<void>;
  GetNameOwner(name: string): Promise<string>;
}
interface WatchState {
  owner: string;
  events: DeviceEvents;
  stopped: boolean;
  epoch: number;
}
const RULES = [
  "type='signal',sender='org.freedesktop.DBus',interface='org.freedesktop.DBus',member='NameOwnerChanged',arg0='org.bluez'",
  "type='signal',sender='org.bluez',interface='org.freedesktop.DBus.Properties',member='PropertiesChanged',path_namespace='/org/bluez'",
  "type='signal',sender='org.bluez',interface='org.freedesktop.DBus.ObjectManager',member='InterfacesRemoved'",
];
function receiveSignal(state: WatchState, message: unknown): void {
  if (state.stopped || !record(message) || message.type !== 4 || !Array.isArray(message.body)) return;
  const body: unknown[] = message.body;
  if (
    message.sender === "org.freedesktop.DBus" &&
    message.interface === "org.freedesktop.DBus" &&
    message.member === "NameOwnerChanged"
  ) {
    const [name, previous, next] = body;
    if (name !== "org.bluez" || typeof previous !== "string" || typeof next !== "string" || previous === next) return;
    state.owner = next;
    state.epoch++;
    state.events.reset("bluetoothd owner changed");
    if (next) {
      state.events.ready();
    }
    return;
  }
  if (!state.owner || message.sender !== state.owner) return;
  if (message.interface === "org.freedesktop.DBus.ObjectManager" && message.member === "InterfacesRemoved") {
    const [path, interfaces] = body;
    if (
      typeof path === "string" &&
      path.startsWith("/org/bluez/") &&
      Array.isArray(interfaces) &&
      interfaces.includes("org.bluez.Device1")
    ) {
      state.events.disconnected(path);
    }
  }
  if (
    message.interface !== "org.freedesktop.DBus.Properties" ||
    message.member !== "PropertiesChanged" ||
    typeof message.path !== "string"
  )
    return;
  const [iface, changed] = body;
  if (!record(changed)) return;
  if (
    iface === "org.bluez.Device1" &&
    message.path.startsWith("/org/bluez/") &&
    record(changed.Connected) &&
    changed.Connected.value === false
  ) {
    state.events.disconnected(message.path);
  }
  if (iface === "org.bluez.Adapter1" && message.path === "/org/bluez/hci0" && record(changed.Powered)) {
    if (changed.Powered.value === false) {
      state.events.reset("adapter powered off");
    }
    if (changed.Powered.value === true) {
      state.events.ready();
    }
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
