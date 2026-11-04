// @ts-check
import van from "../vendor/van-1.6.1.js";
import { readPhoneValue, writePhoneValue } from "../lib/phone-storage.js";
import { settings, settingsReady, settingsInstance, settingsError, refreshSettings } from "../lib/settings.js";
import { destinationSection, openDestination } from "../lib/destination.js";
import { BLE_MODE } from "../lib/ble-link.js";
import { ThemeToggle, UnitsToggle } from "./sheet.js";
import { SettingsCard, BooleanSetting, TextSetting, RecordingKeySetting } from "./settings-fields.js";
import { SettingsRestart } from "./settings-restart.js";
import { DashboardBluetooth } from "./settings-bluetooth.js";
import { MotorcycleConnection } from "./settings-hub.js";
import { CanRestartButton, UpdateButton } from "./pi-actions.js";

const { a, button, div, h2 } = van.tags;
import { SETTINGS_MAP } from "../lib/settings-map.js";
const dismissed = van.state("");

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
    () => (settings.val?.fault ? SettingsCard("Settings need attention", settings.val.fault) : div()),
    () => {
      settingsReady.val;
      settingsInstance.val;
      return SettingsContent(destinationSection.val);
    },
    () => (destinationSection.val ? SettingsRestart() : div())
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
          "Only enable if you have the MAX31865 probes installed in your coolant hoses"
        ),
        Readiness("coolant"),
        BooleanSetting(
          "radiatorFanEnabled",
          "Radiator fan installed",
          "Only enable if you have a coolant fan on the radiator. Automatic fan control may start after restart."
        ),
        Readiness("fan"),
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
          "Keep the working home network or phone hotspot. To change network credentials in this phase, use the installation guide over a reachable connection. Dashboard network changes follow in the next phase.",
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
        MotorcycleConnection(),
        SettingsCard(
          "Bike data / CAN adapter",
          "No recognised traffic may mean the bike is asleep, an unplugged USB adapter or wrong wiring. Check those first. A bus restart closes CAN sockets; restart Cool Eva afterward if readings remain unavailable.",
          Readiness("can"),
          CanRestartButton()
        ),
        SettingsCard(
          "Who can control my bike?",
          "There is no dashboard login. Anyone on the same network can read data and use service actions; anyone with the shared Bluetooth key can do so over Bluetooth. Park the bike before service work. The bus safety gates and confirmations still apply."
        )
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
        )
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

/** @param {keyof import("../../src/settings/view.ts").SettingsReadiness} key */
function Readiness(key) {
  return () =>
    div({ class: "settings-note", role: "status" }, `Active: ${settings.val?.readiness[key] ?? "Unconfirmed"}`);
}

/** @param {boolean} dismissible */
export function MigrationSummary(dismissible) {
  return () => {
    const current = settings.val;
    if (!current?.instanceId) return div();
    const id = `cool-eva.setup-seen:${current.instanceId}`;
    if (dismissible && (dismissed.val === id || readPhoneValue(id))) return div();
    const text =
      current.source === "legacy"
        ? [
            current.notices.includes("coolant-default-off")
              ? "Coolant probes are now off. Enable them in Settings → Bike setup if you have the probes installed."
              : "Your coolant probe choice was preserved.",
            "Bike reads, service writes, Wi-Fi monitoring and GPS time are now available without configuration switches.",
            current.saved.automaticDcChargingEnabled
              ? "Automatic DC current reduction is allowed. Review it under Charging."
              : "Your automatic DC current reduction OFF choice was preserved.",
            "Anyone on this network or holding the Bluetooth key can control the bike. See Connections → Who can control my bike?",
            current.notices.includes("hub-discover-once")
              ? current.active.hubAddress
                ? "Your discovered motorcycle hub has been remembered for future starts."
                : "The motorcycle hub will be discovered once, then remembered after a successful connection."
              : "Your motorcycle selection was preserved.",
            current.notices.includes("private-key-on-pi")
              ? "A private key is on the Pi, which defeats the sealed log; put the public key there instead. Recording continues."
              : "",
          ]
            .filter(Boolean)
            .join(" ")
        : `Connected over ${BLE_MODE ? "Bluetooth" : "Wi-Fi"}. Choose Bike setup for installed hardware. Bluetooth and ride recording are optional; you can add them later.`;
    return SettingsCard(
      current.source === "legacy" ? "What changed on this Pi" : "Welcome to Cool Eva",
      text,
      dismissible
        ? div(
            { class: "settings-row" },
            div("These notes remain in Advanced."),
            button(
              {
                class: "settings-button",
                onclick: () => {
                  writePhoneValue(id, "1");
                  dismissed.val = id;
                },
              },
              "Got it"
            )
          )
        : div()
    );
  };
}
