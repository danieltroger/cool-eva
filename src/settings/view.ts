import type { StartupSettings } from "./schema.ts";

export interface PublicSettings {
  coolantProbesEnabled: boolean;
  radiatorFanEnabled: boolean;
  customBmsConfigurationFlashed: boolean;
  automaticDcChargingEnabled: boolean;
  phoneHotspotSsid: string;
  rideLogDirectory: string;
  vcuParameterDirectory: string;
  hubAddress: string | null;
  discoverHubOnce: boolean;
  recordingKeyConfigured: boolean;
  bluetoothCodeId: string | null;
}

export interface SettingsReadiness {
  coolant: string;
  fan: string;
  recording: string;
  bluetooth: string;
  hub: string;
  can: string;
}

export interface SettingsReply {
  ok: boolean;
  source: "fresh" | "legacy" | "unavailable";
  version: string;
  recordingFingerprint: string | null;
  processGeneration: string;
  instanceId: string | null;
  revision: number | null;
  hotspotNameOwnership: HotspotNameOwnership;
  saved: PublicSettings;
  active: PublicSettings;
  pending: (keyof StartupSettings)[];
  fault: string | null;
  notices: string[];
  retiredChoices?: { name: string; behavior: string }[];
  readiness: SettingsReadiness;
  restart: { state: "idle" | "reserved" | "scheduled" | "stopping" | "failed"; message: string };
  locations: { root: string; wifi: string; captures: string };
}

export type HotspotNameOwnership = "network" | "manual" | "unknown";

export interface SettingsActionReply {
  ok: boolean;
  message: string;
  settings?: SettingsReply;
}

export interface HubCandidate {
  address: string;
  name: string;
}

export interface HubCandidatesReply {
  ok: boolean;
  message: string;
  candidates: HubCandidate[];
}

export function publicSettings(
  values: StartupSettings,
  codeId: string | null,
  learnedAddress: string | null
): PublicSettings {
  return {
    coolantProbesEnabled: values.coolantProbesEnabled,
    radiatorFanEnabled: values.radiatorFanEnabled,
    customBmsConfigurationFlashed: values.customBmsConfigurationFlashed,
    automaticDcChargingEnabled: values.automaticDcChargingEnabled,
    phoneHotspotSsid: values.phoneHotspotSsid,
    rideLogDirectory: values.rideLogDirectory,
    vcuParameterDirectory: values.vcuParameterDirectory,
    hubAddress: values.hubAddress ?? (values.discoverHubOnce ? learnedAddress : null),
    discoverHubOnce: values.discoverHubOnce,
    recordingKeyConfigured: values.rideLogPublicKeyPem !== null,
    bluetoothCodeId: codeId,
  };
}
