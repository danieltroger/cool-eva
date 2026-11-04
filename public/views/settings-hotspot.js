// @ts-check
import van from "../vendor/van-1.6.1.js";
import { settings, settingsConfirmed } from "../lib/settings.js";
import { settingsStateLines } from "../lib/settings-state.js";
import { SettingsCard, TextSetting } from "./settings-fields.js";

const { div, input } = van.tags;
const TITLE = "Hotspot name used for connection checks";
const hotspotOwnership = van.derive(() =>
  settingsConfirmed.val ? (settings.val?.hotspotNameOwnership ?? "unknown") : "unknown"
);

export function HotspotCheckName() {
  const ownership = hotspotOwnership.val;
  if (ownership === "manual") {
    return TextSetting(
      "phoneHotspotSsid",
      TITLE,
      "This identifies the phone hotspot for monitoring. Saving a name does not configure a Wi-Fi connection."
    );
  }
  return SettingsCard(
    TITLE,
    ownership === "network"
      ? "Set by your saved Phone hotspot network"
      : "Read saved Wi-Fi networks before editing this name.",
    div(
      { class: "settings-form-fields" },
      input({
        "aria-label": TITLE,
        readOnly: true,
        value: () => settings.val?.saved.phoneHotspotSsid ?? "",
        placeholder: "Unconfirmed",
      }),
      () =>
        div(
          { class: "settings-note settings-state" },
          ...settingsStateLines(settings.val, settingsConfirmed.val, "phoneHotspotSsid", false).map(line => div(line))
        ),
      ownership === "network" ? div({ class: "settings-note" }, "Change it under Wi-Fi networks.") : div()
    )
  );
}
