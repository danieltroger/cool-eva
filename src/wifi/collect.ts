import { IP, IW, JOURNALCTL, NMCLI, RFKILL, runCommand, type CommandResult } from "./nmcli.ts";

// The read-only commands a wifi dump is made of, and the loop that runs them. Impure by
// definition; ./diag.ts turns what this returns into text. docs/wifi.md.
//
// ⚠️ EVERY COMMAND HERE IS A READ. Nothing in this list changes network state — no
// `connection up`, no `device disconnect`, no `radio off`. The forced rejoin is a
// separate, deliberate act that arrives with the handlebar gesture; a dump must be safe
// to take at any moment, including while a charge is running and the link is healthy.

/** Per-command ceiling. One slow call must not hold the dump up behind it. */
export const COMMAND_TIMEOUT_MS = 10_000;

/**
 * How much journal the dump carries.
 *
 * ⚠️ Bounded by BOTH time and line count. `--since` alone is unbounded in bytes, and the
 * window worth having is exactly the noisy one — the 2026-09-19 failure produced six
 * association attempts and two secret requests inside 80 seconds. 20 minutes covers the
 * whole of that boot's dead window with room either side; `--lines` stops a wedged
 * supplicant from turning the cap in ./nmcli.ts into the thing that decides.
 */
export const JOURNAL_WINDOW = "-20min";
export const JOURNAL_MAX_LINES = "20000";

/**
 * Runs the whole list, one after another, and answers with what each did.
 *
 * ⚠️ SEQUENTIAL and not `Promise.all`. This runs on a Pi Zero 2 W whose event loop also
 * serves the WebSocket and the CAN RX handler at ~100 Hz, and eleven concurrent children
 * — two of them scanning — is a spike at the one moment the rider is already unhappy.
 * The whole list costs under a second in normal conditions.
 */
export async function collectWifiState(iface: string, hotspotSsid: string): Promise<CommandResult[]> {
  const results: CommandResult[] = [];
  for (const [file, args] of readOnlyCommands(iface, hotspotSsid)) {
    results.push(await runCommand(file, args, COMMAND_TIMEOUT_MS));
  }
  return results;
}

/** The list itself, as data, so the check can assert what is in it and what is not. */
export function readOnlyCommands(iface: string, hotspotSsid: string): [string, string[]][] {
  return [
    [NMCLI, ["-f", "ALL", "device", "show", iface]],
    [NMCLI, ["-f", "ALL", "connection", "show"]],
    // ⚠️ No `--show-secrets`. Without it nmcli prints the PSK as `<hidden>`, which is the
    // control that keeps the key out of a file we may later want to paste somewhere.
    [NMCLI, ["-f", "ALL", "connection", "show", hotspotSsid]],
    // `--rescan no` reads NM's cache. A forced scan costs airtime and can disturb an
    // association, which is the opposite of what a diagnostic should do.
    [NMCLI, ["-t", "-f", "ACTIVE,SSID,SIGNAL,FREQ,BSSID,SECURITY", "device", "wifi", "list", "--rescan", "no"]],
    [NMCLI, ["general", "status"]],
    [IW, ["dev", iface, "link"]],
    // `scan dump` is the cached result; plain `scan` would force one, same argument as above.
    [IW, ["dev", iface, "scan", "dump"]],
    [IW, ["reg", "get"]],
    [RFKILL, ["list"]],
    [IP, ["-4", "addr", "show", iface]],
    [IP, ["route"]],
    [
      JOURNALCTL,
      [
        "-u",
        "NetworkManager",
        "-u",
        "wpa_supplicant",
        "--since",
        JOURNAL_WINDOW,
        "--lines",
        JOURNAL_MAX_LINES,
        "--no-pager",
        "-o",
        "short-precise",
      ],
    ],
  ];
}
