// @ts-check
import van from "../vendor/van-1.6.1.js";
import { request } from "./transport.js";
import { settings, settingsConfirmed } from "./settings.js";
import { destination, destinationSection } from "./destination.js";
import { connection } from "./store.js";
import { armed } from "./arming.js";
import { validNetworkPassword } from "./network-input.js";
import { networkRecoveryIncomplete } from "./network-recovery.js";

/** @typedef {import("../../src/wifi/network-types.ts").NetworkView} NetworkView */
/** @typedef {import("../../src/wifi/network-types.ts").NetworkDraft} NetworkDraft */
/** @typedef {import("../../src/wifi/network-types.ts").NetworkProfile} NetworkProfile */
/** @typedef {import("../../src/wifi/network-types.ts").NetworkRequestIdentity} NetworkIdentity */
/** @typedef {{ identity: NetworkIdentity, ssid: import("../vendor/van-1.6.1.js").State<string>, purpose: import("../vendor/van-1.6.1.js").State<string>, replacedUuid: string | null, passwordMode: import("../vendor/van-1.6.1.js").State<string>, password: import("../vendor/van-1.6.1.js").State<string>, shown: import("../vendor/van-1.6.1.js").State<boolean>, hidden: import("../vendor/van-1.6.1.js").State<boolean>, accessPointChange: import("../vendor/van-1.6.1.js").State<boolean> }} NetworkEditorDraft */

export const networks = van.state(/** @type {NetworkView | null} */ (null));
export const networkError = van.state("");
export const networkMessage = van.state("");
export const networkBusy = van.state(false);
export const networkConfirmed = van.state(false);
export const networkDraft = van.state(/** @type {NetworkEditorDraft | null} */ (null));
let refreshing = false;
let epoch = 0;

export async function refreshNetworks() {
  if (refreshing || !settingsConfirmed.rawVal) return;
  refreshing = true;
  const currentEpoch = epoch;
  const instance = settings.rawVal?.instanceId;
  try {
    const response = await request("/settings/networks", { cache: "no-store" });
    const reply = /** @type {NetworkView} */ (await response.json());
    if (currentEpoch !== epoch || instance !== settings.rawVal?.instanceId) return;
    if (!response.ok || !reply.ok) {
      networkError.val = reply.message;
      networkConfirmed.val = false;
      return;
    }
    if (reply.instanceId !== instance) {
      networkError.val = "This reply belongs to another Pi. Reconnect before changing networks.";
      return;
    }
    if (reply.generation !== settings.rawVal?.processGeneration) {
      networkConfirmed.val = false;
      networkError.val = "Network result unconfirmed. Read this Pi's new process before changing networks.";
      armed.val = "";
      return;
    }
    const previous = networks.rawVal;
    if (
      networkRecoveryIncomplete(reply) &&
      (!previous ||
        !networkRecoveryIncomplete(previous) ||
        previous.generation !== reply.generation ||
        previous.change?.uuid !== reply.change?.uuid)
    ) {
      networkMessage.val = "";
    }
    if (
      previous &&
      (previous.generation !== reply.generation ||
        previous.revision !== reply.revision ||
        previous.settingsRevision !== reply.settingsRevision ||
        previous.change?.uuid !== reply.change?.uuid ||
        previous.change?.phase !== reply.change?.phase)
    ) {
      armed.val = "";
    }
    networks.val = reply;
    networkConfirmed.val = true;
    networkError.val = "";
  } catch {
    networkConfirmed.val = false;
    networkError.val = "Lost contact with Cool Eva. Network result unconfirmed.";
    armed.val = "";
  } finally {
    refreshing = false;
  }
}

/** @param {NetworkProfile | null} [profile] */
export function editNetwork(profile = null) {
  const current = networks.rawVal;
  if (!current || !networkConfirmed.rawVal) return;
  cancelNetworkDraft();
  networkDraft.val = {
    identity: identityOf(current),
    ssid: van.state(profile?.ssid ?? ""),
    purpose: van.state(current.profiles.find(saved => saved.uuid === profile?.uuid)?.purpose ?? "home"),
    replacedUuid: profile?.uuid ?? null,
    passwordMode: van.state(profile ? "keep" : "change"),
    password: van.state(""),
    shown: van.state(false),
    hidden: van.state(false),
    accessPointChange: van.state(!!profile),
  };
  networkMessage.val = "";
}

export function cancelNetworkDraft() {
  if (networkDraft.rawVal) {
    networkDraft.rawVal.password.val = "";
    networkDraft.rawVal.shown.val = false;
  }
  networkDraft.val = null;
  armed.val = "";
}

export function editSavedNetworkChange() {
  const change = networks.rawVal?.change;
  if (!change) return;
  editNetwork(change.replaced);
  const draft = networkDraft.rawVal;
  if (draft) {
    draft.ssid.val = change.ssid;
    draft.purpose.val = change.purpose;
    draft.passwordMode.val = "change";
    networkMessage.val =
      "Enter the password again when editing details. Try again uses the saved candidate without retyping.";
  }
}

