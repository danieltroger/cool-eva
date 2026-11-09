// @ts-check
import van from "../vendor/van-1.6.1.js";
import { settings, settingsError, refreshSettings } from "../lib/settings.js";
import { destinationSection } from "../lib/destination.js";
import {
  beginSettingsBatch,
  batchIsDirty,
  changes,
  baseSettings,
  editHotspotName,
  sharedEditsDisabled,
  phoneTheme,
  phoneUnits,
  batchMessage,
} from "../lib/settings-batch.js";
import { BooleanField, PhoneFields, RecordingFields, Field, FieldHelp, Was } from "./settings-batch-fields.js";
import { DashboardBluetooth } from "./settings-bluetooth.js";
import { SettingsRecovery } from "./settings-recovery.js";
import { SettingsBatchFooter } from "./settings-batch-footer.js";
import { UpdateButton } from "./pi-actions.js";

const { a, button, details, div, input, span, summary } = van.tags;

export function SettingsPage() {
  beginSettingsBatch();
  document.addEventListener("click", guardSettingsNavigation, true);
  setTimeout(() => void refreshSettings(), 0);
  return div(
    { class: "settings-page settings-batch-page layout-page layout-stack", "data-settings-batch": "" },
    () =>
      settingsError.val
        ? div(
            { class: "settings-card layout-compact-stack", role: "status" },
            span("Settings unconfirmed"),
            span({ class: "settings-note" }, settingsError.val),
            button({ class: "settings-button", onclick: () => void refreshSettings() }, "Retry")
          )
        : span({ hidden: true }),
    SettingsRecovery(),
    Section(
      "phone",
      "This phone",
      () =>
        `${phoneTheme.val === "auto" ? "Automatic" : phoneTheme.val === "light" ? "Light" : "Dark"} · ${phoneUnits.val === "metric" ? "Metric" : "Imperial"}`,
      PhoneFields()
    ),
    Section(
      "bike",
      "Bike setup",
      bikeSummary,
      BooleanField(
        "coolantProbesEnabled",
        "Coolant probes fitted",
        "Only enable with MAX31865 probes in the coolant hoses.",
        "coolant"
      ),
      BooleanField(
        "radiatorFanEnabled",
        "Radiator fan fitted",
        "Only enable with a radiator fan fitted. Automatic control may start after restart.",
        "fan"
      ),
      BooleanField(
        "customBmsConfigurationFlashed",
        "Custom BMS already flashed",
        "Only enable after flashing. This changes how pack temperature is interpreted."
      )
    ),
    Section(
      "charging",
      "Charging",
      () =>
        !settings.val?.ok
          ? "Unconfirmed"
          : savedBoolean("automaticDcChargingEnabled")
            ? "Auto reduction allowed"
            : "Auto reduction off",
      BooleanField("automaticDcChargingEnabled", "Allow automatic current reduction", "")
    ),
    Section(
      "connections",
      "Connections",
      () => "Wi-Fi · Bluetooth",
      Field(
        "Hotspot name used for connection checks",
        input({
          "aria-label": "Hotspot name used for connection checks",
          spellcheck: false,
          disabled: sharedEditsDisabled,
          value: () => changes.val.phoneHotspotSsid ?? settings.val?.saved.phoneHotspotSsid ?? "",
          oninput: event => editHotspotName(event.target.value),
        }),
        FieldHelp(
          "Hotspot connection checks",
          "This identifies the phone hotspot for monitoring. Saving a name does not configure a Wi-Fi connection."
        ),
        () =>
          "phoneHotspotSsid" in changes.val
            ? Was(baseSettings.val?.saved.phoneHotspotSsid || "Not set")
            : span({ hidden: true })
      ),
      DashboardBluetooth()
    ),
    Section(
      "recording",
      "Ride recording",
      () =>
        !settings.val?.ok ? "Unconfirmed" : settings.val.saved.recordingKeyConfigured ? "Key set" : "No public key",
      RecordingFields()
    ),
    Section(
      "software",
      "Cool Eva",
      () => settings.val?.version ?? "Unconfirmed",
      Field("Version", () => span(settings.val?.version ?? "Unconfirmed")),
      UpdateButton(),
      a(
        {
          class: "settings-link",
          href: "https://github.com/danieltroger/cool-eva/blob/main/LICENSE",
          target: "_blank",
          rel: "noopener",
        },
        "Licence and no warranty →"
      )
    ),
    Section(
      "advanced",
      "Advanced",
      () => "Folders",
      Field("Recording folder", () =>
        span({ class: "settings-readonly" }, settings.val?.active.rideLogDirectory ?? "Unconfirmed")
      ),
      Field("Service folder", () =>
        span({ class: "settings-readonly" }, settings.val?.active.vcuParameterDirectory ?? "Unconfirmed")
      )
    ),
    SettingsBatchFooter()
  );
}

/** @param {string} key @param {string} title @param {()=>string} readSummary
 * @param {...import("../vendor/van-1.6.1.js").ChildDom} children */
function Section(key, title, readSummary, ...children) {
  return details(
    {
      class: "layout-accordion settings-section",
      "data-settings-section": key,
      open: () => destinationSection.val === key,
    },
    summary(
      span({ class: "layout-compact-stack" }, span({ class: "settings-section-title" }, title), () =>
        span({ class: "settings-summary-detail" }, readSummary())
      )
    ),
    div({ class: "layout-accordion-body layout-stack" }, ...children)
  );
}

/** @param {import("../lib/settings-batch.js").BooleanSettingKey} key */
function savedBoolean(key) {
  return changes.val[key] ?? settings.val?.saved[key] ?? false;
}

function bikeSummary() {
  if (!settings.val?.ok) return "Unconfirmed";
  return (
    [
      savedBoolean("coolantProbesEnabled") ? "Probes" : "",
      savedBoolean("radiatorFanEnabled") ? "Fan" : "",
      savedBoolean("customBmsConfigurationFlashed") ? "Custom BMS" : "",
    ]
      .filter(Boolean)
      .join(" · ") || "Off"
  );
}

/** @param {MouseEvent} event */
function guardSettingsNavigation(event) {
  if (!document.querySelector("[data-settings-batch]")) return;
  if (!batchIsDirty() || !(event.target instanceof Element)) return;
  const link = event.target.closest(".tabs a,.header a");
  if (!link || link.getAttribute("aria-current") === "page") return;
  event.preventDefault();
  event.stopImmediatePropagation();
  batchMessage.val = "Save or cancel before leaving.";
  const save = document.querySelector("[data-settings-save]");
  if (save instanceof HTMLButtonElement) {
    save.focus();
  }
}
