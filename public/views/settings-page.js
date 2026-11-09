// @ts-check
import van from "../vendor/van-1.6.1.js";
import {
  settings,
  settingsReady,
  settingsInstance,
  settingsError,
  settingsConfirmed,
  refreshSettings,
} from "../lib/settings.js";
import { destinationSection, openDestination } from "../lib/destination.js";
import { ThemeToggle, UnitsToggle } from "./sheet.js";
import { SettingsCard, BooleanSetting, TextSetting, RecordingKeySetting } from "./settings-fields.js";
import { MigrationSummary, SiriShortcutLink } from "./settings-summary.js";
import { AccessExplanation } from "./settings-access.js";
import { SettingsRecovery } from "./settings-recovery.js";
import { SettingsRestart } from "./settings-restart.js";
import { DashboardBluetooth } from "./settings-bluetooth.js";
import { UpdateButton } from "./pi-actions.js";
import { ScreenGeometry } from "./screen-geometry.js";

const { a, button, div, h2 } = van.tags;
import { SETTINGS_MAP } from "../lib/settings-map.js";
import { settingChoice } from "../lib/settings-state.js";

export function SettingsPage() {
  return div(
    { class: "settings-page" },
    () =>
      settingsError.val
        ? SettingsCard(
            "Settings unconfirmed",
            settingsError.val,
            div(
              { class: "settings-row" },
              div("Phone preferences still work."),
              button(
                {
                  class: "settings-button",
                  onclick: () => {
                    void refreshSettings();
                  },
                },
                "Retry"
              )
            )
          )
        : div(),
    SettingsRecovery(),
    () => {
      settingsReady.val;
      settingsInstance.val;
      return SettingsContent(destinationSection.val);
    },
    () => (destinationSection.val ? SettingsRestart(!["phone", "access"].includes(destinationSection.val)) : div())
  );
}

/** @param {string} section */
function SettingsContent(section) {
  switch (section) {
    case "phone":
      return div(
        h2("This phone"),
        SettingsCard("Screen", "Applies immediately on this phone.", ThemeToggle()),
        SettingsCard("Units", "Applies immediately on this phone.", UnitsToggle())
      );
    case "bike":
      return div(
        h2("Bike setup"),
        BooleanSetting(
          "coolantProbesEnabled",
          "Coolant probes",
          "Only enable if you have the MAX31865 probes installed in your coolant hoses",
          Readiness("coolant", "coolantProbesEnabled")
        ),
        BooleanSetting(
          "radiatorFanEnabled",
          "Radiator fan installed",
          "Only enable if you have a coolant fan on the radiator. Automatic fan control may start after restart.",
          Readiness("fan", "radiatorFanEnabled")
        ),
        BooleanSetting(
          "customBmsConfigurationFlashed",
          "Have you flashed the custom BMS configuration?",
          "Choose Yes only after flashing it. This changes how pack temperature is interpreted."
        ),
        a(
          {
            href: "https://github.com/danieltroger/cool-eva/blob/main/docs/bms-config.md",
            target: "_blank",
            rel: "noopener",
            class: "settings-link",
          },
          "Read the custom BMS explanation →"
        )
      );
    case "access":
      return div(h2("Who can control my bike?"), AccessExplanation());
    case "charging":
      return div(
        h2("Charging"),
        BooleanSetting(
          "automaticDcChargingEnabled",
          "Allow automatic current reduction",
          "Permits Cool Eva to reduce the DC current request when the pack is hot. The stock BMS already reduces power; the dash’s maximum-current request can still change. Temporary pause and the actual outcome stay on Charge."
        )
      );
    case "connections":
      return div(
        h2("Connections"),
        TextSetting(
          "phoneHotspotSsid",
          "Hotspot name used for connection checks",
          "This identifies the phone hotspot for monitoring. Saving a name does not configure a Wi-Fi connection."
        ),
        SettingsCard(
          "Saved Wi-Fi connections",
          "Keep the working home network or phone hotspot. To change saved network credentials, use the installation / repair guide over a reachable connection.",
          a(
            {
              class: "settings-link",
              href: "https://github.com/danieltroger/cool-eva/blob/main/INSTALL.md",
              target: "_blank",
              rel: "noopener",
            },
            "Open installation / repair guide →"
          )
        ),
        DashboardBluetooth(),
        AccessExplanation()
      );
    case "recording":
      return div(
        h2("Ride recording"),
        Readiness("recording"),
        () =>
          settings.val?.recordingFingerprint
            ? SettingsCard("Active public-key fingerprint", settings.val.recordingFingerprint)
            : SettingsCard(
                "Live readings work",
                "Rides are not being recorded until a public key is saved and active."
              ),
        RecordingKeySetting(),
        SettingsCard(
          "Keep the private key",
          "Generate a pair on your laptop with scripts/generate-log-key.ts, or reuse your existing public key. Back up the private key on another device before saving the public half here. Your confirmation cannot prove that a backup exists. A lost private key means old ride logs cannot be recovered."
        )
      );
    case "software":
      return div(
        h2("Cool Eva"),
        SettingsCard(
          "Version",
          "",
          () => div({ class: "settings-note" }, settings.val?.version ?? "Unconfirmed"),
          UpdateButton()
        ),
        SettingsCard("Screen geometry", "", ScreenGeometry())
      );
    case "advanced":
      return div(
        h2("Advanced"),
        SettingsCard("Data location", "", () =>
          div({ class: "settings-note" }, settings.val?.locations.root ?? "Unconfirmed")
        ),
        TextSetting(
          "rideLogDirectory",
          "Recording directory",
          "An absolute persistent path outside code. Changing it leaves existing archives in their old location; it does not move or erase them."
        ),
        TextSetting(
          "vcuParameterDirectory",
          "Service data directory",
          "An absolute persistent path outside code. Existing snapshots and change history stay in the old location."
        ),
        SettingsCard("Wi-Fi diagnostic location", "", () =>
          div({ class: "settings-note" }, settings.val?.locations.wifi ?? "Unconfirmed")
        ),
        SettingsCard("CAN capture location", "", () =>
          div({ class: "settings-note" }, settings.val?.locations.captures ?? "Unconfirmed")
        ),
        SettingsCard(
          "Update Siri shortcut",
          "Older Siri shortcuts no longer save waypoints. Follow the guide to update yours.",
          SiriShortcutLink()
        ),
        MigrationSummary(false)
      );
    default:
      return div(
        h2("Settings"),
        MigrationSummary(true),
        ...SETTINGS_MAP.map(item =>
          div(
            { class: "settings-card settings-row" },
            div(item.title, div({ class: "settings-note" }, item.detail)),
            button(
              {
                class: "settings-button",
                "aria-label": `Open ${item.title}`,
                onclick: () => openDestination("settings", item.key),
              },
              "Open"
            )
          )
        ),
        SettingsRestart()
      );
  }
}

/** @param {keyof import("../../src/settings/view.ts").SettingsReadiness} key
 * @param {"coolantProbesEnabled" | "radiatorFanEnabled"} [settingKey] */
function Readiness(key, settingKey) {
  return () => {
    const current = settings.val;
    const readiness = current?.readiness[key] ?? "Not read";
    if (settingKey && current && readiness === settingChoice(current.active, settingKey)) return div();
    return div(
      { class: "settings-note", role: "status" },
      `${settingsConfirmed.val && !settingsError.val ? "Active" : "Unconfirmed — last contact"}: ${readiness}`
    );
  };
}
