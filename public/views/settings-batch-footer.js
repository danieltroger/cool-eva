// @ts-check
import van from "../vendor/van-1.6.1.js";
import { settings, settingsMessages } from "../lib/settings.js";
import {
  batchIsDirty,
  batchBusy,
  batchValidation,
  batchMessage,
  saveSettingsBatch,
  cancelSettingsBatch,
} from "../lib/settings-batch.js";
import { SettingsRestart } from "./settings-restart.js";
import { refuseKeyRepeat } from "../lib/arming.js";

const { button, div, span } = van.tags;

export function SettingsBatchFooter() {
  const footer = div(
    {
      class: "settings-footer",
      hidden: () => !batchIsDirty() && !settings.val?.pending.length && !settings.val?.fault && !batchMessage.val,
    },
    () =>
      batchIsDirty()
        ? div(
            { class: "layout-compact-stack" },
            span({ class: "settings-note", role: "status", "data-settings-save-message": "" }, () =>
              batchBusy.val
                ? "Working…"
                : batchMessage.val || settingsMessages.val.batch || batchValidation() || "Unsaved changes"
            ),
            div(
              { class: "layout-row settings-footer-actions" },
              button(
                {
                  class: "settings-button",
                  "data-settings-cancel": "",
                  disabled: () => batchBusy.val,
                  onclick: cancelSettingsBatch,
                },
                "Cancel"
              ),
              button(
                {
                  class: "settings-button settings-primary",
                  "data-settings-save": "",
                  disabled: () => batchBusy.val || !!batchValidation(),
                  onkeydown: refuseKeyRepeat,
                  onclick: () => void saveSettingsBatch(),
                },
                "Save"
              )
            )
          )
        : div(
            { class: "layout-compact-stack" },
            () => (batchMessage.val ? span({ class: "settings-note", role: "status" }, batchMessage.val) : null),
            SettingsRestart(false)
          )
  );
  const observer = new ResizeObserver(() => {
    if (!footer.isConnected) {
      observer.disconnect();
      return;
    }
    const page = footer.closest(".settings-batch-page");
    if (page instanceof HTMLElement) {
      page.style.setProperty("--settings-footer-height", `${footer.getBoundingClientRect().height}px`);
    }
  });
  queueMicrotask(() => {
    if (footer.isConnected) {
      observer.observe(footer);
    }
  });
  return footer;
}
