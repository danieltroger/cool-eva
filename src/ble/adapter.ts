import { execFile } from "child_process";
import { readdir, readFile, writeFile } from "fs/promises";
import { setTimeout as delay } from "timers/promises";
import { promisify } from "util";

const runCommand = promisify(execFile);

const RFKILL_DIR = "/sys/class/rfkill";

// Verified on the bike 2026-09-19 22:21:46: `power off`, this gap, `power on` cleared a
// wedge that had refused 2 642 consecutive StartDiscovery calls over 3 h 53 min. Kept at
// the 1 s the experiment used rather than anything shorter, which is untested.
const POWER_CYCLE_GAP_MS = 1_000;

// On this Pi image Bluetooth comes up rfkill soft-blocked with hci0 DOWN, so
// every BLE connect fails until it's cleared. Doing it here rather than in the
// systemd unit means it also fixes installs that predate the BLE work — the unit
// is only ever written by scripts/setup-service.ts. Clearing the block through
// sysfs also avoids depending on the `rfkill` binary, which isn't installed, or
// on `hciconfig`, which is deprecated and gone from newer images.
async function clearBluetoothRfkillBlock(): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(RFKILL_DIR);
  } catch (error) {
    console.log(`ble: no ${RFKILL_DIR} to inspect, assuming no rfkill block: ${(error as Error).message}`);
    return;
  }

  for (const entry of entries) {
    try {
      const deviceType = (await readFile(`${RFKILL_DIR}/${entry}/type`, "utf-8")).trim();
      if (deviceType !== "bluetooth") {
        continue;
      }
      const softBlocked = (await readFile(`${RFKILL_DIR}/${entry}/soft`, "utf-8")).trim();
      if (softBlocked === "1") {
        await writeFile(`${RFKILL_DIR}/${entry}/soft`, "0");
        console.log(`ble: cleared rfkill soft block on ${entry}`);
      }
    } catch (error) {
      console.warn(`ble: could not clear rfkill on ${entry}:`, (error as Error).message);
    }
  }
}

/**
 * Best-effort: make sure the local Bluetooth adapter is unblocked and powered.
 * Never throws — if this fails the connect attempt will report the real problem.
 */
export async function ensureBluetoothAdapterUp(): Promise<void> {
  await clearBluetoothRfkillBlock();
  try {
    await runCommand("bluetoothctl", ["power", "on"]);
  } catch (error) {
    console.warn("ble: `bluetoothctl power on` failed:", (error as Error).message);
  }
}

/**
 * Power the adapter off and on again, the only lever userspace has on a stuck
 * kernel discovery state. `power on` alone cannot do it — the adapter is already
 * on. Never throws: BLE is already dead when this runs. docs/ble-adapter-wedge.md.
 */
export async function resetBluetoothAdapter(): Promise<void> {
  await runBluetoothctl(["power", "off"]);
  // Read it back rather than trusting the command: on 2026-09-19 the service's own
  // `power on` beat the experiment's by a second, so "we ran it" is not "it went down".
  console.warn(`ble: adapter reset — between off and on, ${await readAdapterPowered()}`);
  await delay(POWER_CYCLE_GAP_MS);
  await runBluetoothctl(["power", "on"]);
}

async function runBluetoothctl(args: string[]): Promise<void> {
  try {
    const { stdout } = await runCommand("bluetoothctl", args);
    const lastLine = stdout.trim().split("\n").pop();
    console.warn(`ble: adapter reset — \`bluetoothctl ${args.join(" ")}\`: ${lastLine || "(no output)"}`);
  } catch (error) {
    console.warn(`ble: adapter reset — \`bluetoothctl ${args.join(" ")}\` failed:`, (error as Error).message);
  }
}

async function readAdapterPowered(): Promise<string> {
  try {
    const { stdout } = await runCommand("bluetoothctl", ["show"]);
    const powered = stdout.split("\n").find(line => line.includes("Powered:"));
    return powered ? powered.trim() : "Powered: (not reported by `bluetoothctl show`)";
  } catch (error) {
    return `Powered: (unreadable: ${(error as Error).message})`;
  }
}
