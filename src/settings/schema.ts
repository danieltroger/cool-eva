import { isAbsolute } from "path";
import type { SettingsPaths } from "./paths.ts";
import { validatePublicKey } from "./public-key.ts";

export function parseSettingsDocument(value: unknown): ParsedSettings {
  const raw = record(value, "settings document");
  if (raw.schemaVersion !== SETTINGS_SCHEMA_VERSION) {
    throw new SettingsFormatError("unsupported-version", "This build does not support the settings version.");
  }
  if (!Number.isSafeInteger(raw.revision) || Number(raw.revision) < 0) {
    throw new SettingsFormatError("invalid-document", "The settings revision is invalid.");
  }
  const values = record(raw.values, "settings values");
  const learned = raw.learned === undefined ? {} : record(raw.learned, "learned settings");
  const migration = record(raw.migration, "migration state");
  const configuration: StartupSettings = {
    coolantProbesEnabled: readBooleanField(values.coolantProbesEnabled, "coolantProbesEnabled"),
    radiatorFanEnabled: readBooleanField(values.radiatorFanEnabled, "radiatorFanEnabled"),
    customBmsConfigurationFlashed: readBooleanField(
      values.customBmsConfigurationFlashed,
      "customBmsConfigurationFlashed"
    ),
    automaticDcChargingEnabled: readBooleanField(values.automaticDcChargingEnabled, "automaticDcChargingEnabled"),
    phoneHotspotSsid: readStringField(values.phoneHotspotSsid, "phoneHotspotSsid"),
    dashboardBluetoothSecret: readStringField(values.dashboardBluetoothSecret, "dashboardBluetoothSecret"),
    rideLogPublicKeyPem: publicKey(values.rideLogPublicKeyPem),
    rideLogDirectory: readAbsolutePath(values.rideLogDirectory, "rideLogDirectory"),
    vcuParameterDirectory: readAbsolutePath(values.vcuParameterDirectory, "vcuParameterDirectory"),
    hubAddress: readHubAddress(values.hubAddress),
    discoverHubOnce: readBooleanField(values.discoverHubOnce, "discoverHubOnce"),
  };
  if (migration.source !== "fresh" && migration.source !== "legacy") {
    throw new SettingsFormatError("invalid-document", "The migration source is invalid.");
  }
  const document: SettingsDocument = {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    revision: Number(raw.revision),
    values: configuration,
    learned: { hubAddress: readHubAddress(learned.hubAddress ?? null) },
    migration: {
      source: migration.source,
      complete: readBooleanField(migration.complete, "migration.complete"),
      pendingPublicKeyPath: readNullableStringField(migration.pendingPublicKeyPath, "migration.pendingPublicKeyPath"),
      suppliedLegacyKeys: readStringList(migration.suppliedLegacyKeys, "migration.suppliedLegacyKeys"),
      notices: readStringList(migration.notices, "migration.notices"),
    },
  };
  return { raw: structuredClone(raw), document };
}

// Additive fields keep this version; only an incompatible format needs a bump.
export const SETTINGS_SCHEMA_VERSION = 1;

export interface StartupSettings {
  coolantProbesEnabled: boolean;
  radiatorFanEnabled: boolean;
  customBmsConfigurationFlashed: boolean;
  automaticDcChargingEnabled: boolean;
  phoneHotspotSsid: string;
  dashboardBluetoothSecret: string;
  rideLogPublicKeyPem: string | null;
  rideLogDirectory: string;
  vcuParameterDirectory: string;
  hubAddress: string | null;
  discoverHubOnce: boolean;
}

export interface SettingsDocument {
  schemaVersion: number;
  revision: number;
  values: StartupSettings;
  learned: { hubAddress: string | null };
  migration: MigrationState;
}

export interface MigrationState {
  source: "fresh" | "legacy";
  complete: boolean;
  pendingPublicKeyPath: string | null;
  suppliedLegacyKeys: string[];
  notices: string[];
}

export interface ParsedSettings {
  raw: Record<string, unknown>;
  document: SettingsDocument;
}

export type SettingsFault = "unsupported-version" | "invalid-document" | "unreadable" | "missing-after-install";

export class SettingsFormatError extends Error {
  readonly kind: SettingsFault;

  constructor(kind: SettingsFault, message: string) {
    super(message);
    this.name = "SettingsFormatError";
    this.kind = kind;
  }
}

export function freshSettings(paths: SettingsPaths): SettingsDocument {
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    revision: 0,
    values: {
      coolantProbesEnabled: false,
      radiatorFanEnabled: false,
      customBmsConfigurationFlashed: false,
      automaticDcChargingEnabled: true,
      phoneHotspotSsid: "",
      dashboardBluetoothSecret: "",
      rideLogPublicKeyPem: null,
      rideLogDirectory: paths.rideLogDirectory,
      vcuParameterDirectory: paths.vcuParameterDirectory,
      hubAddress: null,
      discoverHubOnce: false,
    },
    learned: { hubAddress: null },
    migration: { source: "fresh", complete: true, pendingPublicKeyPath: null, suppliedLegacyKeys: [], notices: [] },
  };
}

export function degradedSettings(paths: SettingsPaths): StartupSettings {
  return { ...freshSettings(paths).values, automaticDcChargingEnabled: false };
}

export function pendingSettings(saved: StartupSettings, active: StartupSettings): (keyof StartupSettings)[] {
  return (Object.keys(saved) as (keyof StartupSettings)[]).filter(key => saved[key] !== active[key]);
}

export function effectiveHubAddress(document: SettingsDocument): string | null {
  return document.values.hubAddress ?? (document.values.discoverHubOnce ? document.learned.hubAddress : null);
}

export function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SettingsFormatError("invalid-document", `${field} must be a record.`);
  }
  return value as Record<string, unknown>;
}

function readBooleanField(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new SettingsFormatError("invalid-document", `${field} must be a boolean.`);
  }
  return value;
}

function readStringField(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new SettingsFormatError("invalid-document", `${field} must be a string.`);
  }
  return value;
}

function readNullableStringField(value: unknown, field: string): string | null {
  return value === null ? null : readStringField(value, field);
}

function readAbsolutePath(value: unknown, field: string): string {
  const path = readStringField(value, field);
  if (!isAbsolute(path) || path.includes("\0")) {
    throw new SettingsFormatError("invalid-document", `${field} must be an absolute path.`);
  }
  return path;
}

function readHubAddress(value: unknown): string | null {
  if (value === null) return null;
  const address = readStringField(value, "hubAddress");
  if (!/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(address)) {
    throw new SettingsFormatError("invalid-document", "The motorcycle hub address is invalid.");
  }
  return address.toUpperCase();
}

function readStringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every(entry => typeof entry === "string")) {
    throw new SettingsFormatError("invalid-document", `${field} must be a list of strings.`);
  }
  return [...value];
}

function publicKey(value: unknown): string | null {
  if (value === null) return null;
  try {
    return validatePublicKey(readStringField(value, "rideLogPublicKeyPem"));
  } catch {
    throw new SettingsFormatError("invalid-document", "The recording key must be an X25519 public key.");
  }
}
