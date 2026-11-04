// @ts-check
import van from "../vendor/van-1.6.1.js";
import { arm, armDwellElapsed, armed, refuseKeyRepeat } from "../lib/arming.js";
import {
  settings,
  settingsAction,
  settingsBusy,
  settingsError,
  restartRequest,
  settingsMessages,
} from "../lib/settings.js";

const { button, div } = van.tags;
const RESTART_KEY = "settings-restart:apply";

export function SettingsRestart() {
  return div(
    { class: "settings-card" },
    () =>
      div(
        { class: "settings-note" },
        settings.val?.pending.length
          ? `Saved, not active: ${[...new Set(settings.val.pending.map(settingName))].join(", ")}.`
          : "No saved changes waiting."
      ),
    div(
      { class: "settings-row" },
      div(
        "Restart Cool Eva",
        div(
          { class: "settings-note" },
          "Readings and recording pause. Wi-Fi or Bluetooth may disconnect. Reconnect to confirm what is active."
        )
      ),
      button(
        {
          class: "settings-button",
          onkeydown: refuseKeyRepeat,
          disabled: () =>
            !!settingsBusy.val ||
            !!settingsError.val ||
            !settings.val ||
            ["reserved", "scheduled", "stopping"].includes(settings.val.restart.state),
          onclick: () => {
            if (armed.val !== RESTART_KEY) {
              arm(RESTART_KEY);
              return;
            }
            if (!armDwellElapsed()) {
              return;
            }
            armed.val = "";
            void performRestart();
          },
        },
        () => (armed.val === RESTART_KEY ? "Confirm restart" : "Restart")
      )
    ),
    () =>
      div(
        { class: "settings-note", role: "status" },
        settings.val?.restart.state === "failed"
          ? settings.val.restart.message
          : (settingsMessages.val.restart ?? settings.val?.restart.message ?? "")
      )
  );
}

async function performRestart() {
  await settingsAction("restart", "/settings/apply", "POST", restartRequest());
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
