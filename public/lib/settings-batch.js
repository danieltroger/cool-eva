// @ts-check
import van from "../vendor/van-1.6.1.js";
import {
  settings,
  settingsAction,
  settingsConfirmed,
  settingsError,
  settingsBusy,
  settingsMessages,
} from "./settings.js";
import { themePreference, setThemePreference } from "./theme.js";
import { unitSystem, setUnitSystem } from "./units.js";
import { validBleSecret } from "./ble-secret.js";
import { writePhoneValue } from "./phone-storage.js";
import { armed } from "./arming.js";

/** @typedef {import("../../src/settings/schema.ts").StartupSettings} StartupSettings */
/** @typedef {import("../../src/settings/view.ts").SettingsReply} SettingsReply */
/** @typedef {"coolantProbesEnabled"|"radiatorFanEnabled"|"customBmsConfigurationFlashed"|"automaticDcChargingEnabled"} BooleanSettingKey */

export async function saveSettingsBatch() {
  if (batchBusy.rawVal || settingsBusy.rawVal) return false;
  const validation = batchValidation();
  if (validation) {
    batchMessage.val = validation;
    return false;
  }
  if (!batchIsDirty()) return true;
  batchBusy.val = true;
  batchMessage.val = "";
  const submitted = changes.rawVal;
  const source = baseSettings.rawVal;
  try {
    if (Object.keys(submitted).length) {
      if (
        !source ||
        source.instanceId !== settings.rawVal?.instanceId ||
        source.processGeneration !== settings.rawVal?.processGeneration
      ) {
        batchMessage.val = "Reconnect and confirm this Pi before saving.";
        return false;
      }
      if (!(await settingsAction("batch", "/settings", "PATCH", { revision: source.revision, changes: submitted }))) {
        return false;
      }
      if (!confirmedSettingsChanges(source, submitted)) {
        settingsConfirmed.val = false;
        settingsError.val = "Reconnect and read settings before saving again.";
        batchMessage.val = "No confirmed reply. Reconnect and read settings before trying again.";
        return false;
      }
      if (submitted.dashboardBluetoothSecret && settings.rawVal?.saved.bluetoothCodeId) {
        if (
          !writePhoneValue(
            `cool-eva.pending-code:${settings.rawVal.saved.bluetoothCodeId}`,
            submitted.dashboardBluetoothSecret
          )
        ) {
          batchMessage.val = "Saved on the Pi. Keep your external key copy and use Wi-Fi to restart.";
        }
      }
    }
    if (phoneTheme.rawVal !== originalPhone.rawVal.theme) {
      setThemePreference(phoneTheme.rawVal);
    }
    if (phoneUnits.rawVal !== originalPhone.rawVal.units) {
      setUnitSystem(phoneUnits.rawVal);
    }
    originalPhone.val = { theme: phoneTheme.rawVal, units: phoneUnits.rawVal };
    clearServerEdits();
    batchMessage.val ||= settings.rawVal?.pending.length ? "" : "Saved.";
    return true;
  } finally {
    batchBusy.val = false;
  }
}

export const changes = van.state(/** @type {Partial<StartupSettings>} */ ({}));
export const baseSettings = van.state(/** @type {SettingsReply|null} */ (null));
export const phoneTheme = van.state(themePreference.rawVal);
export const phoneUnits = van.state(unitSystem.rawVal);
export const originalPhone = van.state({ theme: themePreference.rawVal, units: unitSystem.rawVal });
export const batchMessage = van.state("");
export const batchBusy = van.state(false);
export const bluetoothKeyBackedUp = van.state(false);
export const recordingKeyBackedUp = van.state(false);
export const bluetoothKeyShown = van.state(false);

export function beginSettingsBatch() {
  if (
    Object.keys(changes.rawVal).length ||
    phoneTheme.rawVal !== originalPhone.rawVal.theme ||
    phoneUnits.rawVal !== originalPhone.rawVal.units ||
    batchBusy.rawVal
  ) {
    return;
  }
  phoneTheme.val = themePreference.rawVal;
  phoneUnits.val = unitSystem.rawVal;
  originalPhone.val = { theme: themePreference.rawVal, units: unitSystem.rawVal };
}

export function batchIsDirty() {
  return (
    Object.keys(changes.val).length > 0 ||
    phoneTheme.val !== originalPhone.val.theme ||
    phoneUnits.val !== originalPhone.val.units
  );
}

export function sharedEditsDisabled() {
  return batchBusy.val || !!settingsBusy.val || !settingsConfirmed.val || !!settingsError.val || !settings.val?.ok;
}

/** @param {BooleanSettingKey} key */
export function booleanChoice(key) {
  if (!settings.val?.ok) return null;
  return changes.val[key] ?? settings.val.saved[key];
}

/** @param {BooleanSettingKey} key @param {boolean} value */
export function editBooleanChoice(key, value) {
  if (sharedEditsDisabled()) return;
  const source = baseSettings.rawVal ?? settings.rawVal;
  if (!source) return;
  const next = { ...changes.rawVal };
  if (value === source.saved[key]) {
    delete next[key];
  } else {
    next[key] = value;
  }
  stageChanges(next, source);
}

