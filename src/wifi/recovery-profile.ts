import { COMMAND_TIMEOUT_MS } from "./collect.ts";
import { NMCLI, runCommand } from "./nmcli.ts";
import { parseWifiProfileNames } from "./parse.ts";
import { networkCandidateExcluded } from "./operation.ts";

export async function hotspotProfileUuid(
  hotspotSsid: string,
  command: typeof runCommand = runCommand
): Promise<string | null> {
  const listing = await command(NMCLI, ["-t", "-f", "UUID,TYPE", "connection", "show"], COMMAND_TIMEOUT_MS);
  if (listing.exitCode !== 0) {
    console.warn(`wifi-recover: profile listing exited ${listing.exitCode}`);
    return null;
  }
  for (const uuid of parseWifiProfileNames(listing.stdout)) {
    if (networkCandidateExcluded(uuid)) continue;
    const detail = await command(
      NMCLI,
      ["-g", "connection.id,connection.autoconnect,802-11-wireless.ssid", "connection", "show", "uuid", uuid],
      COMMAND_TIMEOUT_MS
    );
    if (detail.exitCode !== 0) {
      console.warn(`wifi-recover: profile details exited ${detail.exitCode}`);
      continue;
    }
    const [name, autoconnect, ...ssid] = detail.stdout.trimEnd().split("\n");
    // The ledger may be unreadable at boot. NM's candidate marker still keeps recovery safe.
    if (/^(?:netplan-)?cool-eva-/.test(name) && autoconnect === "no") continue;
    if (ssid.join("\n") === hotspotSsid) return uuid;
  }
  return null;
}
