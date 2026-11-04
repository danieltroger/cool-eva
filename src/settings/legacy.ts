import { join, resolve } from "path";
import { freshSettings, parseSettingsDocument, type SettingsDocument } from "./schema.ts";
import type { SettingsPaths } from "./paths.ts";

export function importLegacyEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  context: LegacyContext
): LegacyImport {
  const captured = captureLegacyEnvironment(environment);
  const document = freshSettings(context.paths);
  const suppliedKeys = Object.keys(captured).sort();
  const coolantWasExplicit = captured.COOLANT_ENABLED !== undefined;
  const normalizedHub = captured.BLE_MAC?.trim().replaceAll("-", ":").toUpperCase() || null;
  const invalidHub = normalizedHub !== null && !/^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(normalizedHub);
  document.values = {
    ...document.values,
    coolantProbesEnabled: coolantWasExplicit && captured.COOLANT_ENABLED !== "0",
    radiatorFanEnabled: captured.FAN_ENABLED === "1",
    customBmsConfigurationFlashed: captured.CUSTOM_BMS_CONFIG === "1",
    automaticDcChargingEnabled: captured.CHARGE_AUTO_ENABLED !== "0",
    phoneHotspotSsid: captured.WIFI_HOTSPOT_SSID ?? "",
    dashboardBluetoothSecret: captured.BLE_SECRET ?? "",
    hubAddress: invalidHub ? null : normalizedHub,
    discoverHubOnce: !captured.BLE_MAC,
    rideLogDirectory: legacyPath(captured.RIDE_LOG_DIR || undefined, "ride-logs", context),
    vcuParameterDirectory: legacyPath(captured.VCU_PARAM_DIR || undefined, "vcu-params", context),
  };
  document.migration = {
    source: "legacy",
    complete: false,
    pendingPublicKeyPath:
      captured.RIDE_LOG_PUBKEY === undefined
        ? join(context.codeDirectory, "ride-log-key.public.pem")
        : captured.RIDE_LOG_PUBKEY === ""
          ? ""
          : resolve(context.workingDirectory, captured.RIDE_LOG_PUBKEY),
    suppliedLegacyKeys: suppliedKeys,
    notices: [
      ...(!coolantWasExplicit ? ["coolant-default-off"] : []),
      ...(!captured.BLE_MAC ? ["hub-discover-once"] : []),
      ...(invalidHub ? ["hub-address-invalid"] : []),
      ...(captured.RIDE_LOG_DIR === "" ? ["ride-log-directory-empty"] : []),
      ...(captured.VCU_PARAM_DIR === "" ? ["vcu-directory-empty"] : []),
      ...suppliedKeys.filter(key => RETIRED_KEYS.has(key)).map(key => `retired:${key}`),
    ],
  };
  return {
    document: parseSettingsDocument(document).document,
    publicKeyWasExplicit: captured.RIDE_LOG_PUBKEY !== undefined,
    sourceDirectories: {
      rideLogDirectory: document.values.rideLogDirectory,
      vcuParameterDirectory: document.values.vcuParameterDirectory,
      wifiDiagnosticDirectory: join(context.codeDirectory, "wifi-diag"),
      captureDirectory: context.captureDirectory ?? "/home/pi/ride-captures",
    },
  };
}

export interface LegacyContext {
  codeDirectory: string;
  workingDirectory: string;
  paths: SettingsPaths;
  captureDirectory?: string;
}

export interface LegacyImport {
  document: SettingsDocument;
  publicKeyWasExplicit: boolean;
  sourceDirectories: {
    rideLogDirectory: string;
    vcuParameterDirectory: string;
    wifiDiagnosticDirectory: string;
    captureDirectory: string;
  };
}

const LEGACY_KEYS = [
  "COOLANT_ENABLED",
  "FAN_ENABLED",
  "CAN_ENABLED",
  "OBD_ENABLED",
  "ELOCK_ENABLED",
  "WIFI_ENABLED",
  "WIFI_IFACE",
  "WIFI_HOTSPOT_SSID",
  "BLE_ENABLED",
  "BLE_MAC",
  "BLE_SECRET",
  "GPS_TIME_SYNC",
  "CUSTOM_BMS_CONFIG",
  "RIDE_LOG_PUBKEY",
  "RIDE_LOG_DIR",
  "VCU_PARAM_DIR",
  "SERVICE_MODE_ENABLED",
  "SERVICE_WRITE_ENABLED",
  "UPDATE_DIR",
  "CHARGE_AUTO_ENABLED",
] as const;

const RETIRED_KEYS = new Set<string>([
  "CAN_ENABLED",
  "OBD_ENABLED",
  "ELOCK_ENABLED",
  "WIFI_ENABLED",
  "WIFI_IFACE",
  "BLE_ENABLED",
  "GPS_TIME_SYNC",
  "SERVICE_MODE_ENABLED",
  "SERVICE_WRITE_ENABLED",
  "UPDATE_DIR",
]);

type LegacyKey = (typeof LEGACY_KEYS)[number];
type LegacyEnvironment = Partial<Record<LegacyKey, string>>;

export function captureLegacyEnvironment(environment: Readonly<Record<string, string | undefined>>): LegacyEnvironment {
  const captured: LegacyEnvironment = {};
  for (const key of LEGACY_KEYS) {
    const value = environment[key];
    if (value !== undefined) {
      captured[key] = value;
    }
  }
  return captured;
}

export function legacyConfigurationWarning(environment: Readonly<Record<string, string | undefined>>): string | null {
  const keys = Object.keys(captureLegacyEnvironment(environment)).sort();
  return keys.length === 0
    ? null
    : `Legacy configuration is still supplied and ignored after migration: ${keys.join(", ")}. Use Settings.`;
}

function legacyPath(value: string | undefined, defaultName: string, context: LegacyContext): string {
  return value === undefined ? join(context.codeDirectory, defaultName) : resolve(context.workingDirectory, value);
}

export function retiredLegacyChoices(notices: readonly string[]): { name: string; behavior: string }[] {
  const behaviors: Record<string, string> = {
    CAN_ENABLED: "CAN telemetry is now always enabled.",
    OBD_ENABLED: "OBD polling is now always enabled.",
    ELOCK_ENABLED: "E-LOCK reads are now always enabled.",
    WIFI_ENABLED: "Wi-Fi monitoring is now always enabled.",
    WIFI_IFACE: "Wi-Fi monitoring and recovery now use wlan0.",
    BLE_ENABLED: "Choose or forget the motorcycle in Connections; this switch is no longer used.",
    GPS_TIME_SYNC: "Satellite clock discipline is now always enabled.",
    SERVICE_MODE_ENABLED: "Service reads are now always available when data locations are healthy.",
    SERVICE_WRITE_ENABLED: "Service writes are now always available through the existing safety gates.",
    UPDATE_DIR: "Updates now use the running checkout.",
  };
  return [...new Set(notices.filter(notice => notice.startsWith("retired:")).map(notice => notice.slice(8)))]
    .filter(name => Object.hasOwn(behaviors, name))
    .map(name => ({ name, behavior: behaviors[name]! }));
}
