// @ts-check
import van from "../vendor/van-1.6.1.js";
import { pendingChoiceDescriptions } from "../lib/settings-state.js";
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
    { class: "settings-card", hidden: () => !maintenance && !settings.val?.pending.length && !settings.val?.fault },
    () =>
      div(
        { class: "settings-note" },
        settings.val?.pending.length
          ? `${settingsError.val ? "Pi unconfirmed. Last confirmed saved choices" : "Saved for next start"}: ${pendingChoiceDescriptions(settings.val).join("; ")}.`
          : settings.val?.fault
            ? "Repair the reported problem before retrying. The original document is retained."
            : settingsError.val
              ? "Pi unconfirmed. Reconnect to read pending choices."
              : "No saved changes waiting."
      ),
    () =>
      settings.val?.pending.some(key => key === "hubAddress" || key === "discoverHubOnce")
        ? div(
            { class: "settings-note" },
            "Connecting Cool Eva may replace this motorcycle’s existing Bluetooth pairing."
          )
        : div(),
    div(
      { class: "settings-row" },
      div(
        () => (settings.val?.fault ? "Retry settings after repair" : "Restart Cool Eva"),
        div(
          { class: "settings-note" },
          "Restart uses saved choices, never unsaved drafts. Readings and recording pause. Wi-Fi or Bluetooth may disconnect. Reconnect to confirm what is active."
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
        () =>
          armed.val === RESTART_KEY
            ? settings.val?.fault
              ? "Confirm retry"
              : "Confirm restart"
            : settings.val?.fault
              ? "Retry settings"
              : "Restart"
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
