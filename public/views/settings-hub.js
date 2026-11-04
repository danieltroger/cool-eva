// @ts-check
import van from "../vendor/van-1.6.1.js";
import { request } from "../lib/transport.js";
import { settings, settingsAction, settingsMessages, settingsBusy, settingsError } from "../lib/settings.js";
import { SettingsCard, CompactButton, PendingLabel, SaveResult } from "./settings-fields.js";
const { button, div, select, option } = van.tags;
const candidates = van.state(/** @type {import("../../src/settings/view.ts").HubCandidate[]} */ ([]));
const selected = van.state("");
const scanMessage = van.state("");

export function MotorcycleConnection() {
  return div(
    SettingsCard(
      "Motorcycle connection",
      "Cool Eva ↔ motorcycle hub. Choose carefully when other Energicas are nearby: connecting may occupy the hub’s one enrolment slot. Saving or forgetting takes effect after restart.",
      () =>
        div(
          { class: "settings-note" },
          `Active: ${settings.val?.active.hubAddress ?? "None"} · ${settings.val?.readiness.hub ?? "Unconfirmed"}`
        ),
      () =>
        div(
          { class: "settings-note" },
          `Saved: ${settings.val?.saved.hubAddress ?? (settings.val?.saved.discoverHubOnce ? "Discover once, then remember" : "None")}`
        ),
      div(
        { class: "settings-row" },
        div(
          () =>
            candidates.val.length
              ? select(
                  {
                    "aria-label": "Choose your motorcycle",
                    onchange: event => {
                      selected.val = /** @type {HTMLSelectElement} */ (event.target).value;
                    },
                  },
                  option({ value: "" }, "Choose motorcycle…"),
                  ...candidates.val.map(candidate =>
                    option({ value: candidate.address }, `${candidate.name} · ${candidate.address}`)
                  )
                )
              : div("Wake the motorcycle before scanning."),
          PendingLabel("hubAddress")
        ),
        CompactButton("Scan", () => {
          void scan();
        }),
        button(
          {
            class: "settings-button",
            disabled: () => !selected.val || !settings.val?.ok || !!settingsError.val || !!settingsBusy.val,
            onclick: () => {
              void settingsAction("hub", "/settings/hub", "POST", {
                revision: settings.rawVal?.revision,
                address: selected.rawVal,
              });
            },
          },
          "Save"
        )
      ),
      () => div({ class: "settings-note", role: "status" }, scanMessage.val),
      SaveResult("hub")
    ),
    SettingsCard(
      "Forget saved motorcycle",
      "Keeps this ride connected until you explicitly restart. The next start will not discover or connect to a hub.",
      div(
        { class: "settings-row" },
        div("Remove the saved connection"),
        CompactButton("Forget", () => {
          void settingsAction("hub", "/settings/hub", "POST", { revision: settings.rawVal?.revision, address: null });
        })
      )
    )
  );
}

async function scan() {
  settingsBusy.val = "hub-scan";
  scanMessage.val = "Scanning…";
  try {
    const response = await request("/settings/hub-candidates", {
      method: "POST",
      headers: { "X-Cool-Eva": "settings" },
      body: "{}",
    });
    const reply = /** @type {import("../../src/settings/view.ts").HubCandidatesReply} */ (await response.json());
    candidates.val = reply.candidates ?? [];
    selected.val = "";
    scanMessage.val = reply.message;
  } catch (error) {
    console.warn("settings: motorcycle scan unavailable", error);
    settingsMessages.val = { ...settingsMessages.rawVal, hub: "Scan unavailable. Reconnect and try again." };
  } finally {
    settingsBusy.val = "";
  }
}
