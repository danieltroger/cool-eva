// @ts-check
import van from "../vendor/van-1.6.1.js";
import { generateBleSecret } from "../lib/ble-secret.js";
import { BLE_MODE, nativeShell } from "../lib/ble-link.js";
import { settings } from "../lib/settings.js";
import {
  changes,
  baseSettings,
  editBluetoothKey,
  keepSavedBluetoothKey,
  sharedEditsDisabled,
  bluetoothKeyBackedUp,
  bluetoothKeyShown,
  batchMessage,
  batchBusy,
} from "../lib/settings-batch.js";
import { Field, SwitchField, Was } from "./settings-batch-fields.js";
import { PendingBluetoothKey } from "./settings-bluetooth-recovery.js";
import { BleSection } from "./ble-connect.js";

const { button, div, input, label, span } = van.tags;

export function DashboardBluetooth() {
  return div(
    { class: "layout-stack" },
    BLE_MODE ? BleSection() : null,
    Field(
      "Bluetooth access key",
      div(
        { class: "layout-row" },
        input({
          "aria-label": "Bluetooth access key",
          type: () => (bluetoothKeyShown.val ? "text" : "password"),
          value: () => changes.val.dashboardBluetoothSecret ?? "",
          autocomplete: "new-password",
          placeholder: () =>
            changes.val.dashboardBluetoothSecret === ""
              ? "No key"
              : settings.val?.saved.bluetoothCodeId
                ? "Saved key"
                : "No key saved",
          disabled: sharedEditsDisabled,
          oninput: event => {
            const value = event.target.value;
            if (!value && settings.rawVal?.saved.bluetoothCodeId) {
              keepSavedBluetoothKey();
            } else {
              editBluetoothKey(value);
            }
          },
        }),
        button(
          {
            class: "settings-button",
            disabled: () => !changes.val.dashboardBluetoothSecret || batchBusy.val,
            onclick: () => {
              bluetoothKeyShown.val = !bluetoothKeyShown.rawVal;
            },
          },
          () => (bluetoothKeyShown.val ? "Hide" : "Show")
        )
      ),
      () =>
        "dashboardBluetoothSecret" in changes.val
          ? Was(baseSettings.val?.saved.bluetoothCodeId ? "Saved key" : "No key saved")
          : span({ hidden: true }),
      span({ class: "settings-note" }, "This key grants bike control."),
      div(
        { class: "layout-row settings-actions" },
        button(
          {
            class: "settings-button",
            disabled: sharedEditsDisabled,
            onclick: () => editBluetoothKey(generateBleSecret()),
          },
          "New key"
        ),
        () =>
          changes.val.dashboardBluetoothSecret
            ? button(
                { class: "settings-button", disabled: () => batchBusy.val, onclick: () => void copyBluetoothKey() },
                "Copy"
              )
            : span({ hidden: true })
      ),
      () =>
        changes.val.dashboardBluetoothSecret
          ? label(
              { class: "settings-check settings-note" },
              input({
                type: "checkbox",
                checked: () => bluetoothKeyBackedUp.val,
                disabled: () => batchBusy.val,
                onchange: event => {
                  bluetoothKeyBackedUp.val = event.target.checked;
                },
              }),
              "I saved a recoverable copy of the new key."
            )
          : span({ hidden: true })
    ),
    SwitchField("Dashboard Bluetooth enabled", bluetoothEnabled, enabled => {
      if (!enabled) {
        editBluetoothKey("");
      } else if (settings.rawVal?.saved.bluetoothCodeId) {
        keepSavedBluetoothKey();
      } else {
        editBluetoothKey(generateBleSecret());
      }
    }),
    PendingBluetoothKey()
  );
}

function bluetoothEnabled() {
  if (!settings.val?.ok) return null;
  return changes.val.dashboardBluetoothSecret !== undefined
    ? !!changes.val.dashboardBluetoothSecret
    : !!settings.val.saved.bluetoothCodeId;
}

async function copyBluetoothKey() {
  const secret = changes.rawVal.dashboardBluetoothSecret ?? "";
  try {
    await navigator.clipboard.writeText(secret);
  } catch (error) {
    console.warn("settings: key copy unavailable", error instanceof Error ? error.name : "unknown error");
    const shell = nativeShell();
    if (shell) {
      try {
        await shell.saveFile("cool-eva-bluetooth-key.txt", new TextEncoder().encode(secret + "\n"), "text/plain");
      } catch (failure) {
        console.warn("settings: key export unavailable", failure instanceof Error ? failure.name : "unknown error");
        bluetoothKeyBackedUp.val = false;
        bluetoothKeyShown.val = false;
        batchMessage.val = "The key file could not be saved. Keep a recoverable copy before saving.";
      }
    } else {
      const link = document.createElement("a");
      const url = URL.createObjectURL(new Blob([secret + "\n"], { type: "text/plain" }));
      link.href = url;
      link.download = "cool-eva-bluetooth-key.txt";
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
    }
  }
}
