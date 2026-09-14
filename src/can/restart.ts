import { execFile } from "child_process";
import { promisify } from "util";
import { CAN_BITRATE_HZ } from "./link-config.ts";

const execFileAsync = promisify(execFile);

// The dashboard's "CAN bus restart" button, one layer down: two `ip link` commands and
// nothing else. It touches the Pi's own interface and never the bike's bus at the frame
// level, which is why it is a POST rather than a write path.
//
// ⚠️ ITS OWN MODULE, split out of ./socket.ts, because that file imports `socketcan` — a
// Linux-only native build carried as an optionalDependency. Anything that reached this
// function through ./socket.ts dragged that binding in with it, so src/http/can-restart.ts
// could not be exercised at all on a Mac and its guard could not be checked off the Pi.
// Shelling out to `ip` needs no native module; opening a raw channel does. docs/wifi-hardening.md.

/**
 * No `down` first, unlike bringUpCan(): this is pressed precisely because the link is
 * already down, and reconfiguring an already-down interface is what works. listen-only is
 * left unset on purpose — it is STICKY on this adapter (see bringUpCan), so omitting it
 * keeps whatever mode the service brought the bus up in rather than flipping it. It sets no
 * restart-ms either, so on a netdev recreated by an unplug/replug this leaves it at 0 and
 * the NEXT service start reads a mismatch and bounces. Unchanged from before the skip
 * landed and deliberately not fixed here: what this button puts on the bus is its own change.
 */
export async function restartCanLink(iface = "can0"): Promise<void> {
  await execFileAsync("ip", ["link", "set", iface, "type", "can", "bitrate", String(CAN_BITRATE_HZ)]);
  await execFileAsync("ip", ["link", "set", iface, "up"]);
  console.log(`can: ${iface} restarted @500k`);
}
