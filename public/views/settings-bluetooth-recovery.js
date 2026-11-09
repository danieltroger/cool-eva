// @ts-check
import van from "../vendor/van-1.6.1.js";
import { readPhoneValue } from "../lib/phone-storage.js";
import { settings } from "../lib/settings.js";
import { BLE_MODE, originAllowed, rememberSecret, reconnect, chooseAndConnect, deviceChosen } from "../lib/ble-link.js";
import { SettingsCard } from "./settings-fields.js";
const { button, div } = van.tags;

export function PendingBluetoothKey() {
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
