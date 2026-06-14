import { execSync } from 'child_process';
import canModule from 'socketcan';
import type { RawChannel } from 'socketcan';

// Bring up can0 and open a raw channel. The app runs as root (systemd), so it can
// configure the interface itself at startup (see INTEGRATION_PLAN.md §bring-up).
//
// ⚠️ listen-only is STICKY on this adapter — `ip link set … type can bitrate …`
// does NOT clear it, so we pass it explicitly every time. ACTIVE mode is required
// to TX OBD-II read requests; it is read-only-safe (standard OBD reads, no writes).

export function bringUpCan(iface = 'can0', active = true): void {
  const listenOnly = active ? 'listen-only off' : 'listen-only on';
  try {
    execSync(`ip link set ${iface} down`, { stdio: 'ignore' });
  } catch {
    // interface may already be down — ignore
  }
  execSync(`ip link set ${iface} type can bitrate 500000 restart-ms 100 ${listenOnly}`);
  execSync(`ip link set ${iface} up`);
  console.log(`can: ${iface} up @500k — ${active ? 'ACTIVE (TX enabled)' : 'listen-only'}`);
}

export function openChannel(iface = 'can0'): RawChannel {
  // second arg = receive timestamps
  return canModule.createRawChannel(iface, true);
}
