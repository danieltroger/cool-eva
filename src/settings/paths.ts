import { isAbsolute, join } from "path";

export function settingsPaths(dataRoot = DEFAULT_DATA_ROOT): SettingsPaths {
  if (!isAbsolute(dataRoot) || dataRoot.includes("\0")) {
    throw new Error("The shared data root must be an absolute path.");
  }
  return {
    dataRoot,
    privateDirectory: join(dataRoot, "state"),
    settingsFile: join(dataRoot, "state", "settings.json"),
    installationMarker: join(dataRoot, "state", "installed.json"),
    moveJournal: join(dataRoot, "state", "data-move.json"),
    rideLogDirectory: join(dataRoot, "ride-logs"),
    vcuParameterDirectory: join(dataRoot, "vcu-params"),
    wifiDiagnosticDirectory: join(dataRoot, "wifi-diag"),
    captureDirectory: join(dataRoot, "captures"),
    updaterDirectory: join(dataRoot, "updater"),
  };
}

export const DEFAULT_DATA_ROOT = "/var/lib/cool-eva";
export const DEFAULT_SETTINGS_LOCK = "/run/cool-eva/settings.lock";

export interface SettingsPaths {
  dataRoot: string;
  privateDirectory: string;
  settingsFile: string;
  installationMarker: string;
  moveJournal: string;
  rideLogDirectory: string;
  vcuParameterDirectory: string;
  wifiDiagnosticDirectory: string;
  captureDirectory: string;
  updaterDirectory: string;
}
