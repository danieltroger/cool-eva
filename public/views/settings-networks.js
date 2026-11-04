// @ts-check
import van from "../vendor/van-1.6.1.js";
import { openDestination } from "../lib/destination.js";
import {
  networks,
  networkError,
  networkMessage,
  networkBusy,
  networkConfirmed,
  networkDraft,
  refreshNetworks,
  editNetwork,
  editSavedNetworkChange,
  tryNetwork,
  keepNetwork,
  usePreviousNetwork,
  cancelNetworkChange,
} from "../lib/networks.js";
import { arm, armed, armDwellElapsed, refuseKeyRepeat } from "../lib/arming.js";
import { SettingsCard } from "./settings-fields.js";
import { NetworkEditor } from "./settings-network-editor.js";
import { SettingsRestart } from "./settings-restart.js";

const { a, button, div, h2 } = van.tags;

export function WifiNetworksView() {
  return div(
    h2("Wi-Fi networks"),
    () =>
      !networkConfirmed.val
        ? SettingsCard(
            "Network result unconfirmed",
            networkError.val || "Lost contact with Cool Eva. Network result unconfirmed.",
            div(
              { class: "settings-note" },
              "Last confirmed details below. Reconnect and read this Pi before confirming or trying again."
            ),
            Actions(button({ class: "settings-button", onclick: () => void refreshNetworks() }, "Read again"))
          )
        : div(),
    () => (networkDraft.val ? NetworkEditor(networkDraft.val) : div()),
    () => (networks.val?.message ? SettingsCard("Wi-Fi change needs attention", networks.val.message) : div()),
    () => NetworkStatus(),
    () =>
      ["confirming", "promoting", "identity", "retiring"].includes(networks.val?.change?.phase ?? "")
        ? SettingsRestart()
        : div(),
    () =>
      SettingsCard(
        networkConfirmed.val ? "Current connection" : "Connection at last contact",
        networks.val?.active
          ? `Pi joined ${profileName(networks.val.active.uuid)}. Address: http://${networks.val.active.address}`
          : "No Wi-Fi connection confirmed.",
        div(
          { class: "settings-note" },
          "Save does not switch Wi-Fi. Only an armed trial can try a saved candidate; restarting does not try it."
        ),
        Actions(
          button(
            {
              class: "settings-button",
              disabled: () =>
                !networkConfirmed.val || networkBusy.val || !!networkDraft.val || networkOperationActive(),
              onclick: () => editNetwork(),
            },
            "Add"
          )
        )
      ),
    () =>
      div(
        ...(networks.val?.profiles ?? []).map(profile =>
          SettingsCard(
            profile.ssid,
            `${profile.uuid === networks.val?.active?.uuid ? "Connected" : "Saved"} · ${profile.purpose === "hotspot" ? "Phone hotspot" : profile.purpose === "home" ? "Home Wi-Fi" : "Purpose not set"}`,
            div({ class: "settings-note" }, `Saved profile: ${profile.name}`),
            Actions(
              button(
                {
                  class: "settings-button",
                  disabled: () =>
                    !networkConfirmed.val || networkBusy.val || !!networkDraft.val || networkOperationActive(),
                  onclick: () => editNetwork(profile),
                },
                "Change"
              )
            )
          )
        )
      ),
    () => div({ class: "settings-note", role: "status" }, networkMessage.val),
    NetworkRecoveryHelp()
  );
}

