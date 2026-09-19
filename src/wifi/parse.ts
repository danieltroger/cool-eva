// `nmcli -t` terse output in, values out. Pure the way ../can/decode.ts is pure: no
// I/O, no clock, no child process — so scripts/check-wifi-diag.ts replays output
// captured off the Pi through the very functions the Pi runs. The impure half is
// ./nmcli.ts and ./status.ts. docs/wifi.md.

/** What the radio is doing, folded from NM's own device state. */
export const WIFI_LINK_STATE = {
  /** No usable radio: unknown, unmanaged, or up but with nothing to connect to. */
  UNAVAILABLE: 0,
  /** The device could activate and is not: disconnected, deactivating, or failed. */
  DISCONNECTED: 1,
  /** Somewhere between prepare and secondaries. */
  CONNECTING: 2,
  /** Activated. */
  CONNECTED: 3,
} as const;

export type WifiLinkState = (typeof WIFI_LINK_STATE)[keyof typeof WIFI_LINK_STATE];

/** Which network the radio is on, judged by SSID rather than by profile name. */
export const WIFI_NETWORK = {
  NONE: 0,
  HOTSPOT: 1,
  OTHER: 2,
} as const;

export type WifiNetwork = (typeof WIFI_NETWORK)[keyof typeof WIFI_NETWORK];

export interface WifiListReading {
  /** The SSID of the row `nmcli` marks ACTIVE, or null when no row is active. */
  activeSsid: string | null;
  /** That row's signal 0-100, or null. */
  signalPercent: number | null;
  /** Whether the hotspot's SSID appears in the list at all, active or not. */
  hotspotSeen: boolean;
  /** Which of the three networks the active row is. */
  network: WifiNetwork;
}

/**
 * Folds `GENERAL.STATE` from `nmcli -t -f GENERAL.STATE device show <iface>`.
 *
 * ⚠️ The field holds a NUMBER AND A WORD — `GENERAL.STATE:100 (connected)` — so a
 * parser that takes the whole value gets `"100 (connected)"` and a `Number()` of it is
 * NaN. The number is the part libnm defines; the word is nmcli's own rendering.
 *
 * Thresholds are `NMDeviceState`, read out of NetworkManager 1.52.1's
 * `src/libnm-core-public/nm-dbus-interface.h` rather than remembered. docs/wifi.md §2.
 */
export function parseDeviceState(terse: string): WifiLinkState {
  const raw = fieldAfter(terse, "GENERAL.STATE");
  if (raw === null) {
    return WIFI_LINK_STATE.UNAVAILABLE;
  }
  const numeric = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(numeric)) {
    return WIFI_LINK_STATE.UNAVAILABLE;
  }
  if (numeric >= 100 && numeric < 110) {
    return WIFI_LINK_STATE.CONNECTED;
  }
  if (numeric >= 40 && numeric < 100) {
    return WIFI_LINK_STATE.CONNECTING;
  }
  if (numeric >= 30) {
    // 30 DISCONNECTED, 110 DEACTIVATING, 120 FAILED.
    return WIFI_LINK_STATE.DISCONNECTED;
  }
  return WIFI_LINK_STATE.UNAVAILABLE;
}

/**
 * Reads `nmcli -t -f ACTIVE,SSID,SIGNAL device wifi list --rescan no`.
 *
 * ⚠️ `hotspotSeen` is the decisive signal of the whole feature: "the hotspot is in
 * range AND we are not on it" is the shape of the failure this exists for, and neither
 * half says it alone.
 */
export function parseWifiList(terse: string, hotspotSsid: string): WifiListReading {
  const reading: WifiListReading = {
    activeSsid: null,
    signalPercent: null,
    hotspotSeen: false,
    network: WIFI_NETWORK.NONE,
  };
  for (const line of terse.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    const fields = splitTerseFields(line);
    if (fields.length < 3) {
      continue;
    }
    const [active, ssid, signal] = fields;
    if (ssid === hotspotSsid) {
      reading.hotspotSeen = true;
    }
    if (active === "yes" && reading.activeSsid === null) {
      reading.activeSsid = ssid;
      reading.network = ssid === hotspotSsid ? WIFI_NETWORK.HOTSPOT : WIFI_NETWORK.OTHER;
      const percent = Number.parseInt(signal, 10);
      reading.signalPercent = Number.isFinite(percent) ? percent : null;
    }
  }
  return reading;
}

/**
 * The NAMES of the saved wifi profiles, from `nmcli -t -f NAME,TYPE connection show`.
 *
 * ⚠️ A profile is addressed by NAME, UUID, path or filename — never by SSID. NetworkManager
 * 1.52.1's `nmc_find_connection()` has no SSID arm, and on this Pi the hotspot's profile is
 * called `Wi-Fi connection 2` while its SSID is something else entirely — so asking for the
 * profile by SSID can only ever answer "unknown connection". The names have to be looked up
 * before the per-profile detail can be asked for. docs/wifi.md §3.
 */
export function parseWifiProfileNames(terse: string): string[] {
  const names: string[] = [];
  for (const line of terse.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    const fields = splitTerseFields(line);
    if (fields.length >= 2 && fields[1] === "802-11-wireless" && fields[0] !== "") {
      names.push(fields[0]);
    }
  }
  return names;
}

/**
 * Splits one `nmcli -t` line into its fields.
 *
 * ⚠️ `-t` ESCAPES the separator inside a value: a BSSID prints as
 * `CC\:BA\:BD\:34\:31\:92`, and an SSID containing a colon or a backslash is escaped the
 * same way. A `.split(":")` gets seven fields out of that BSSID and silently mis-reads
 * every row after it — which on this bike would mean reading the hotspot as absent while
 * it is sitting in the list. Captured from the Pi, not imagined.
 */
export function splitTerseFields(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === "\\" && index + 1 < line.length) {
      current += line[index + 1];
      index += 1;
      continue;
    }
    if (character === ":") {
      fields.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  fields.push(current);
  return fields;
}

/** The value of a `KEY:value` line, with the same escaping rule. */
function fieldAfter(terse: string, key: string): string | null {
  for (const line of terse.split("\n")) {
    const fields = splitTerseFields(line);
    if (fields.length >= 2 && fields[0] === key) {
      return fields[1];
    }
  }
  return null;
}
