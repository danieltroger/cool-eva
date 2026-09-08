import { execFile } from "child_process";
import { promisify } from "util";
import canModule from "socketcan";
import type { RawChannel } from "socketcan";
import { CAN_BITRATE_HZ, type BringUpDecision, canConfigureArgs, decideCanBringUp } from "./link-config.ts";

const execFileAsync = promisify(execFile);

// Bring up can0 and open a raw channel. The app runs as root (systemd), so it can
// configure the interface itself at startup (see INTEGRATION_PLAN.md §bring-up).
//
// ⚠️ listen-only is STICKY on this adapter — `ip link set … type can bitrate …`
// does NOT clear it, so we pass it explicitly every time. ACTIVE mode is required
// to TX OBD-II read requests; it is read-only-safe (standard OBD reads, no writes).
//
// The down/up is SKIPPED when the link already matches what it would set, because it
// kills every other socket on can0 — including the raw capture, which is the evidence
// base for everything in docs/can-decode-findings.md. Why that is safe, and what it does
// not fix: src/can/link-config.ts and docs/can-capture.md.

export async function bringUpCan(iface = "can0", active = true): Promise<void> {
  const mode = active ? "ACTIVE (TX enabled)" : "listen-only";
  const decision = await decideBringUp(iface, active);
  if (decision.skip) {
    console.log(`can: ${iface} is already up @500k ${mode} — skipping the down/up (${decision.reason})`);
    return;
  }
  // WARN when the link could not be READ, LOG when it was read and did not match: the first
  // is either a bug here or an `ip` we do not understand, the second is routine.
  const announcement = `can: ${iface} needs configuring — ${decision.reason}; bringing it down and up (other sockets on it die here)`;
  if (decision.unreadable) {
    console.warn(announcement);
  } else {
    console.log(announcement);
  }
  try {
    await execFileAsync("ip", ["link", "set", iface, "down"]);
  } catch (err) {
    // Usually just "interface already down" on a cold start, but a persistent
    // failure here is the difference between ACTIVE and a stuck listen-only bus.
    console.log(`can: ${iface} down failed (likely already down):`, err);
  }
  await execFileAsync("ip", canConfigureArgs(iface, active));
  await execFileAsync("ip", ["link", "set", iface, "up"]);
  console.log(`can: ${iface} up @500k — ${mode}`);
}

// Re-configure and bring the interface back up after the link has dropped — the
// recovery the dashboard's "CAN bus restart" button reaches. The pair of commands run
// by hand when the bus goes down mid-ride:
//
//   ip link set can0 type can bitrate 500000
//   ip link set can0 up
//
// No `down` first, unlike bringUpCan(): this is pressed precisely because the link is
// already down, and reconfiguring an already-down interface is what works. listen-only
// is left unset on purpose — it is STICKY on this adapter (see bringUpCan), so omitting
// it keeps whatever mode the service brought the bus up in rather than flipping it. It sets
// no restart-ms either, so on a netdev recreated by an unplug/replug this leaves it at 0 and
// the NEXT service start reads a mismatch and bounces. Unchanged from before the skip landed
// and deliberately not fixed here: what this button puts on the bus is its own change.
export async function restartCanLink(iface = "can0"): Promise<void> {
  await execFileAsync("ip", ["link", "set", iface, "type", "can", "bitrate", String(CAN_BITRATE_HZ)]);
  await execFileAsync("ip", ["link", "set", iface, "up"]);
  console.log(`can: ${iface} restarted @500k`);
}

export function openChannel(iface = "can0"): RawChannel {
  // second arg = receive timestamps
  return canModule.createRawChannel(iface, true);
}

/**
 * Read the link and decide, falling back to the bounce whenever the answer is anything other
 * than a confident yes. Logs nothing itself — the caller announces the verdict once, at the
 * level `unreadable` selects, rather than the same sentence appearing twice on every start.
 */
async function decideBringUp(iface: string, active: boolean): Promise<BringUpDecision> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("ip", ["-details", "-json", "link", "show", iface]));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { skip: false, reason: `\`ip -details -json link show ${iface}\` failed: ${message}`, unreadable: true };
  }
  // `active` is forwarded verbatim, never negated here: the polarity lives in
  // link-config.ts because that is the file the check suite can drive.
  return decideCanBringUp(stdout, active);
}