/** @param {string} value */
export function editHotspotName(value) {
  if (sharedEditsDisabled()) return;
  const source = baseSettings.rawVal ?? settings.rawVal;
  if (!source) return;
  const next = { ...changes.rawVal };
  if (value === source.saved.phoneHotspotSsid) {
    delete next.phoneHotspotSsid;
  } else {
    next.phoneHotspotSsid = value;
  }
  stageChanges(next, source);
}

/** @param {string} value */
export function editBluetoothKey(value) {
  if (sharedEditsDisabled()) return;
  const source = baseSettings.rawVal ?? settings.rawVal;
  if (!source) return;
  const next = /** @type {Partial<StartupSettings>} */ ({ ...changes.rawVal, dashboardBluetoothSecret: value });
  if (value === "" && !source.saved.bluetoothCodeId) {
    delete next.dashboardBluetoothSecret;
  }
  bluetoothKeyBackedUp.val = false;
  bluetoothKeyShown.val = false;
  stageChanges(next, source);
}

export function keepSavedBluetoothKey() {
  const next = { ...changes.rawVal };
  delete next.dashboardBluetoothSecret;
  bluetoothKeyShown.val = false;
  bluetoothKeyBackedUp.val = false;
  stageChanges(next, baseSettings.rawVal ?? settings.rawVal);
}

/** @param {string} value */
export function editRecordingKey(value) {
  if (sharedEditsDisabled()) return false;
  if (/PRIVATE KEY/.test(value)) {
    batchMessage.val = "Keep the private key on your own devices. Choose only the public half.";
    return false;
  }
  recordingKeyBackedUp.val = false;
  stageChanges({ ...changes.rawVal, rideLogPublicKeyPem: value }, baseSettings.rawVal ?? settings.rawVal);
  return true;
}

/** @param {import("./theme.js").ThemePreference} value */
export function editPhoneTheme(value) {
  if (batchBusy.rawVal) return;
  phoneTheme.val = value;
  setThemePreference(value, false);
  armed.val = "";
  batchMessage.val = "";
  settingsMessages.val = { ...settingsMessages.rawVal, batch: "" };
}

/** @param {import("./units.js").UnitSystem} value */
export function editPhoneUnits(value) {
  if (batchBusy.rawVal) return;
  phoneUnits.val = value;
  setUnitSystem(value, false);
  armed.val = "";
  batchMessage.val = "";
  settingsMessages.val = { ...settingsMessages.rawVal, batch: "" };
}

export function cancelSettingsBatch() {
  if (batchBusy.rawVal) return;
  phoneTheme.val = originalPhone.rawVal.theme;
  phoneUnits.val = originalPhone.rawVal.units;
  setThemePreference(phoneTheme.rawVal, false);
  setUnitSystem(phoneUnits.rawVal, false);
  clearServerEdits();
  batchMessage.val = "";
  settingsMessages.val = { ...settingsMessages.rawVal, batch: "" };
  armed.val = "";
}

export function batchValidation() {
  const submitted = changes.val;
  if (Object.keys(submitted).length && sharedEditsDisabled()) {
    return "Reconnect and confirm this Pi before saving.";
  }
  if (
    Object.keys(submitted).length &&
    baseSettings.val &&
    (baseSettings.val.revision !== settings.val?.revision ||
      baseSettings.val.instanceId !== settings.val?.instanceId ||
      baseSettings.val.processGeneration !== settings.val?.processGeneration)
  ) {
    return "Settings changed; cancel and review before saving.";
  }
  if (submitted.dashboardBluetoothSecret) {
    if (!validBleSecret(submitted.dashboardBluetoothSecret)) return "Use a generated 64-character Bluetooth key.";
    if (!bluetoothKeyBackedUp.val) return "Keep a recoverable copy of the new key before saving.";
  }
  if (submitted.rideLogPublicKeyPem && !recordingKeyBackedUp.val) {
    return "Keep a recoverable private-key backup, then confirm it before saving.";
  }
  return "";
}

/** @param {Partial<StartupSettings>} next @param {SettingsReply|null} source */
function stageChanges(next, source) {
  baseSettings.val = Object.keys(next).length ? source : null;
  changes.val = next;
  batchMessage.val = "";
  settingsMessages.val = { ...settingsMessages.rawVal, batch: "" };
  armed.val = "";
}

function clearServerEdits() {
  changes.val = {};
  baseSettings.val = null;
  bluetoothKeyBackedUp.val = false;
  recordingKeyBackedUp.val = false;
  bluetoothKeyShown.val = false;
}

/** @param {SettingsReply} source @param {Partial<StartupSettings>} submitted */
function confirmedSettingsChanges(source, submitted) {
  const current = settings.rawVal;
  if (
    !current ||
    source.revision === null ||
    current.revision !== source.revision + 1 ||
    current.instanceId !== source.instanceId ||
    current.processGeneration !== source.processGeneration
  ) {
    return false;
  }
  return Object.entries(submitted).every(([key, value]) => {
    if (key === "dashboardBluetoothSecret") return !!current.saved.bluetoothCodeId === !!value;
    if (key === "rideLogPublicKeyPem") return current.saved.recordingKeyConfigured === !!value;
    return (
      Object.hasOwn(current.saved, key) && current.saved[/** @type {keyof SettingsReply["saved"]} */ (key)] === value
    );
  });
}

let instance = settings.rawVal?.instanceId;
van.derive(() => {
  const current = settings.val?.instanceId;
  if (instance && current && current !== instance) {
    clearServerEdits();
  }
  instance = current;
});
