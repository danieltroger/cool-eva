// @ts-check
import van from "../vendor/van-1.6.1.js";
import { request } from "../lib/transport.js";
import {
  settings,
  settingsAction,
  settingsMessages,
  settingsBusy,
  settingsError,
  settingsConfirmed,
} from "../lib/settings.js";
import { settingChoice } from "../lib/settings-state.js";
import { armed } from "../lib/arming.js";
import { SettingsCard, CompactButton, PendingLabel, SaveResult } from "./settings-fields.js";
const { button, div, select, option } = van.tags;
const candidates = van.state(/** @type {import("../../src/settings/view.ts").HubCandidate[]} */ ([]));
const selected = van.state("");
const selectionRevision = van.state(/** @type {number | null} */ (null));
const scannedFor = van.state("");
const scanMessage = van.state("");

export function MotorcycleConnection() {
  return div(
    SettingsCard(
      "Motorcycle connection",
      "Cool Eva ↔ motorcycle hub. Connecting Cool Eva may replace this motorcycle’s existing Bluetooth pairing. Saving or forgetting takes effect after restart.",
      () => div({ class: "settings-note" }, `Connection: ${settings.val?.readiness.hub ?? "Unconfirmed"}`),
      div(
        { class: "settings-form-fields" },
        () =>
          candidates.val.length && scannedFor.val === settings.val?.instanceId
            ? select(
                {
                  "aria-label": "Choose your motorcycle",
                  value: () => selected.val,
                  onchange: event => {
                    if (!selected.rawVal) {
                      selectionRevision.val = settings.rawVal?.revision ?? null;
                    }
                    selected.val = /** @type {HTMLSelectElement} */ (event.target).value;
                    armed.val = "";
                    settingsMessages.val = { ...settingsMessages.rawVal, hub: "" };
                  },
                },
                option({ value: "", selected: () => !selected.val }, "Choose motorcycle…"),
                ...candidates.val.map(candidate =>
                  option(
                    { value: candidate.address, selected: () => selected.val === candidate.address },
                    `${candidate.name} · ${candidate.address}`
                  )
                )
              )
            : div("Wake the motorcycle before scanning."),
        () =>
          selected.val && scannedFor.val === settings.val?.instanceId
            ? div(
                { class: "settings-note" },
                `Draft motorcycle: ${candidates.val.find(candidate => candidate.address === selected.val)?.name ?? "Unnamed motorcycle"} · ${selected.val}. A name and address do not prove it is your bike; check nearby motorcycles before saving.`
              )
            : div(),
        PendingLabel("hubAddress", () => !!selected.val && scannedFor.val === settings.val?.instanceId)
      ),
      () => div({ class: "settings-note", role: "status" }, scanMessage.val),
      SaveResult("hub"),
      div(
        { class: "settings-actions" },
        CompactButton("Scan", () => {
          void scan();
        }),
        () =>
          selected.val && scannedFor.val === settings.val?.instanceId
            ? button({ class: "settings-button", onclick: cancelSelection }, "Cancel")
            : div({ hidden: true }),
        button(
          {
            class: "settings-button",
            disabled: () =>
              !selected.val ||
              scannedFor.val !== settings.val?.instanceId ||
              !settings.val?.ok ||
              !settingsConfirmed.val ||
              !!settingsError.val ||
              !!settingsBusy.val,
            onclick: () => {
              void saveSelection();
            },
          },
          "Save"
        )
      )
    ),
    SettingsCard(
      "Forget saved motorcycle",
      "Removes the selection from Cool Eva; it does not clear the motorcycle’s own Bluetooth pairing slot. Keeps this ride connected until you explicitly restart. The next start will not discover or connect to a hub.",
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
  if (!settingsConfirmed.rawVal || settingsError.rawVal || settingsBusy.rawVal) return;
  const instance = settings.rawVal?.instanceId;
  settingsBusy.val = "hub-scan";
  scanMessage.val = "Scanning…";
  settingsMessages.val = { ...settingsMessages.rawVal, hub: "" };
  candidates.val = [];
  selected.val = "";
  try {
    const response = await request("/settings/hub-candidates", {
      method: "POST",
      headers: { "X-Cool-Eva": "settings" },
      body: "{}",
    });
    const reply = /** @type {import("../../src/settings/view.ts").HubCandidatesReply} */ (await response.json());
    if (settings.rawVal?.instanceId !== instance) {
      scanMessage.val = "The connected Pi changed. Scan again on this Pi.";
      return;
    }
    scannedFor.val = instance ?? "";
    candidates.val = response.ok && reply.ok ? reply.candidates : [];
    scanMessage.val = reply.message;
  } catch (error) {
    console.warn("settings: motorcycle scan unavailable", error);
    scanMessage.val = "Scan unavailable. Reconnect and try Scan again.";
  } finally {
    settingsBusy.val = "";
  }
}

function cancelSelection() {
  armed.val = "";
  settingsMessages.val = { ...settingsMessages.rawVal, hub: "" };
  selected.val = "";
  candidates.val = [];
  scanMessage.val = `Selection cancelled. Keeping saved motorcycle: ${settings.rawVal ? settingChoice(settings.rawVal.saved, "hubAddress") : "Unconfirmed"}.`;
}

async function saveSelection() {
  scanMessage.val = "";
  if (
    await settingsAction("hub", "/settings/hub", "POST", {
      revision: selectionRevision.rawVal,
      address: selected.rawVal,
    })
  ) {
    selected.val = "";
    candidates.val = [];
  }
}
