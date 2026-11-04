// @ts-check
import van from "../vendor/van-1.6.1.js";
import { readPhoneValue, writePhoneValue } from "../lib/phone-storage.js";
import { generateBleSecret } from "../lib/ble-secret.js";
import { armed } from "../lib/arming.js";
import {
  settings,
  settingsBusy,
  settingsError,
  settingsConfirmed,
  saveSetting,
  settingsMessages,
} from "../lib/settings.js";
import {
  BLE_MODE,
  nativeShell,
  originAllowed,
  rememberSecret,
  reconnect,
  chooseAndConnect,
  deviceChosen,
} from "../lib/ble-link.js";
import { SettingsCard, SaveResult, PendingLabel, CompactButton } from "./settings-fields.js";
import { BleSection } from "./ble-connect.js";

const { button, div, input, label } = van.tags;
const generatedCode = van.state("");
const copied = van.state(false);
const preparedFor = van.state("");
const manualCopyNeeded = van.state(false);
const showCode = van.state(false);

export function DashboardBluetooth() {
  return div(
    BleSection(),
    PendingBluetoothKey(),
    SettingsCard(
      "Dashboard Bluetooth",
      "This phone ↔ Cool Eva. Creating or replacing the shared key disconnects other phones after restart. Give them the new key from your saved copy. Anyone with this key can control the bike.",
      () =>
        div(
          { class: "settings-note" },
          `${settingsConfirmed.val && !settingsError.val ? "Active" : "Unconfirmed — last contact"}: ${settings.val?.readiness.bluetooth ?? "Not read"}`
        ),
      div(
        { class: "settings-row" },
        div(
          () =>
            generatedCode.val && preparedFor.val === settings.val?.instanceId
              ? input({
                  "aria-label": "New Bluetooth key",
                  type: showCode.val ? "text" : "password",
                  readonly: true,
                  value: generatedCode.val,
                  autocomplete: "new-password",
                })
              : div(
                  !settingsConfirmed.val || settingsError.val
                    ? "Pi unconfirmed. Read the saved key state before changing it."
                    : settings.val?.saved.bluetoothCodeId
                      ? "A shared key is already saved."
                      : "No key saved."
                ),
          label(
            { class: "settings-note settings-check" },
            input({
              type: "checkbox",
              checked: () => copied.val && preparedFor.val === settings.val?.instanceId,
              disabled: () => !generatedCode.val || preparedFor.val !== settings.val?.instanceId || !settings.val?.ok,
              onchange: event => {
                copied.val = /** @type {HTMLInputElement} */ (event.target).checked;
              },
            }),
            " I saved a recoverable copy of the new key."
          ),
          PendingLabel(
            "dashboardBluetoothSecret",
            () => !!generatedCode.val && preparedFor.val === settings.val?.instanceId
          )
        ),
        () =>
          generatedCode.val && preparedFor.val === settings.val?.instanceId
            ? button(
                {
                  class: "settings-button",
                  onclick: () => {
                    void copyCode();
                  },
                },
                "Copy"
              )
            : div(),
        () =>
          manualCopyNeeded.val && generatedCode.val && preparedFor.val === settings.val?.instanceId
            ? button(
                {
                  class: "settings-button",
                  onclick: () => {
                    showCode.val = !showCode.rawVal;
                  },
                },
                showCode.val ? "Hide key" : "Show key"
              )
            : div(),
        button(
          {
            class: "settings-button",
            disabled: () =>
              !!settingsBusy.val ||
              !!settingsError.val ||
              !settings.val?.ok ||
              (!!generatedCode.val && preparedFor.val === settings.val.instanceId && !copied.val),
            onclick: () => {
              void createOrSaveCode();
            },
          },
          () => (generatedCode.val && preparedFor.val === settings.val?.instanceId ? "Save" : "New key")
        )
      ),
      SaveResult("dashboardBluetoothSecret")
    ),
    SettingsCard(
      "Turn dashboard Bluetooth off",
      "Saving off stops advertising after the next explicit restart. Keep a working Wi-Fi route first; restarting a disabled Bluetooth server cannot be done through its tunnel.",
      div(
        { class: "settings-row" },
        () =>
          div(
            `Saved choice: ${settingsConfirmed.val && !settingsError.val && settings.val ? (settings.val.saved.bluetoothCodeId ? "On" : "Off") : "Unconfirmed"}`
          ),
        CompactButton("Save off", () => {
          void saveSetting("dashboardBluetoothSecret", { dashboardBluetoothSecret: "" });
        })
      )
    ),
    SettingsCard(
      "Use an existing access code",
      "On another phone, open the Bluetooth dashboard and import your saved key or password-manager copy. Connect this phone chooses the Pi; it never replaces the shared key."
    )
  );
}

