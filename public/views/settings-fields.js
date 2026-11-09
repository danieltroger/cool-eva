// @ts-check
import van from "../vendor/van-1.6.1.js";
import { settingsStateLines } from "../lib/settings-state.js";
import {
  settings,
  settingsBusy,
  settingsMessages,
  settingsError,
  settingsConfirmed,
  settingIsDirty,
} from "../lib/settings.js";

const { button, div, h3 } = van.tags;
/** @typedef {import("../../src/settings/schema.ts").StartupSettings} StartupSettings */

/** @param {string} title @param {string} text @param {...import("../vendor/van-1.6.1.js").ChildDom} children */
export function SettingsCard(title, text, ...children) {
  return div({ class: "settings-card" }, h3(title), text ? div({ class: "settings-note" }, text) : div(), ...children);
}

/** @param {string} key */
export function SaveResult(key) {
  return () => div({ class: "settings-note", role: "status" }, settingsMessages.val[key] ?? "");
}

/** @param {string} text @param {() => void} action */
export function CompactButton(text, action) {
  return button(
    {
      class: "settings-button",
      disabled: () => !!settingsBusy.val || !!settingsError.val || !settingsConfirmed.val || !settings.val?.ok,
      onclick: action,
    },
    text
  );
}

/** @param {keyof StartupSettings} key @param {() => boolean} [candidateIsDirty] */
export function PendingLabel(key, candidateIsDirty) {
  return () =>
    div(
      { class: "settings-note settings-state" },
      ...settingsStateLines(
        settings.val,
        settingsConfirmed.val && !settingsError.val,
        key,
        settingIsDirty(key) || !!candidateIsDirty?.()
      ).map(line => div(line))
    );
}
