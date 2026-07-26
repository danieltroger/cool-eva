import { execFile } from "child_process";
import { readdir, readFile, writeFile } from "fs/promises";
import { promisify } from "util";

const runCommand = promisify(execFile);

const RFKILL_DIR = "/sys/class/rfkill";

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
