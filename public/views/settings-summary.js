// @ts-check
import van from "../vendor/van-1.6.1.js";
import { setupNoticeDismissed, dismissSetupNotice } from "../lib/setup-notice.js";
import { settings } from "../lib/settings.js";
import { destination, openDestination } from "../lib/destination.js";
import { BLE_MODE } from "../lib/ble-link.js";
import { SettingsCard } from "./settings-fields.js";

const { a, button, div } = van.tags;

/** @param {boolean} dismissible @param {boolean} [riding] */
export function MigrationSummary(dismissible, riding = false) {
  return () => {
    const current = settings.val;
    if (!current?.instanceId || (riding && (destination.val || current.source !== "legacy"))) return div();
    const id = `cool-eva.setup-seen:${current.instanceId}`;
    if (dismissible && setupNoticeDismissed(id)) return div();
    const legacy = current.source === "legacy";
    const text = legacy
      ? [
          current.notices.includes("coolant-default-off")
            ? "Coolant probes are now off. Enable them in Settings → Bike setup if you have the probes installed."
            : "Your coolant probe choice was preserved.",
          "Bike reads, service writes, Wi-Fi monitoring and GPS time are now available without configuration switches.",
          current.saved.automaticDcChargingEnabled
            ? "Automatic DC current reduction is allowed. Review it under Charging."
            : "Your automatic DC current reduction OFF choice was preserved.",
          current.notices.includes("ride-log-directory-empty")
            ? "The empty recording directory was treated as unset. Recordings use the default location."
            : "",
          current.notices.includes("vcu-directory-empty")
            ? "The empty service directory was treated as unset. Service data uses the default location."
            : "",
          current.notices.includes("private-key-on-pi")
            ? "A private key is on the Pi, which defeats the sealed log; put the public key there instead. Recording continues."
            : "",
          "Older Siri shortcuts no longer save waypoints. Use Update Siri shortcut below.",
        ]
          .filter(Boolean)
          .join(" ")
      : `Connected over ${BLE_MODE ? "Bluetooth" : "Wi-Fi"}. Choose Bike setup for installed hardware. Bluetooth and ride recording are optional; you can add them later.`;
    const card = SettingsCard(
      legacy ? "What changed on this Pi" : "Welcome to Cool Eva",
      text,
      ...(current.retiredChoices ?? []).map(choice =>
        div({ class: "settings-note" }, `${choice.name}: ${choice.behavior}`)
      ),
      div(
        { class: "settings-links" },
        current.notices.includes("coolant-default-off") ? summaryLink("Bike setup", "bike") : null,
        summaryLink("Charging", "charging"),
        legacy ? SiriShortcutLink() : null
      ),
      dismissible
        ? div(
            { class: "settings-row" },
            div("These notes remain in Advanced."),
            button(
              {
                class: "settings-button",
                onclick: () => {
                  dismissSetupNotice(id);
                },
              },
              "Got it"
            )
          )
        : null
    );
    return riding ? div({ class: "settings-page migration-notice" }, card) : card;
  };
}

export function SiriShortcutLink() {
  return a(
    {
      class: "settings-link",
      href: "https://github.com/danieltroger/cool-eva/blob/main/docs/waypoints.md#saving-a-waypoint-from-siri",
      target: "_blank",
      rel: "noopener",
    },
    "Update Siri shortcut →"
  );
}

/** @param {string} title @param {string} section */
function summaryLink(title, section) {
  return button({ class: "settings-link", onclick: () => openDestination("settings", section) }, `${title} →`);
}
