import { uptime } from "os";
import { record } from "../can/signals.ts";
import { monotonicNow, since } from "../monotonic.ts";
import { NMCLI, runCommand } from "./nmcli.ts";
import { writeWifiDump } from "./dump.ts";
import { WIFI_LINK_STATE, parseDeviceState, parseWifiList, type WifiLinkState, type WifiListReading } from "./parse.ts";

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

/**
 * Per-call ceiling, and it has to clear an arithmetic bar rather than just be "short".
 *
 * ⚠️ TWO of these run per cycle, sequentially, so 2 × this must stay INSIDE WIFI_POLL_MS.
 * At 5 s — what this was — a worst cycle is 10 s against an 8 s interval, the guard below
 * skips a tick, and two skipped ticks compound into a 16 s hole. At 3 s a timing-out cycle
 * still cannot skip one. A healthy cycle is ~282 ms. docs/wifi.md §2 has the rest.
 */
export const WIFI_POLL_TIMEOUT_MS = 3_000;

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
  dumpDirectory: string,
  intervalMs = WIFI_POLL_MS
): WifiMonitor {
  let lastReported: string | null = null;
  let polling = false;
  // Both monotonic: ../gps/clock.ts steps the wall clock, and a step would either freeze
  // the fault timer or make it fire instantly. ../monotonic.ts.
  let faultSince: number | null = null;
  let lastDumpAt: number | null = null;
  // ⚠️ Its OWN flag, and the dump is never awaited by the poll. A dump runs a dozen
  // children and can take a minute; held inside `polling` it would skip poll after poll
  // and leave the group reading dark on /status through exactly the fault it is dumping —
  // defeating WIFI_POLL_MS's contract by a path no check can see.
  let dumping = false;

  if (hotspotSsid === "") {
    // ⚠️ LOUD, because the alternative is the failure this whole feature exists to catch:
    // something that quietly stops trying and tells nobody. With no SSID configured,
    // `wifi_hotspot_seen` has no meaning and the fault dump can never fire — the radio's
    // own state is still recorded. docs/wifi.md §2.
    console.warn(
      "wifi: WIFI_HOTSPOT_SSID is not set, so the hotspot half is OFF — no wifi_hotspot_seen, " +
        "no wifi_network and no fault dumps. Set it in /etc/default/cool-eva and restart."
    );
  }

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
        faultSince ??= monotonicNow();
        if (!dumping && shouldDumpNow(since(faultSince), lastDumpAt === null ? null : since(lastDumpAt))) {
          lastDumpAt = monotonicNow();
          dumping = true;
          void writeWifiDump(dumpDirectory, iface, uptime())
            .then(written => {
              console.log(
                written === null
                  ? "wifi-diag: the fault dump could not be written — see the warning above"
                  : `wifi-diag: wrote ${written}`
              );
            })
            .catch(error => {
              // writeWifiDump does not throw by design; if it ever does, an escaped
              // rejection ends the process and takes the CAN logging with it.
              console.warn("wifi-diag: the fault dump threw:", error);
            })
            .finally(() => {
              dumping = false;
            });
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
export function signalsToRecord(linkState: WifiLinkState | null, reading: WifiListReading | null): [string, number][] {
  const signals: [string, number][] = [];
  if (linkState !== null) {
    signals.push(["wifi_link_state", linkState]);
  }
  if (reading !== null) {
    signals.push(["wifi_hotspot_seen", reading.hotspotSeen ? 1 : 0]);
    signals.push(["wifi_network", reading.network]);
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
  const results = [
    await runCommand(NMCLI, ["-t", "-f", "GENERAL.STATE", "device", "show", iface], WIFI_POLL_TIMEOUT_MS),
  ];
  // ⚠️ The second call is SKIPPED when no hotspot SSID is configured. Without one there is
  // nothing to compare the scan list against, so asking costs a fork and buys a number
  // that would have to be thrown away — and the startup warning has already said so.
  if (hotspotSsid !== "") {
    results.push(
      await runCommand(
        NMCLI,
        ["-t", "-f", "ACTIVE,SSID,SIGNAL", "device", "wifi", "list", "--rescan", "no"],
        WIFI_POLL_TIMEOUT_MS
      )
    );
  }
  const [device, list] = results;

  for (const result of results) {
    if (result.exitCode !== 0) {
      // Not fatal and not silent. A missing nmcli, a stopped NetworkManager and an
      // interface that does not exist all land here, and all three mean the same to a
      // reader of the ride log: we cannot say, so do not claim.
      console.warn(`wifi: ${result.command} exited ${result.exitCode}: ${result.stderr.trim()}`);
    }
  }

  const linkState = device.exitCode === 0 ? parseDeviceState(device.stdout) : null;
  const reading = list !== undefined && list.exitCode === 0 ? parseWifiList(list.stdout, hotspotSsid) : null;
  for (const [key, value] of signalsToRecord(linkState, reading)) {
    record(key, value);
  }

  report(describeState(linkState, reading, hotspotSsid !== ""));
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
export function describeState(
  linkState: WifiLinkState | null,
  reading: WifiListReading | null,
  hotspotConfigured = true
): string {
  if (linkState === null) {
    return "cannot say — nmcli did not answer";
  }
  if (!hotspotConfigured) {
    // No SSID to compare against, so every sentence below that mentions the hotspot
    // would be inventing one. Say only what the device state actually proves.
    return linkState === WIFI_LINK_STATE.CONNECTED
      ? "connected (no WIFI_HOTSPOT_SSID set)"
      : `not connected (no WIFI_HOTSPOT_SSID set)`;
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
