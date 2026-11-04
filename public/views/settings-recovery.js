// @ts-check
import van from "../vendor/van-1.6.1.js";
import { settings } from "../lib/settings.js";
import { SettingsCard } from "./settings-fields.js";

const { a, div } = van.tags;

export function SettingsRecovery() {
  return () => {
    const current = settings.val;
    if (!current?.fault) return div();
    return SettingsCard(
      "Settings need attention",
      current.fault,
      div(
        { class: "settings-note" },
        current.ok
          ? "Repair the reported problem, then retry settings after repair. Saved changes still apply only after restart."
          : "The original document is retained and shared edits are disabled. Restore a known-good document or use software that supports it, then retry settings after repair."
      ),
      div(
        { class: "settings-links" },
        a(
          {
            class: "settings-link",
            href: "https://github.com/danieltroger/cool-eva/blob/main/docs/configuration.md#repair-settings",
            target: "_blank",
            rel: "noopener",
          },
          "Repair instructions →"
        ),
        a(
          {
            class: "settings-link",
            href: "https://github.com/danieltroger/cool-eva/blob/main/INSTALL.md",
            target: "_blank",
            rel: "noopener",
          },
          "Supported software →"
        )
      )
    );
  };
}