export async function saveNetwork() {
  const draft = networkDraft.rawVal;
  if (!draft) return;
  const submission = /** @type {NetworkDraft} */ ({
    ssid: draft.ssid.rawVal,
    purpose: draft.purpose.rawVal,
    replacedUuid: draft.replacedUuid,
    passwordMode: draft.passwordMode.rawVal,
    password: draft.password.rawVal,
    hidden: draft.hidden.rawVal,
    accessPointChange: draft.accessPointChange.rawVal,
    bluetoothTested: !!networks.rawVal?.viaBluetooth,
  });
  if (submission.passwordMode === "change" && !validNetworkPassword(submission.password)) {
    networkMessage.val = "Enter a password of 8–63 ASCII characters or 64 hexadecimal digits.";
    return;
  }
  const saveEpoch = epoch;
  let warning = "";
  networkBusy.val = true;
  try {
    const response = await request("/settings/networks/scan", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify(identityOf(networks.rawVal)),
    });
    const scan = /** @type {{ ok: boolean, names?: string[] }} */ (await response.json());
    warning =
      !response.ok || !scan.ok
        ? "Network scan unavailable. The name has not been checked. "
        : scan.names?.includes(submission.ssid)
          ? ""
          : "Network name not seen. Check the name; hidden networks may not appear. ";
  } catch {
    warning = "Network scan unavailable. The name has not been checked. ";
  }
  networkBusy.val = false;
  if (epoch !== saveEpoch || networkDraft.rawVal !== draft) return;
  if (await networkAction("/settings/networks/save", { ...draft.identity, draft: submission })) {
    cancelNetworkDraft();
    networkMessage.val = `${warning}Saved. Ready to try.`;
  }
}

export function tryNetwork() {
  return networkAction("/settings/networks/trial");
}
export function keepNetwork() {
  return networkAction("/settings/networks/keep");
}
export function usePreviousNetwork() {
  return networkAction("/settings/networks/previous");
}
export function cancelNetworkChange() {
  return networkAction("/settings/networks/cancel");
}

/** @param {string} path @param {Record<string, unknown>} [body] */
async function networkAction(path, body) {
  if (!networkConfirmed.rawVal || networkBusy.rawVal || !networks.rawVal) return false;
  const identity = identityOf(networks.rawVal);
  const currentEpoch = epoch;
  networkBusy.val = true;
  armed.val = "";
  try {
    const response = await request(path, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify(body ?? identity),
    });
    const reply = /** @type {NetworkView} */ (await response.json());
    if (currentEpoch !== epoch || identity.instanceId !== settings.rawVal?.instanceId) return false;
    if (!response.ok || !reply.ok) {
      networkMessage.val = reply.message;
      networkError.val = reply.message;
      networkConfirmed.val = false;
      return false;
    }
    if (reply.generation !== settings.rawVal?.processGeneration) {
      networkConfirmed.val = false;
      networkError.val = "Network result unconfirmed. Read this Pi's new process before changing networks.";
      return false;
    }
    networks.val = reply;
    networkMessage.val = reply.change?.message ?? "Network change cancelled.";
    return true;
  } catch {
    networkConfirmed.val = false;
    networkError.val = "Lost contact with Cool Eva. Network result unconfirmed.";
    networkMessage.val = "No confirmed reply. Reconnect and read this Pi before trying again.";
    return false;
  } finally {
    networkBusy.val = false;
  }
}

/** @param {NetworkView | null} current @returns {NetworkIdentity} */
function identityOf(current) {
  if (!current) {
    throw new Error("Read this Pi's networks first.");
  }
  return {
    instanceId: current.instanceId,
    generation: current.generation,
    revision: current.revision,
    settingsRevision: current.settingsRevision,
  };
}

const HEADERS = { "X-Cool-Eva": "settings", "Content-Type": "application/json" };
let currentInstance = "";
let currentDestination = "";
van.derive(() => {
  const instance = settings.val?.instanceId ?? "";
  const route = `${destination.val}:${destinationSection.val}`;
  const live = connection.val === "live" && settingsConfirmed.val;
  if (instance !== currentInstance) {
    epoch += 1;
    currentInstance = instance;
    cancelNetworkDraft();
    networks.val = null;
    networkConfirmed.val = false;
  }
  if (!live) {
    epoch += 1;
    networkConfirmed.val = false;
    armed.val = "";
  }
  if (route !== currentDestination) {
    currentDestination = route;
    armed.val = "";
    if (networkDraft.rawVal) {
      networkDraft.rawVal.shown.val = false;
    }
  }
  if (route === "settings:networks" && live) {
    void refreshNetworks();
  }
});
setInterval(() => {
  const current = networks.rawVal;
  const terminal = ["failed", "restored", "kept"].includes(current?.change?.phase ?? "");
  if (
    destination.rawVal === "settings" &&
    destinationSection.rawVal === "networks" &&
    (!networkConfirmed.rawVal || !terminal || current?.observingRestoration)
  ) {
    void refreshNetworks();
  }
}, 1_500);
