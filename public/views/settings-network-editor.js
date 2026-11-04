// @ts-check
import van from "../vendor/van-1.6.1.js";
import { armed } from "../lib/arming.js";
import {
  networks,
  networkBusy,
  networkConfirmed,
  networkMessage,
  cancelNetworkDraft,
  saveNetwork,
} from "../lib/networks.js";
import { SettingsCard } from "./settings-fields.js";
import { validNetworkPassword } from "../lib/network-input.js";

const { button, div, input, label, option, select } = van.tags;

/** @param {import("../lib/networks.js").NetworkEditorDraft} draft */
export function NetworkEditor(draft) {
  return SettingsCard(
    draft.replacedUuid ? "Change saved network" : "Add a network",
    "Draft — not saved. Saving keeps a separate inactive candidate. Wi-Fi changes only during an armed trial.",
    div(
      { class: "settings-form-fields" },
      label(
        "Purpose",
        select(
          {
            "aria-label": "Network purpose",
            value: () => draft.purpose.val,
            onchange: event => {
              draft.purpose.val = event.target.value;
              armed.val = "";
            },
          },
          option({ value: "home" }, "Home Wi-Fi"),
          option({ value: "hotspot" }, "Phone hotspot")
        )
      ),
      label(
        "Network name",
        input({
          "aria-label": "Network name",
          autocomplete: "off",
          value: draft.ssid.rawVal,
          oninput: event => {
            draft.ssid.val = event.target.value;
            armed.val = "";
          },
        })
      ),
      label(
        { class: "settings-check" },
        input({
          type: "checkbox",
          checked: draft.hidden.rawVal,
          onchange: event => {
            draft.hidden.val = event.target.checked;
            armed.val = "";
          },
        }),
        "Hidden network"
      ),
      label(
        { class: "settings-check" },
        input({
          type: "checkbox",
          checked: draft.accessPointChange.rawVal,
          onchange: event => {
            draft.accessPointChange.val = event.target.checked;
            armed.val = "";
          },
        }),
        "I am changing the hotspot or router itself"
      ),
      () =>
        draft.accessPointChange.val
          ? div(
              { class: "settings-note" },
              networks.val?.viaBluetooth
                ? "This Pi was read over Bluetooth. Save here, change the hotspot/router, reconnect and read back here, then Try network."
                : "Set up and test Bluetooth first, then re-enter and save this draft in that dashboard. A new Bluetooth key must be active before Save."
            )
          : div(),
      ...(draft.replacedUuid
        ? [
            label(
              "Password choice",
              select(
                {
                  "aria-label": "Password choice",
                  value: () => draft.passwordMode.val,
                  onchange: event => {
                    draft.passwordMode.val = event.target.value;
                    draft.password.val = "";
                    draft.shown.val = false;
                    armed.val = "";
                  },
                },
                option({ value: "keep" }, "Keep saved password"),
                option({ value: "change" }, "Change password")
              )
            ),
          ]
        : []),
      () =>
        draft.passwordMode.val === "keep"
          ? div({ class: "settings-note" }, "Keep saved password. The stored password is not shown.")
          : label(
              draft.replacedUuid ? "New password" : "Password",
              input({
                "aria-label": draft.replacedUuid ? "New password" : "Password",
                type: () => (draft.shown.val ? "text" : "password"),
                autocomplete: "new-password",
                value: () => draft.password.val,
                oninput: event => {
                  draft.password.val = event.target.value;
                  armed.val = "";
                },
              })
            ),
      () =>
        draft.passwordMode.val === "change" && draft.password.val && !validNetworkPassword(draft.password.val)
          ? div({ class: "settings-note", role: "status" }, "Use 8–63 ASCII characters or 64 hexadecimal digits.")
          : div(),
      div(
        { class: "settings-note" },
        "WPA2 or WPA2/WPA3 personal networks on 2.4 GHz. An empty new password cannot erase or retain the saved password."
      )
    ),
    div(
      { class: "settings-actions" },
      () =>
        draft.passwordMode.val === "change"
          ? button(
              {
                class: "settings-button",
                onclick: () => {
                  draft.shown.val = !draft.shown.rawVal;
                },
              },
              () => (draft.shown.val ? "Hide password" : "Show password")
            )
          : div(),
      button({ class: "settings-button", disabled: () => networkBusy.val, onclick: cancelNetworkDraft }, "Cancel"),
      button(
        {
          class: "settings-button",
          disabled: () =>
            !networkConfirmed.val || networkBusy.val || (draft.accessPointChange.val && !networks.val?.viaBluetooth),
          onclick: () => void saveNetwork(),
        },
        "Save"
      )
    ),
    () => div({ class: "settings-note", role: "status" }, networkMessage.val)
  );
}
