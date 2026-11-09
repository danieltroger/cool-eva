import { freshSettings } from "../src/settings/schema.ts";
import { settingsPaths } from "../src/settings/paths.ts";
import { publicSettings, type SettingsReply } from "../src/settings/view.ts";

export function settingsBatchFixture(name: string): SettingsReply {
  const values = freshSettings(settingsPaths("/synthetic-settings")).values;
  const visible = publicSettings(values, null, null);
  return {
    ok: true,
    source: "fresh",
    version: "Synthetic",
    recordingFingerprint: null,
    processGeneration: `synthetic-generation-${name}`,
    instanceId: `synthetic-instance-${name}`,
    revision: 0,
    saved: { ...visible },
    active: { ...visible },
    pending: [],
    fault: null,
    notices: [],
    readiness: {
      coolant: "Off",
      fan: "Driver ready; no rotation sensor",
      recording: "Not configured",
      bluetooth: "Off",
      hub: "Not selected",
      can: "Ready",
    },
    restart: { state: "idle", message: "" },
    locations: {
      root: "/synthetic-settings",
      wifi: "/synthetic-settings/wifi",
      captures: "/synthetic-settings/captures",
    },
  };
}
