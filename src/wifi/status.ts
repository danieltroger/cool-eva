import { record } from "../can/signals.ts";
import { NMCLI, runCommand } from "./nmcli.ts";
import { WIFI_LINK_STATE, classifyNetwork, parseDeviceState, parseWifiList } from "./parse.ts";

// Publishes what the wifi is doing as `wifi_*` signals. Not a bus signal — nothing on
// can0 reports it — so it cannot ride in on a frame; it is `nmcli` state read on a timer,
// exactly the arrangement ../can/link-status.ts uses for `can_link`.
//
// Why it exists: the Pi is reachable only when it is ON a network, which is precisely
// when nobody needs to ask what the wifi is doing. On 2026-09-19 NetworkManager latched
// the hotspot profile out of autoconnect and sat there for twenty minutes, and the only
// record of it was a journal nobody could reach. docs/wifi.md.

/**
 * How often the state is re-read.
 *
 * ⚠️ 8 s and NOT the 15 s ../can/link-status.ts uses, and the reason is a contract rather
 * than a preference. `../http/status.ts` counts a signal live only if it arrived inside
 * `FRESH_MS`, and `live === 0` is what a reader of that summary filters on to find a dead
 * source. A poll slower than FRESH_MS therefore reads as half-dark on a perfectly healthy
 * Pi — which `can_link` already does at 15 s and gets away with only because it sits in a
 * `diag` group of three dozen other signals that dilute the fraction. A six-signal `wifi`
 * group has nothing to hide behind, so the poll is faster than the window instead of
 * documenting an exception to it. scripts/check-wifi-diag.ts pins WIFI_POLL_MS < FRESH_MS.
 *
 * What it costs, measured on this Pi Zero 2 W (quad-core) rather than estimated: ten
 * sequential cycles of the two calls below take 1.289 s user + 0.560 s sys, i.e. ~185 ms
 * of CPU per cycle — 2.3 % of one core at this interval, ~0.6 % of the machine. That is a
 * floor, not a total: it excludes NetworkManager's own D-Bus work on the other side.
 */
export const WIFI_POLL_MS = 8_000;

/** Per-call ceiling. Short, because a hung nmcli must not stack polls on top of each other. */
const POLL_TIMEOUT_MS = 5_000;

export interface WifiMonitor {
  stop: () => void;
}

/**
 * Starts the poll. Returns the handle src/index.ts stops it with.
 *
 * ⚠️ Started from src/index.ts and not at module scope, the way `startCanLinkMonitor` is:
 * anything at module scope runs on IMPORT, and scripts/check-wifi-diag.ts imports this
 * module for WIFI_POLL_MS — so a poll started up here would shell out to an `nmcli` that
 * is not on a laptop, every eight seconds, for as long as the check run lasted.
 */
export function startWifiMonitor(iface: string, hotspotSsid: string, intervalMs = WIFI_POLL_MS): WifiMonitor {
  let lastReported: string | null = null;
  let polling = false;

  const poll = async (): Promise<void> => {
    if (polling) {
      // The previous cycle is still out. Skipping is right: two nmcli pairs in flight on
      // this Pi is the spike this file's interval was chosen to avoid, and the next tick
      // is eight seconds away.
      return;
    }
    polling = true;
    try {
      await pollOnce(iface, hotspotSsid, line => {
        if (line !== lastReported) {
          console.log(`wifi: ${line}`);
          lastReported = line;
        }
      });
    } catch (error) {
      // pollOnce does not throw by design; if it ever does, the timer must survive it —
      // a monitor that dies silently is worse than one that never started.
      console.warn("wifi: poll failed:", error);
    } finally {
      polling = false;
    }
  };

  void poll();
  const timer = setInterval(() => void poll(), intervalMs);
  return { stop: () => clearInterval(timer) };
}

/** One cycle: two reads, four signals, and a sentence for the journal when it changes. */
async function pollOnce(iface: string, hotspotSsid: string, report: (line: string) => void): Promise<void> {
  const device = await runCommand(NMCLI, ["-t", "-f", "GENERAL.STATE", "device", "show", iface], POLL_TIMEOUT_MS);
  const list = await runCommand(
    NMCLI,
    ["-t", "-f", "ACTIVE,SSID,SIGNAL", "device", "wifi", "list", "--rescan", "no"],
    POLL_TIMEOUT_MS
  );

  if (device.exitCode !== 0) {
    // Not fatal and not silent. A missing nmcli, a stopped NetworkManager and an
    // interface that does not exist all land here, and all three mean the same thing to
    // a reader of the ride log: we cannot say, so do not claim.
    console.warn(`wifi: ${device.command} exited ${device.exitCode}: ${device.stderr.trim()}`);
  }
  if (list.exitCode !== 0) {
    console.warn(`wifi: ${list.command} exited ${list.exitCode}: ${list.stderr.trim()}`);
  }

  const linkState = device.exitCode === 0 ? parseDeviceState(device.stdout) : WIFI_LINK_STATE.UNAVAILABLE;
  const reading = list.exitCode === 0 ? parseWifiList(list.stdout, hotspotSsid) : null;
  const network = classifyNetwork(reading?.activeSsid ?? null, hotspotSsid);

  record("wifi_link_state", linkState);
  record("wifi_network", network);
  record("wifi_hotspot_seen", reading?.hotspotSeen === true ? 1 : 0);
  if (reading?.signalPercent !== null && reading?.signalPercent !== undefined) {
    record("wifi_signal_pct", reading.signalPercent);
  }

  report(
    describe(linkState, reading?.activeSsid ?? null, reading?.hotspotSeen === true, reading?.signalPercent ?? null)
  );
}

/**
 * The journal sentence. Written only when it CHANGES, so a healthy boot costs a handful
 * of lines rather than one every eight seconds — ../can/link-status.ts's arrangement.
 */
function describe(
  linkState: number,
  activeSsid: string | null,
  hotspotSeen: boolean,
  signalPercent: number | null
): string {
  if (linkState === WIFI_LINK_STATE.CONNECTED && activeSsid !== null) {
    return `on "${activeSsid}"${signalPercent === null ? "" : ` at ${signalPercent} %`}`;
  }
  if (linkState === WIFI_LINK_STATE.CONNECTING) {
    return "connecting";
  }
  if (linkState === WIFI_LINK_STATE.DISCONNECTED) {
    // The sentence worth having. "In range and not joined" is the 2026-09-19 shape, and
    // saying it here is what makes the ride log answer the question without an ssh.
    return hotspotSeen ? "NOT connected, and the hotspot IS in range" : "not connected, hotspot not in range";
  }
  return "radio unavailable";
}
