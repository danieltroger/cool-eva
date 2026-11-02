import { readFile } from "fs/promises";
import {
  type CanAdapterAction,
  type CanAdapterSnapshot,
  decideAdapterAction,
  parseDriverState,
  usbDeviceOfInterface,
} from "../src/can/adapter-rebind.ts";

// Covers the decision behind ensureCanAdapter(): when the service re-binds usb_8dev to a
// USB2CAN the kernel gave up on at boot, when it waits, and when it gives up and lets the
// service run coolant-only.
//
//     node --experimental-strip-types scripts/check-can-adapter-rebind.ts
//
// ⚠️ Every snapshot here is SYNTHETIC. The first is RECONSTRUCTED from the 2026-11-01
// failure (dmesg, `lsusb -t` showing `Driver=[none]`, and a hand-written `bind` that then
// probed), not captured as a snapshot; the rest are the shapes the kernel source says the
// other states take. docs/can-adapter-probe.md quotes that source.

const FAILED_AT_BOOT: CanAdapterSnapshot = {
  netInterfacePresent: false,
  driverState: "live",
  adapters: [{ usbInterface: "1-1:1.0", bound: false }],
};

interface Case {
  name: string;
  snapshot: CanAdapterSnapshot;
  expected: CanAdapterAction["kind"];
  /** For "bind": exactly the interfaces it must write. */
  binds?: string[];
  /** For "wait" / "give-up": a fragment the journal line must carry. */
  because?: string;
}

const CASES: Case[] = [
  {
    name: "the 2026-11-01 boot: no can0, driver live, the dongle unbound",
    snapshot: FAILED_AT_BOOT,
    expected: "bind",
    binds: ["1-1:1.0"],
  },
  {
    name: "healthy: can0 present and the dongle bound",
    snapshot: { netInterfacePresent: true, driverState: "live", adapters: [{ usbInterface: "1-1:1.0", bound: true }] },
    expected: "ready",
  },
  // ⚠️ The case that makes "can0 exists and the interface is bound" insufficient: mid-probe,
  // usb_8dev has registered can0 and the kernel has created the `driver` link, and the probe
  // can still fail and take both away.
  {
    name: "boot-time probe in flight: can0 and the driver link both exist already",
    snapshot: {
      netInterfacePresent: true,
      driverState: "initialising",
      adapters: [{ usbInterface: "1-1:1.0", bound: true }],
    },
    expected: "wait",
    because: "initialising",
  },
  {
    name: "service started before udev loaded usb_8dev",
    snapshot: {
      netInterfacePresent: false,
      driverState: "absent",
      adapters: [{ usbInterface: "1-1:1.0", bound: false }],
    },
    expected: "wait",
    because: "not loaded",
  },
  {
    name: "no dongle on the bus",
    snapshot: { netInterfacePresent: false, driverState: "live", adapters: [] },
    expected: "give-up",
    because: "plugged in",
  },
  {
    name: "no dongle and no driver: give up rather than wait for a driver nothing will need",
    snapshot: { netInterfacePresent: false, driverState: "absent", adapters: [] },
    expected: "give-up",
    because: "plugged in",
  },
  {
    name: "dongle bound but no such interface: a wrong CAN_IFACE, which re-binding cannot fix",
    snapshot: { netInterfacePresent: false, driverState: "live", adapters: [{ usbInterface: "1-1:1.0", bound: true }] },
    expected: "give-up",
    because: "CAN_IFACE",
  },
  {
    name: "a non-USB interface (vcan) with no dongle is ready, not a reason to wait",
    snapshot: { netInterfacePresent: true, driverState: "absent", adapters: [] },
    expected: "ready",
  },
  {
    name: "two dongles, one bound: only the unbound one is written",
    snapshot: {
      netInterfacePresent: false,
      driverState: "live",
      adapters: [
        { usbInterface: "1-1.2:1.0", bound: true },
        { usbInterface: "1-1.3:1.0", bound: false },
      ],
    },
    expected: "bind",
    binds: ["1-1.3:1.0"],
  },
];

const failures: string[] = [];

for (const testCase of CASES) {
  const action = decideAdapterAction("can0", testCase.snapshot);
  if (action.kind !== testCase.expected) {
    failures.push(`${testCase.name}: expected ${testCase.expected}, got ${JSON.stringify(action)}`);
    continue;
  }
  if (action.kind === "bind" && JSON.stringify(action.usbInterfaces) !== JSON.stringify(testCase.binds)) {
    failures.push(
      `${testCase.name}: binds ${JSON.stringify(action.usbInterfaces)}, expected ${JSON.stringify(testCase.binds)}`
    );
    continue;
  }
  if ((action.kind === "wait" || action.kind === "give-up") && !action.reason.includes(testCase.because ?? "")) {
    failures.push(`${testCase.name}: reason "${action.reason}" does not mention "${testCase.because}"`);
    continue;
  }
  console.log(`  ✓ ${testCase.name} → ${action.kind}`);
}

const INTERFACE_NAMES: [string, string | null][] = [
  ["1-1:1.0", "1-1"],
  ["1-1.3:1.0", "1-1.3"],
  ["2-1.4.2:1.1", "2-1.4.2"],
  ["1-0:1.0", null], // the root hub's own interface; its device is usb1, not 1-0
  ["usb1", null],
  ["1-1", null], // a device, not an interface
];
for (const [entryName, expected] of INTERFACE_NAMES) {
  const device = usbDeviceOfInterface(entryName);
  if (device !== expected) {
    failures.push(
      `usbDeviceOfInterface(${JSON.stringify(entryName)}) = ${JSON.stringify(device)}, expected ${JSON.stringify(expected)}`
    );
  }
}

const DRIVER_STATES: [string | null, boolean, string][] = [
  ["coming\n", true, "initialising"],
  ["live\n", true, "live"],
  [null, true, "live"], // built in: no initstate, but the driver is registered
  [null, false, "absent"],
  ["going\n", true, "absent"],
];
for (const [initstate, driverDirectoryPresent, expected] of DRIVER_STATES) {
  const state = parseDriverState(initstate, driverDirectoryPresent);
  if (state !== expected) {
    failures.push(
      `parseDriverState(${JSON.stringify(initstate)}, ${driverDirectoryPresent}) = ${state}, expected ${expected}`
    );
  }
}

// The decision is only worth anything if bringUpCan() runs it before reading the link.
const socketSource = await readFile(new URL("../src/can/socket.ts", import.meta.url), "utf8");
const ensureAt = socketSource.indexOf("await ensureCanAdapter(iface)");
const decideAt = socketSource.indexOf("await decideBringUp(iface, active)");
if (ensureAt === -1 || decideAt === -1 || ensureAt > decideAt) {
  failures.push("src/can/socket.ts no longer awaits ensureCanAdapter(iface) before decideBringUp() in bringUpCan()");
}

if (failures.length > 0) {
  console.error("\nFAILED:");
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  process.exit(1);
}
console.log(
  `\n✓ ${CASES.length} adapter decisions, ${INTERFACE_NAMES.length} sysfs names, ${DRIVER_STATES.length} driver states, and the call order in bringUpCan()`
);
