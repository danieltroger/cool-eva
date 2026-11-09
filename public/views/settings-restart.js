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

/** @param {boolean} [maintenance] */
export function SettingsRestart(maintenance = true) {
  return div(
    {
      class: "layout-compact-stack settings-restart",
      hidden: () => !maintenance && !settings.val?.pending.length && !settings.val?.fault,
    },
    () =>
      div(
        { class: "settings-note" },
        settings.val?.pending.length
          ? "Saved. Applies at next restart."
          : settings.val?.fault
            ? "Retry settings after repair"
            : "No saved changes waiting."
      ),
    div(
      { class: "layout-row settings-footer-actions" },
      button(
        {
          class: "settings-button settings-primary",
          title: "Restart uses saved choices, never unsaved drafts. Reconnect to confirm what is active.",
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
        () =>
          armed.val === RESTART_KEY
            ? settings.val?.fault
              ? "Confirm retry"
              : "Confirm restart"
            : settings.val?.fault
              ? "Retry settings"
              : "Restart now"
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
