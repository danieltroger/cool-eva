import { access, readdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { setTimeout as sleep } from "timers/promises";

// Gets can0 back when the kernel gave up on the USB2CAN at boot. usb_8dev_probe() asks the
// dongle for its firmware version ONCE, waits USB_8DEV_CMD_TIMEOUT (1000 ms), and on no
// answer unregisters can0 and leaves the USB interface with no driver; nothing in the kernel
// probes it again. On 2026-11-01 a cold boot did exactly that and the service ran
// coolant-only until restarted, although writing the interface to usb_8dev's `bind` by hand
// probed first time. Evidence, the kernel source behind each decision below, and what is
// still unexplained: docs/can-adapter-probe.md.

const USB_DEVICES_DIR = "/sys/bus/usb/devices";
const USB_8DEV_DRIVER_DIR = "/sys/bus/usb/drivers/usb_8dev";
const USB_8DEV_INITSTATE = "/sys/module/usb_8dev/initstate";

// What usb_8dev_probe() itself accepts. 0483:1234 alone is a generic STMicro pair, so the
// driver also compares iProduct, and so do we.
const USB2CAN_VENDOR_ID = "0483";
const USB2CAN_PRODUCT_ID = "1234";
const USB2CAN_PRODUCT = "USB2CAN converter";

// The HTTP server only starts listening after CAN init, so every round here holds the
// dashboard back. Only a dongle that is present and keeps failing spends all of them; a
// failed probe costs ~1 s of its own on top of the delay.
const MAX_ROUNDS = 4;
const ROUND_DELAY_MS = 1000;

export type UsbDriverState = "absent" | "initialising" | "live";

export interface UsbCanAdapter {
  /** The sysfs name of the USB interface the driver binds, e.g. "1-1:1.0". */
  usbInterface: string;
  bound: boolean;
}

export interface CanAdapterSnapshot {
  netInterfacePresent: boolean;
  driverState: UsbDriverState;
  adapters: UsbCanAdapter[];
}

export type CanAdapterAction =
  | { kind: "ready" }
  | { kind: "bind"; usbInterfaces: string[] }
  | { kind: "wait"; reason: string }
  | { kind: "give-up"; reason: string };

/**
 * Returns once `iface` exists, or once re-binding cannot help or has run out of rounds.
 * Never throws: the caller's `ip` commands then fail on a missing interface exactly as
 * they did before this existed, and the service carries on coolant-only.
 */
export async function ensureCanAdapter(iface: string): Promise<void> {
  let bindAttempts = 0;
  let lastWaitReason = "";
  for (let round = 1; ; round++) {
    const action = decideAdapterAction(iface, await readAdapterSnapshot(iface));
    if (action.kind === "ready") {
      if (bindAttempts > 0) {
        console.log(`can: ${iface} is back after re-binding the USB2CAN (${bindAttempts} bind attempt(s))`);
      }
      return;
    }
    if (action.kind === "give-up") {
      console.warn(`can: ${iface} is missing and re-binding cannot help: ${action.reason}`);
      return;
    }
    if (round > MAX_ROUNDS) {
      const lastState = action.kind === "wait" ? action.reason : "the adapter is still unbound";
      console.warn(
        `can: ${iface} still missing after ${MAX_ROUNDS} rounds and ${bindAttempts} bind attempt(s) (${lastState}); continuing without it`
      );
      return;
    }
    if (action.kind === "wait") {
      if (action.reason !== lastWaitReason) {
        console.log(`can: ${iface} not there yet, waiting: ${action.reason}`);
        lastWaitReason = action.reason;
      }
      await sleep(ROUND_DELAY_MS);
      continue;
    }
    let anyBound = false;
    for (const usbInterface of action.usbInterfaces) {
      bindAttempts++;
      console.warn(
        `can: ${iface} is missing and USB2CAN ${usbInterface} has no driver (its probe failed); binding usb_8dev again, attempt ${bindAttempts}`
      );
      anyBound = (await bindAdapter(usbInterface)) || anyBound;
    }
    // The write returns only once the probe has finished, so a success is ready to re-read now.
    if (!anyBound) {
      await sleep(ROUND_DELAY_MS);
    }
  }
}

/** Pure: the whole decision, so scripts/check-can-adapter-rebind.ts can replay it. */
export function decideAdapterAction(iface: string, snapshot: CanAdapterSnapshot): CanAdapterAction {
  // Checked BEFORE the interface: the boot-time probe registers can0 before it asks for the
  // firmware version, and the kernel links the interface's `driver` before calling probe, so
  // a probe that is about to fail looks exactly like a healthy, bound adapter. The one thing
  // that tells them apart is that it runs inside module init, while initstate is "coming".
  if (snapshot.driverState === "initialising") {
    return { kind: "wait", reason: "usb_8dev is still initialising, so its boot-time probe may be in flight" };
  }
  if (snapshot.netInterfacePresent) {
    return { kind: "ready" };
  }
  if (snapshot.adapters.length === 0) {
    return { kind: "give-up", reason: "no USB2CAN converter on the USB bus. Is the dongle plugged in?" };
  }
  if (snapshot.driverState === "absent") {
    return { kind: "wait", reason: "the usb_8dev driver is not loaded yet" };
  }
  const unbound = snapshot.adapters.filter(adapter => !adapter.bound).map(adapter => adapter.usbInterface);
  if (unbound.length === 0) {
    const bound = snapshot.adapters.map(adapter => adapter.usbInterface).join(", ");
    return { kind: "give-up", reason: `USB2CAN ${bound} has a driver but there is no ${iface}. Is CAN_IFACE right?` };
  }
  return { kind: "bind", usbInterfaces: unbound };
}

/**
 * Pure: the USB device a sysfs interface entry belongs to ("1-1.3:1.0" → "1-1.3"), or null
 * for anything that is not an interface. Port 0 is the root hub's own interface ("1-0:1.0"),
 * whose device is "usb1", not "1-0", so it is excluded rather than looked up.
 */
export function usbDeviceOfInterface(entryName: string): string | null {
  const match = /^(\d+-[1-9]\d*(?:\.\d+)*):\d+\.\d+$/.exec(entryName);
  return match ? match[1] : null;
}

/**
 * Pure. A missing initstate with the driver directory present is a built-in driver, which
 * is live by the time userspace runs; "going" is a module being unloaded, as good as absent.
 */
export function parseDriverState(initstate: string | null, driverDirectoryPresent: boolean): UsbDriverState {
  const state = initstate?.trim();
  if (state === "coming") {
    return "initialising";
  }
  if (state === "going" || !driverDirectoryPresent) {
    return "absent";
  }
  return "live";
}

async function readAdapterSnapshot(iface: string): Promise<CanAdapterSnapshot> {
  const [netInterfacePresent, initstate, driverDirectoryPresent, adapters] = await Promise.all([
    pathExists(join("/sys/class/net", iface)),
    readSysfsAttribute(USB_8DEV_INITSTATE),
    pathExists(USB_8DEV_DRIVER_DIR),
    listUsbCanAdapters(),
  ]);
  return { netInterfacePresent, driverState: parseDriverState(initstate, driverDirectoryPresent), adapters };
}

async function listUsbCanAdapters(): Promise<UsbCanAdapter[]> {
  let entries: string[];
  try {
    entries = await readdir(USB_DEVICES_DIR);
  } catch (err) {
    console.warn(`can: cannot list ${USB_DEVICES_DIR}, so no USB2CAN can be found to re-bind:`, err);
    return [];
  }
  const adapters: UsbCanAdapter[] = [];
  for (const entryName of entries) {
    const device = usbDeviceOfInterface(entryName);
    if (device === null) continue;
    if (!(await isUsb2Can(join(USB_DEVICES_DIR, device)))) continue;
    adapters.push({ usbInterface: entryName, bound: await pathExists(join(USB_DEVICES_DIR, entryName, "driver")) });
  }
  return adapters;
}

async function isUsb2Can(deviceDirectory: string): Promise<boolean> {
  const [vendorId, productId, product] = await Promise.all([
    readSysfsAttribute(join(deviceDirectory, "idVendor")),
    readSysfsAttribute(join(deviceDirectory, "idProduct")),
    readSysfsAttribute(join(deviceDirectory, "product")),
  ]);
  if (vendorId?.trim() !== USB2CAN_VENDOR_ID || productId?.trim() !== USB2CAN_PRODUCT_ID) {
    return false;
  }
  // usb_8dev_probe() only refuses a device whose iProduct it could read and that differs;
  // an unreadable one is accepted, so a missing `product` is too.
  return product === null || product.trim() === USB2CAN_PRODUCT;
}

/** Resolves true when the probe succeeded. The kernel probes inside the write, so this takes as long as the probe. */
async function bindAdapter(usbInterface: string): Promise<boolean> {
  try {
    await writeFile(join(USB_8DEV_DRIVER_DIR, "bind"), usbInterface);
    return true;
  } catch (err) {
    console.warn(`can: binding usb_8dev to ${usbInterface} failed (the probe's own error; dmesg has its side):`, err);
    return false;
  }
}

/** ENOENT is an answer (no such attribute); anything else is unexpected and said out loud. */
async function readSysfsAttribute(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if (isNotFound(err)) {
      return null;
    }
    console.warn(`can: reading ${path} failed:`, err);
    return null;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (err) {
    if (isNotFound(err)) {
      return false;
    }
    console.warn(`can: checking ${path} failed:`, err);
    return false;
  }
}

function isNotFound(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "ENOENT";
}
