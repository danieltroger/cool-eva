// @ts-check
import van from "../vendor/van-1.6.1.js";
import { settings, settingsConfirmed, settingsError } from "../lib/settings.js";
import {
  changes,
  baseSettings,
  booleanChoice,
  editBooleanChoice,
  sharedEditsDisabled,
  phoneTheme,
  phoneUnits,
  originalPhone,
  editPhoneTheme,
  editPhoneUnits,
  batchBusy,
  editRecordingKey,
  recordingKeyBackedUp,
  batchMessage,
} from "../lib/settings-batch.js";

/** @typedef {import("../lib/settings-batch.js").BooleanSettingKey} BooleanSettingKey */
const { button, details, div, input, label, option, select, span, summary } = van.tags;

/** @param {BooleanSettingKey} key @param {string} title @param {string} help
 * @param {"coolant"|"fan"} [readinessKey] */
export function BooleanField(key, title, help, readinessKey) {
  return SwitchField(
    title,
    () => booleanChoice(key),
    value => editBooleanChoice(key, value),
    help,
    () => (key in changes.val ? Was(baseSettings.val?.saved[key] ? "On" : "Off") : span({ hidden: true })),
    () => {
      const readiness = readinessKey ? settings.val?.readiness[readinessKey] : "";
      if (!readiness || ["Off", "On"].includes(readiness)) return span({ hidden: true });
      return span(
        { class: "settings-note", role: "status" },
        `${settingsConfirmed.val && !settingsError.val ? "Active" : "Unconfirmed — last contact"}: ${readiness}`
      );
    }
  );
}

/** @param {string} title @param {()=>boolean|null} readChoice @param {(value:boolean)=>void} writeChoice
 * @param {string} help @param {...import("../vendor/van-1.6.1.js").ChildDom} children */
export function SwitchField(title, readChoice, writeChoice, help = "", ...children) {
  return div(
    { class: "settings-field layout-compact-stack" },
    div(
      { class: "layout-row" },
      span({ class: "settings-field-label" }, title),
      help ? FieldHelp(title, help) : null,
      span({ class: "settings-note", hidden: () => readChoice() !== null }, "Unconfirmed"),
      button(
        {
          type: "button",
          role: "switch",
          class: "settings-switch",
          "aria-label": title,
          hidden: () => readChoice() === null,
          "aria-checked": () => String(readChoice() === true),
          disabled: sharedEditsDisabled,
          onclick: () => writeChoice(!readChoice()),
        },
        span({ class: "settings-switch-knob", "aria-hidden": "true" })
      )
    ),
    ...children
  );
}

export function PhoneFields() {
  return div(
    { class: "layout-stack" },
    Field(
      "Screen",
      select(
        {
          "aria-label": "Screen theme",
          disabled: () => batchBusy.val,
          value: () => phoneTheme.val,
          onchange: event =>
            editPhoneTheme(/** @type {import("../lib/theme.js").ThemePreference} */ (event.target.value)),
        },
        option({ value: "dark", selected: () => phoneTheme.val === "dark" }, "Dark"),
        option({ value: "light", selected: () => phoneTheme.val === "light" }, "Light"),
        option({ value: "auto", selected: () => phoneTheme.val === "auto" }, "Automatic")
      ),
      () =>
        phoneTheme.val !== originalPhone.val.theme
          ? Was(
              originalPhone.val.theme === "auto" ? "Automatic" : originalPhone.val.theme === "dark" ? "Dark" : "Light"
            )
          : span({ hidden: true })
    ),
    Field(
      "Units",
      select(
        {
          "aria-label": "Units",
          disabled: () => batchBusy.val,
          value: () => phoneUnits.val,
          onchange: event => editPhoneUnits(/** @type {import("../lib/units.js").UnitSystem} */ (event.target.value)),
        },
        option({ value: "metric", selected: () => phoneUnits.val === "metric" }, "Metric"),
        option({ value: "imperial", selected: () => phoneUnits.val === "imperial" }, "Imperial")
      ),
      () =>
        phoneUnits.val !== originalPhone.val.units
          ? Was(originalPhone.val.units === "metric" ? "Metric" : "Imperial")
          : span({ hidden: true })
    )
  );
}

export function RecordingFields() {
  const chooser = input({
    type: "file",
    accept: ".pem,.pub",
    hidden: true,
    "aria-label": "Choose public key",
    onchange: chooseRecordingKey,
  });
  return div(
    { class: "layout-stack" },
    () => span({ class: "settings-note", role: "status" }, settings.val?.readiness.recording ?? "Unconfirmed"),
    div(
      { class: "settings-field layout-compact-stack" },
      div(
        { class: "layout-list-row" },
        () =>
          span(
            changes.val.rideLogPublicKeyPem
              ? "Replacement key selected"
              : settings.val?.saved.recordingKeyConfigured
                ? "Public key saved"
                : "No public key"
          ),
        button(
          { class: "settings-button", disabled: sharedEditsDisabled, onclick: () => chooser.click() },
          "Replace key"
        )
      ),
      chooser,
      () =>
        changes.val.rideLogPublicKeyPem
          ? span({ class: "settings-was" }, "Replacement entered")
          : span({ hidden: true }),
      FieldHelp(
        "Recording public key",
        "Generate an X25519 pair on your laptop. Keep and back up the private half. Choose only the public half; keep old private keys for old logs."
      ),
      () =>
        changes.val.rideLogPublicKeyPem
          ? label(
              { class: "settings-check settings-note" },
              input({
                type: "checkbox",
                disabled: () => batchBusy.val,
                checked: () => recordingKeyBackedUp.val,
                onchange: event => {
                  recordingKeyBackedUp.val = event.target.checked;
                },
              }),
              "I kept a recoverable private-key backup."
            )
          : span({ hidden: true })
    )
  );
}

/** @param {string} title @param {...import("../vendor/van-1.6.1.js").ChildDom} children */
export function Field(title, ...children) {
  return div({ class: "settings-field layout-compact-stack" }, span({ class: "label" }, title), ...children);
}

/** @param {string} title @param {string} help */
export function FieldHelp(title, help) {
  return details(
    { class: "setting-help" },
    summary({ "aria-label": `Help for ${title}` }, "ⓘ"),
    div({ class: "settings-note" }, help)
  );
}

/** @param {string} value */
export function Was(value) {
  return span({ class: "settings-was" }, `Was ${value}`);
}

/** @param {Event} event */
async function chooseRecordingKey(event) {
  const chooser = /** @type {HTMLInputElement} */ (event.target);
  const file = chooser.files?.[0];
  if (!file) return;
  try {
    if (file.size > 16 * 1024) {
      batchMessage.val = "Choose an X25519 public key.";
      return;
    }
    editRecordingKey(await file.text());
  } catch (error) {
    console.warn("settings: public key file could not be read", error);
    batchMessage.val = "Choose an X25519 public key.";
  } finally {
    chooser.value = "";
  }
}