function NetworkStatus() {
  const current = networks.val;
  const change = current?.change;
  if (!change) return div();
  const live = ["trying", "waiting"].includes(change.phase);
  const previousSaved = current.profiles.some(profile => profile.uuid === change.fallback?.uuid);
  return SettingsCard(
    change.phase === "saved" ? "Saved network change" : "Network change",
    `${change.phase === "kept" ? "Kept network" : "Candidate"}: ${change.ssid}. ${change.replaced ? `${change.phase === "kept" ? "Replaced" : "Replaces"} ${change.replaced.ssid}.` : "Adds a network; other saved networks stay."}`,
    div(
      { class: "settings-note" },
      change.fallback
        ? !networkConfirmed.val
          ? `At last contact, the previous profile was ${change.fallback.ssid}.`
          : previousSaved
            ? `Previous connection: ${change.fallback.ssid} remains saved.`
            : change.phase === "kept" && change.replaced?.uuid === change.fallback.uuid
              ? `The previous ${change.fallback.ssid} profile was replaced.`
              : `The previous ${change.fallback.ssid} profile is not listed. Read back or use repair help.`
        : "No previous Wi-Fi connection is saved for this trial."
    ),
    div(
      { class: "settings-note", role: "status" },
      !networkConfirmed.val
        ? "Lost contact with Cool Eva. Network result unconfirmed."
        : current.canKeep
          ? `This phone reached ${change.ssid} over Wi-Fi. Keep network to finish.`
          : change.message
    ),
    live && networkConfirmed.val && current.remainingMs !== null
      ? div({ class: "settings-note" }, `${Math.ceil(current.remainingMs / 1000)} seconds remain in this trial.`)
      : div(),
    change.phase === "waiting" && current.active?.uuid === change.uuid
      ? div(
          div(
            { class: "settings-note" },
            current.canKeep
              ? `Pi address: http://${current.active.address}. ${change.replaced ? `Keeping it replaces ${change.replaced.ssid}.` : "Keeping it adds this network."} Other saved networks stay.`
              : `If this phone hosts the hotspot, open the address below directly. Otherwise join ${change.ssid}, then open it.`
          ),
          a(
            {
              class: "settings-link",
              href: `http://${current.active.address}/?panel=settings&section=networks`,
              target: "_blank",
              rel: "noopener",
            },
            `Open Cool Eva at ${current.active.address}`
          ),
          div(
            { class: "settings-note" },
            "Opening the address must work over the new Wi-Fi. Bluetooth contact alone cannot keep it. If the hotspot host cannot reach the Pi, use a second client on that hotspot."
          )
        )
      : div(),
    change.phase === "failed"
      ? div(
          { class: "settings-note" },
          "If you changed this phone’s hotspot, restore its previous name and password. Use the Bluetooth dashboard to edit or try again. For a changed router, restore its previous settings or use another saved network."
        )
      : div(),
    Actions(
      ...(["saved", "failed", "restored"].includes(change.phase)
        ? [
            button(
              {
                class: "settings-button",
                disabled: () => !networkConfirmed.val || networkBusy.val,
                onclick: editSavedNetworkChange,
              },
              change.phase === "saved" ? "Edit details" : "Edit"
            ),
          ]
        : []),
      ...(["saved", "failed", "restored"].includes(change.phase)
        ? [TrialButton(change.phase === "saved" ? "Try network" : "Try again")]
        : []),
      ...(change.phase === "saved" ? [Action("Cancel change", cancelNetworkChange)] : []),
      ...(["failed", "restored"].includes(change.phase) ? [Action("Dismiss", cancelNetworkChange)] : []),
      ...(["failed", "restored", "kept"].includes(change.phase)
        ? [
            Action("Read again", async () => {
              await refreshNetworks();
              return true;
            }),
          ]
        : []),
      ...(live || (current.message && networkOperationActive()) ? [Action("Use previous", usePreviousNetwork)] : []),
      ...(change.phase === "waiting" && current.canKeep ? [Action("Keep network", keepNetwork)] : [])
    )
  );
}

/** @param {string} caption */
function TrialButton(caption) {
  const key = `wifi-trial:${networks.rawVal?.change?.uuid}:${networks.rawVal?.revision}`;
  return button(
    {
      class: "settings-button",
      disabled: () => !networkConfirmed.val || networkBusy.val || !!networkDraft.val || networkOperationActive(),
      onkeydown: refuseKeyRepeat,
      onclick: () => {
        if (armed.val !== key) {
          arm(key);
          return;
        }
        if (!armDwellElapsed()) return;
        armed.val = "";
        void tryNetwork();
      },
    },
    () => (armed.val === key ? "Confirm trial" : caption)
  );
}

/** @param {string} caption @param {() => Promise<boolean>} action */
function Action(caption, action) {
  return button(
    {
      class: "settings-button",
      disabled: () => !networkConfirmed.val || networkBusy.val,
      onclick: () => void action(),
    },
    caption
  );
}
/** @param {...HTMLElement} children */
function Actions(...children) {
  return div({ class: "settings-actions" }, ...children);
}
/** @param {string} uuid */
function profileName(uuid) {
  const current = networks.rawVal;
  if (current?.change?.uuid === uuid) return current.change.ssid;
  if (current?.change?.replaced?.uuid === uuid) return current.change.replaced.ssid;
  if (current?.change?.fallback?.uuid === uuid) return current.change.fallback.ssid;
  return current?.profiles.find(profile => profile.uuid === uuid)?.ssid ?? "an unlisted network";
}

function NetworkRecoveryHelp() {
  return SettingsCard(
    "Before changing a hotspot or router",
    "First test the Bluetooth dashboard against this Pi, or keep another saved network reachable while you set up Bluetooth. Activate any new Bluetooth key before saving network details.",
    div(
      { class: "settings-note" },
      "Save the replacement details in the Bluetooth dashboard. Keep the previous hotspot/router settings for recovery. Then change the access point, reconnect and read back over Bluetooth, and arm Try network. Confirm only after opening Cool Eva over the new Wi-Fi."
    ),
    div(
      { class: "settings-note" },
      "Already changed the phone or router? Reconnect over the tested Bluetooth link and enter/save the details there. A draft in an old Wi-Fi tab must be re-entered; passwords are never carried in links or browser storage."
    ),
    div(
      { class: "settings-note" },
      "If this hotspot change fails: restore your hotspot's previous name and password. Use previous only attempts the old connection; it cannot change settings on your phone or router."
    ),
    div(
      { class: "settings-note" },
      "If Bluetooth is unavailable, restore the old access-point settings or use an already configured reachable network first. Installation repair needs a reachable link; total loss may require card repair. There is no recovery access point."
    ),
    a(
      {
        class: "settings-link",
        href: "https://github.com/danieltroger/cool-eva/blob/main/INSTALL.md",
        target: "_blank",
        rel: "noopener",
      },
      "Installation / repair guide →"
    ),
    Actions(
      button({ class: "settings-button", onclick: () => openDestination("settings", "connections") }, "Bluetooth setup")
    )
  );
}

function networkOperationActive() {
  return ["trying", "waiting", "restoring", "confirming", "promoting", "identity", "retiring"].includes(
    networks.val?.change?.phase ?? ""
  );
}
