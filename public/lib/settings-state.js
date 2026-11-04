// @ts-check

/** @typedef {import("../../src/settings/view.ts").SettingsReply} SettingsReply */

/** @param {SettingsReply | null} current @param {boolean} confirmed @param {keyof import("../../src/settings/schema.ts").StartupSettings} key @param {boolean} dirty */
export function settingsStateLines(current, confirmed, key, dirty) {
  const lines = dirty ? ["Draft — not saved."] : [];
  if (current && !current.ok) {
    if (!confirmed) {
      lines.push("Pi unconfirmed. Reconnect before retrying settings.");
    }
    lines.push("Saved choice unreadable. The original document is retained.");
    lines.push(
      `${confirmed ? "Active safe default" : "Safe default at last contact"}: ${settingChoice(current.active, key)}.`
    );
    return lines;
  }
  if (!current || !confirmed) {
    lines.push("Pi unconfirmed. Reconnect before saving or restarting.");
    if (!current) return lines;
    lines.push(`Last confirmed saved: ${settingChoice(current.saved, key)}.`);
    lines.push(`Active at last contact: ${settingChoice(current.active, key)}.`);
    return lines;
  }
  const pending =
    current.pending.includes(key) || (key === "hubAddress" && current.pending.includes("discoverHubOnce"));
  lines.push(`${pending ? "Saved for next start" : "Saved"}: ${settingChoice(current.saved, key)}.`);
  lines.push(`Active now: ${settingChoice(current.active, key)}.`);
  return lines;
}

/** @param {SettingsReply} current */
export function pendingChoiceDescriptions(current) {
  return [...new Set(current.pending.map(key => (key === "discoverHubOnce" ? "hubAddress" : key)))].map(
    key => `${settingName(key)}: ${settingChoice(current.saved, key)}`
  );
}

/** @param {SettingsReply["saved"]} values @param {string} key */
export function settingChoice(values, key) {
  if (key === "dashboardBluetoothSecret") return values.bluetoothCodeId ? "On (saved key)" : "Off";
  if (key === "rideLogPublicKeyPem") return values.recordingKeyConfigured ? "Public key configured" : "No public key";
  if (key === "hubAddress")
    return values.hubAddress ?? (values.discoverHubOnce ? "Discover once, then remember" : "None");
  const value = values[/** @type {keyof SettingsReply["saved"]} */ (key)];
  if (typeof value === "boolean")
    return key === "customBmsConfigurationFlashed" ? (value ? "Yes" : "No") : value ? "On" : "Off";
  return value === "" || value === null || value === undefined ? "Not set" : String(value);
}

/** @param {string} key */
export function settingName(key) {
  return (
    /** @type {Record<string, string>} */ ({
      coolantProbesEnabled: "Coolant probes",
      radiatorFanEnabled: "Radiator fan",
      customBmsConfigurationFlashed: "Custom BMS configuration",
      automaticDcChargingEnabled: "Automatic current reduction",
      dashboardBluetoothSecret: "Dashboard Bluetooth key",
      phoneHotspotSsid: "Hotspot connection checks",
      rideLogDirectory: "Recording directory",
      vcuParameterDirectory: "Service data directory",
      rideLogPublicKeyPem: "Recording public key",
      hubAddress: "Motorcycle connection",
      discoverHubOnce: "Motorcycle connection",
    })[key] ?? key
  );
}
