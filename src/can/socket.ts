import { exec } from "child_process";
import { promisify } from "util";
import canModule from "socketcan";
import type { RawChannel } from "socketcan";

const execAsync = promisify(exec);

// Bring up can0 and open a raw channel. The app runs as root (systemd), so it can
// configure the interface itself at startup (see INTEGRATION_PLAN.md §bring-up).
//
// ⚠️ listen-only is STICKY on this adapter — `ip link set … type can bitrate …`
// does NOT clear it, so we pass it explicitly every time. ACTIVE mode is required
// to TX OBD-II read requests; it is read-only-safe (standard OBD reads, no writes).

export async function bringUpCan(iface = "can0", active = true): Promise<void> {
  const listenOnly = active ? "listen-only off" : "listen-only on";
  try {
    await execAsync(`ip link set ${iface} down`);
  } catch {
    // interface may already be down — ignore
  }
  await execAsync(`ip link set ${iface} type can bitrate 500000 restart-ms 100 ${listenOnly}`);
  await execAsync(`ip link set ${iface} up`);
  console.log(`can: ${iface} up @500k — ${active ? "ACTIVE (TX enabled)" : "listen-only"}`);
}

export function openChannel(iface = "can0"): RawChannel {
  // second arg = receive timestamps
  return canModule.createRawChannel(iface, true);
}