async function copyCode() {
  try {
    await navigator.clipboard.writeText(generatedCode.rawVal);
    settingsMessages.val = {
      ...settingsMessages.rawVal,
      dashboardBluetoothSecret: "Copied. Keep a recoverable copy, then confirm it before saving.",
    };
  } catch (error) {
    console.warn("settings: key copy unavailable", error instanceof Error ? error.name : "unknown error");
    settingsMessages.val = {
      ...settingsMessages.rawVal,
      dashboardBluetoothSecret: "Clipboard unavailable. Save the key file, then confirm you kept it.",
    };
    const shell = nativeShell();
    if (shell) {
      try {
        await shell.saveFile(
          "cool-eva-bluetooth-key.txt",
          new TextEncoder().encode(generatedCode.rawVal + "\n"),
          "text/plain"
        );
      } catch (failure) {
        console.warn("settings: key export unavailable", failure instanceof Error ? failure.name : "unknown error");
        copied.val = false;
        manualCopyNeeded.val = true;
        settingsMessages.val = {
          ...settingsMessages.rawVal,
          dashboardBluetoothSecret:
            "The key file could not be saved. No backup is confirmed. Retry Copy, or Show key and keep a recoverable copy yourself before confirming it.",
        };
      }
    } else {
      const link = document.createElement("a");
      const url = URL.createObjectURL(new Blob([generatedCode.rawVal + "\n"], { type: "text/plain" }));
      link.href = url;
      link.download = "cool-eva-bluetooth-key.txt";
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
    }
  }
}

async function createOrSaveCode() {
  const current = settings.rawVal;
  if (!current) return;
  if (!generatedCode.rawVal || preparedFor.rawVal !== current.instanceId) {
    armed.val = "";
    generatedCode.val = generateBleSecret();
    preparedFor.val = current.instanceId ?? "";
    copied.val = false;
    showCode.val = false;
    manualCopyNeeded.val = false;
    settingsMessages.val = {
      ...settingsMessages.rawVal,
      dashboardBluetoothSecret: "Draft key — not saved. Keep a recoverable copy before saving it on this Pi.",
    };
    return;
  }
  await saveSetting("dashboardBluetoothSecret", { dashboardBluetoothSecret: generatedCode.rawVal });
  const saved = settings.rawVal;
  if (
    settingsMessages.rawVal.dashboardBluetoothSecret?.startsWith("Saved.") &&
    saved?.saved.bluetoothCodeId &&
    saved.revision === (current.revision ?? -1) + 1
  ) {
    if (!writePhoneValue(`cool-eva.pending-code:${saved.saved.bluetoothCodeId}`, generatedCode.rawVal)) {
      settingsMessages.val = {
        ...settingsMessages.rawVal,
        dashboardBluetoothSecret:
          "Saved on the Pi. This browser could not keep the key: retain your external copy and use Wi-Fi to restart.",
      };
    }
    generatedCode.val = "";
    copied.val = false;
  }
}

function PendingBluetoothKey() {
  return () => {
    const current = settings.val;
    if (!current || current.saved.bluetoothCodeId === current.active.bluetoothCodeId) return div();
    const cached = current.saved.bluetoothCodeId
      ? readPhoneValue(`cool-eva.pending-code:${current.saved.bluetoothCodeId}`)
      : null;
    const activeCopy = current.active.bluetoothCodeId
      ? readPhoneValue(`cool-eva.active-code:${current.active.bluetoothCodeId}`)
      : null;
    return SettingsCard(
      "Saved, not active",
      cached
        ? "This phone kept the pending key. The current session still uses the old key until restart. If the restart reply was lost, reconnect with the saved pending key, then read back the active state."
        : "This phone does not hold the pending key. Get the owner's saved copy or use Wi-Fi before restarting; a superseded key cannot reconnect.",
      BLE_MODE && cached && originAllowed()
        ? div(
            { class: "settings-row" },
            div("Use saved pending key"),
            activeCopy
              ? button(
                  {
                    class: "settings-button",
                    onclick: () => {
                      rememberSecret(activeCopy);
                      void reconnect().catch(error =>
                        console.warn(
                          "settings: active key reconnect unavailable",
                          error instanceof Error ? error.name : "unknown error"
                        )
                      );
                    },
                  },
                  "Use active"
                )
              : div(),
            button(
              {
                class: "settings-button",
                onclick: () => {
                  rememberSecret(cached);
                  const attempt = deviceChosen() ? reconnect() : chooseAndConnect();
                  void attempt.catch(error => {
                    console.warn(
                      "settings: pending key reconnect failed",
                      error instanceof Error ? error.name : "unknown error"
                    );
                  });
                },
              },
              "Use saved"
            )
          )
        : div()
    );
  };
}
