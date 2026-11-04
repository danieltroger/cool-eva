// @ts-check
import van from "../vendor/van-1.6.1.js";
import {
  editSetting,
  saveSetting,
  settingDraft,
  settings,
  settingsBusy,
  settingsMessages,
  settingsError,
  settingsConfirmed,
  settingIsDirty,
  discardSetting,
} from "../lib/settings.js";

const { button, div, h3, input, option, select, textarea, label } = van.tags;
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

/** @param {"coolantProbesEnabled" | "radiatorFanEnabled" | "customBmsConfigurationFlashed" | "automaticDcChargingEnabled"} key @param {string} title @param {string} help */
export function BooleanSetting(key, title, help) {
  const draft = settingDraft(key, String(settings.rawVal?.saved[key] ?? false));
  return SettingsCard(
    title,
    help,
    div(
      { class: "settings-row" },
      div(
        select(
          {
            "aria-label": title,
            value: () => draft.val,
            onchange: event => editSetting(key, /** @type {HTMLSelectElement} */ (event.target).value),
          },
          option(
            { value: "false", selected: () => draft.val === "false" },
            key === "customBmsConfigurationFlashed" ? "No" : "Off"
          ),
          option(
            { value: "true", selected: () => draft.val === "true" },
            key === "customBmsConfigurationFlashed" ? "Yes" : "On"
          )
        ),
        PendingLabel(key)
      ),
      DiscardEdit(key),
      CompactButton("Save", () => {
        void saveSetting(key, { [key]: draft.rawVal === "true" });
      })
    ),
    SaveResult(key)
  );
}

/** @param {"phoneHotspotSsid" | "rideLogDirectory" | "vcuParameterDirectory"} key @param {string} title @param {string} help */
export function TextSetting(key, title, help) {
  const draft = settingDraft(key, settings.rawVal?.saved[key] ?? "");
  return SettingsCard(
    title,
    help,
    div(
      { class: "settings-row" },
      div(
        input({
          "aria-label": title,
          value: () => draft.val,
          spellcheck: false,
          oninput: event => editSetting(key, /** @type {HTMLInputElement} */ (event.target).value),
        }),
        PendingLabel(key)
      ),
      DiscardEdit(key),
      CompactButton("Save", () => {
        void saveSetting(key, { [key]: draft.rawVal });
      })
    ),
    SaveResult(key)
  );
}

export function RecordingKeySetting() {
  const key = "rideLogPublicKeyPem";
  const draft = settingDraft(key, "");
  const backedUp = settingDraft("recording-backup", "false");
  return SettingsCard(
    "Recording public key",
    "Generate an X25519 pair on your laptop. Keep its private half there and back it up. Choose or paste only the public half. Keep old private keys for old logs; a different key affects future recordings after restart.",
    div(
      { class: "settings-row" },
      div(
        input({
          type: "file",
          accept: ".pem,.pub",
          "aria-label": "Choose public key",
          onchange: async event => {
            const file = /** @type {HTMLInputElement} */ (event.target).files?.[0];
            if (file) {
              editSetting(key, await file.text());
            }
          },
        }),
        textarea({
          "aria-label": "X25519 public key",
          rows: 3,
          value: () => draft.val,
          oninput: event => editSetting(key, /** @type {HTMLTextAreaElement} */ (event.target).value),
        }),
        label(
          { class: "settings-note" },
          input({
            type: "checkbox",
            checked: () => backedUp.val === "true",
            onchange: event =>
              editSetting("recording-backup", String(/** @type {HTMLInputElement} */ (event.target).checked)),
          }),
          " I kept a recoverable private-key backup."
        ),
        PendingLabel(key)
      ),
      DiscardEdit(key),
      CompactButton("Save", () => {
        if (backedUp.rawVal !== "true") {
          settingsMessages.val = {
            ...settingsMessages.rawVal,
            [key]: "Keep a recoverable private-key backup, then confirm it before saving.",
          };
          return;
        }
        if (/PRIVATE KEY/.test(draft.rawVal)) {
          settingsMessages.val = {
            ...settingsMessages.rawVal,
            [key]: "Keep the private key on your own devices. Choose only the public half.",
          };
          return;
        }
        void saveSetting(key, { rideLogPublicKeyPem: draft.rawVal });
      })
    ),
    SaveResult(key)
  );
}

/** @param {keyof StartupSettings} key */
export function PendingLabel(key) {
  return () =>
    div(
      { class: "settings-note" },
      settings.val?.pending.includes(key) || (key === "hubAddress" && settings.val?.pending.includes("discoverHubOnce"))
        ? "Saved, not active"
        : "Active at this start"
    );
}

/** @param {string} key */
function DiscardEdit(key) {
  return () =>
    settingIsDirty(key) ? button({ class: "settings-button", onclick: () => discardSetting(key) }, "Discard") : div();
}
