import { uptime } from "os";
import { record } from "../can/signals.ts";
import { monotonicNow, since } from "../monotonic.ts";
import { NMCLI, runCommand } from "./nmcli.ts";
import { writeWifiDump } from "./dump.ts";
import {
  WIFI_LINK_STATE,
  classifyNetwork,
  parseDeviceState,
  parseWifiList,
  type WifiLinkState,
  type WifiListReading,
} from "./parse.ts";

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
 * ⚠️ 8 s and NOT the 15 s ../can/link-status.ts uses, because it is a CONTRACT with
 * ../http/status.ts: a `source: "poll"` signal polled slower than its `FRESH_MS` reads
 * dark on a healthy Pi. Measured cost here is ~185 ms of CPU per cycle, 0.6 % of this
 * quad-core machine. Both arguments, and why `can_link` gets away with 15 s: docs/wifi.md §2.
 */
export const WIFI_POLL_MS = 8_000;

/** Per-call ceiling. Short, because a hung nmcli must not stack polls on top of each other. */
const POLL_TIMEOUT_MS = 5_000;

/**
 * How long "disconnected, with the hotspot in range" must hold before a dump is taken.
 *
 * ⚠️ Long enough that ordinary roaming cannot reach it. On 2026-09-19 NetworkManager
 * retried after twelve of thirteen failures, the quickest in 0.6 s and the slowest in
 * 14 min 58 s — so two minutes is far past any roam and still catches every one of those
 * gaps, which are the same fault class and worth a dump each.
 */
export const WIFI_FAULT_DUMP_AFTER_MS = 120_000;

/** And no more than one dump per this, however long the fault lasts. */
export const WIFI_DUMP_MIN_GAP_MS = 15 * 60_000;

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
export function startWifiMonitor(
  iface: string,
  hotspotSsid: string,
  dumpDirectory: string | null,
  intervalMs = WIFI_POLL_MS
): WifiMonitor {
  let lastReported: string | null = null;
  let polling = false;
  // Both monotonic: ../gps/clock.ts steps the wall clock, and a step would either freeze
  // the fault timer or make it fire instantly. ../monotonic.ts.
  let faultSince: number | null = null;
  let lastDumpAt: number | null = null;

  const poll = async (): Promise<void> => {
    if (polling) {
      // The previous cycle is still out. Skipping is right: two nmcli pairs in flight on
      // this Pi is the spike this file's interval was chosen to avoid, and the next tick
      // is eight seconds away.
      return;
    }
    polling = true;
    try {
      const inFault = await pollOnce(iface, hotspotSsid, line => {
        if (line !== lastReported) {
          console.log(`wifi: ${line}`);
          lastReported = line;
        }
      });
      if (!inFault) {
        faultSince = null;
      } else {
        if (faultSince === null) {
          faultSince = monotonicNow();
        }
        if (
          dumpDirectory !== null &&
          shouldDumpNow(since(faultSince), lastDumpAt === null ? null : since(lastDumpAt))
        ) {
          lastDumpAt = monotonicNow();
          const outcome = await writeWifiDump(dumpDirectory, iface, uptime());
          console.log(
            outcome.path === null
              ? "wifi-diag: the fault dump could not be written — see the warning above"
              : `wifi-diag: wrote ${outcome.path} (${outcome.problems} command(s) unhappy)`
          );
        }
      }
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

/**
 * What one cycle has learned, as signals. Pure, so the rule that matters most here is
 * reachable from a check without a radio.
 *
 * ⚠️ A FAILED READ RECORDS NOTHING. Writing `wifi_hotspot_seen = 0` because `nmcli` did
 * not answer asserts "the hotspot is not in range" — the opposite of what a failed read
 * means, and the one claim the 2026-09-19 diagnosis turns on. An unrecorded signal goes
 * stale and its group reads dark, which is the honest answer to "we cannot say".
 */
export function signalsToRecord(
  linkState: WifiLinkState | null,
  reading: WifiListReading | null,
  hotspotSsid: string
): [string, number][] {
  const signals: [string, number][] = [];
  if (linkState !== null) {
    signals.push(["wifi_link_state", linkState]);
  }
  if (reading !== null) {
    signals.push(["wifi_hotspot_seen", reading.hotspotSeen ? 1 : 0]);
    signals.push(["wifi_network", classifyNetwork(reading.activeSsid, hotspotSsid)]);
  }
  return signals;
}

/**
 * Whether to take a dump now. Pure, so scripts/check-wifi-diag.ts can walk the rule
 * without a radio: the fault must have held, and a dump must not have been taken too
 * recently however long it goes on.
 */
export function shouldDumpNow(faultHeldMs: number, msSinceLastDump: number | null): boolean {
  if (faultHeldMs < WIFI_FAULT_DUMP_AFTER_MS) {
    return false;
  }
  return msSinceLastDump === null || msSinceLastDump >= WIFI_DUMP_MIN_GAP_MS;
}

/**
 * One cycle: two reads, three signals, and a sentence for the journal when it changes.
 * Answers whether the bike is in the state worth dumping — NOT connected, while the
 * hotspot is sitting in the scan list.
 */
async function pollOnce(iface: string, hotspotSsid: string, report: (line: string) => void): Promise<boolean> {
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

  const linkState = device.exitCode === 0 ? parseDeviceState(device.stdout) : null;
  const reading = list.exitCode === 0 ? parseWifiList(list.stdout, hotspotSsid) : null;
  for (const [key, value] of signalsToRecord(linkState, reading, hotspotSsid)) {
    record(key, value);
  }

  report(describeState(linkState, reading));
  return linkState === WIFI_LINK_STATE.DISCONNECTED && reading !== null && reading.hotspotSeen;
}

/**
 * The journal sentence. Written only when it CHANGES, so a healthy boot costs a handful
 * of lines rather than one every eight seconds — ../can/link-status.ts's arrangement.
 *
 * ⚠️ A null argument is "the read failed", which is not a state of the radio. Saying
 * "radio unavailable" over a failed nmcli — as an earlier version did whenever the LIST
 * call failed on a perfectly connected bike — reports a fault that is ours, as if it were
 * the bike's.
 */
export function describeState(linkState: WifiLinkState | null, reading: WifiListReading | null): string {
  if (linkState === null) {
    return "cannot say — nmcli did not answer";
  }
  if (linkState === WIFI_LINK_STATE.CONNECTED) {
    const where = reading?.activeSsid ?? null;
    const strength = reading?.signalPercent ?? null;
    if (where === null) {
      return "connected, but the scan list did not say to what";
    }
    return `on "${where}"${strength === null ? "" : ` at ${strength} %`}`;
  }
  if (linkState === WIFI_LINK_STATE.CONNECTING) {
    return "connecting";
  }
  if (linkState === WIFI_LINK_STATE.DISCONNECTED) {
    if (reading === null) {
      return "not connected, and the scan list did not answer";
    }
    // The sentence worth having. "In range and not joined" is the 2026-09-19 shape, and
    // saying it here is what makes the ride log answer the question without an ssh.
    return reading.hotspotSeen ? "NOT connected, and the hotspot IS in range" : "not connected, hotspot not in range";
  }
  return "radio unavailable";
}
