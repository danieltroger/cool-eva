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

// ⚠️ EVERY bluetoothctl await is bounded, because bluetoothctl's own is not. Verified in
// bluez@0efa20cb: `src/shared/shell.c` arms a quit timer only `if (data.timeout)`, which
// `-t` sets and nothing else does, and `client/main.c:3436-3440` does the same — so with
// no `-t` there is no ceiling at all. Worse, `client_ready()` (main.c:3380) does not run
// the command until org.bluez is ready, so a down or restarting bluetoothd blocks it
// forever. That await sits in the reconnect loop: unbounded, it kills BLE for the rest of
// the boot and the journal says nothing. Same class as #287.
const BLUETOOTHCTL_TIMEOUT_MS = 10_000;

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
    await runCommand("bluetoothctl", ["power", "on"], { timeout: BLUETOOTHCTL_TIMEOUT_MS });
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
  // ⚠️ No `bluetoothctl show` read-back between these two. It used to sit here, justified by
  // a race with ensureBluetoothAdapterUp() — but that race cannot happen in the shipped
  // wiring: the reconnect loop is serialised and ensureBluetoothAdapterUp() only runs inside
  // runSession(). What the 2026-09-19 transcript actually caught was the SERVICE racing a
  // hand-run experiment, which is a note for whoever bounces the adapter by hand (stop the
  // service first) and not a thing to spend a spawn on. It also sat inside the gap, so its
  // own timeout could hold the radio down for 11 s in the one function contracted never to
  // leave it off. Whether the bounce worked is answered by the next session, loudly, through
  // ESCALATE_AFTER_RESETS in ./recovery.ts.
  await runBluetoothctl(["power", "off"]);
  await delay(POWER_CYCLE_GAP_MS);
  await runBluetoothctl(["power", "on"]);
}

/** Never throws, always bounded. The timeout lives here once, not at each call site. */
async function runBluetoothctl(args: string[]): Promise<void> {
  const what = `\`bluetoothctl ${args.join(" ")}\``;
  try {
    const { stdout } = await runCommand("bluetoothctl", args, { timeout: BLUETOOTHCTL_TIMEOUT_MS });
    console.warn(`ble: adapter reset — ${what}: ${stdout.trim().split("\n").pop() || "(no output)"}`);
  } catch (error) {
    // `killed` without a maxBuffer overflow IS the timeout firing — measured and written
    // down in src/wifi/nmcli.ts, whose runCommand() returns it as data. Without naming it
    // here a 10 s hang reads exactly like bluetoothd refusing the command.
    const killed = (error as { killed?: boolean }).killed === true;
    const why = killed ? `no answer in ${BLUETOOTHCTL_TIMEOUT_MS} ms, killed` : (error as Error).message;
    console.warn(`ble: adapter reset — ${what} failed: ${why}`);
  }
}
