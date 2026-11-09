// @ts-check
import van from "../vendor/van-1.6.1.js";
import { readPhoneValue, writePhoneValue } from "./phone-storage.js";
import { request } from "./transport.js";
import { BLE_MODE, onBleStatus, storedSecret } from "./ble-link.js";
import { connection } from "./store.js";
import { armed } from "./arming.js";
import { destination } from "./destination.js";
import { peekTab } from "./router.js";

/** @typedef {import("../../src/settings/view.ts").SettingsReply} SettingsReply */
/** @typedef {import("../../src/settings/view.ts").SettingsActionReply} SettingsActionReply */
/** @typedef {import("../../src/settings/schema.ts").StartupSettings} StartupSettings */
export const settings = van.state(/** @type {SettingsReply | null} */ (null));
export const settingsInstance = van.derive(() => settings.val?.instanceId ?? "");
export const settingsReady = van.derive(() => settings.val !== null);
export const settingsError = van.state("");
export const settingsMessages = van.state(/** @type {Record<string, string>} */ ({}));
export const settingsBusy = van.state("");
export const settingsConfirmed = van.state(false);
let connectionEpoch = 0;
let refreshing = false;
/** @type {number | null} */
let editingRevision = null;
/** @type {Map<string, { value: import("../vendor/van-1.6.1.js").State<string>, dirty: boolean, revision: number | null }>} */
const drafts = new Map();
const draftChanges = van.state(0);

export async function refreshSettings() {
  if (refreshing) return;
  refreshing = true;
  const epoch = connectionEpoch;
  try {
    const reply = await request("/settings", { cache: "no-store" });
    if (epoch !== connectionEpoch) return;
    if (!reply.ok) {
      settingsError.val =
        reply.status === 404
          ? "This Pi has no settings API yet. Update the Pi software to use dashboard settings."
          : "Settings could not be confirmed. Reconnect before saving.";
      return;
    }
    const body = /** @type {SettingsReply} */ (await reply.json());
    if (epoch !== connectionEpoch) return;
    acceptSettings(body);
    settingsConfirmed.val = true;
    settingsError.val = "";
  } catch (error) {
    console.warn("settings: could not refresh", error);
    if (epoch !== connectionEpoch) return;
    settingsError.val = "Settings are unconfirmed while this Pi is unreachable. Reconnect before saving.";
  } finally {
    refreshing = false;
    if (epoch !== connectionEpoch && connection.rawVal === "live") {
      setTimeout(() => {
        void refreshSettings();
      }, 0);
    }
  }
}

/** @param {SettingsReply} reply */
export function acceptSettings(reply) {
  const previous = settings.rawVal;
  if (previous?.processGeneration === reply.processGeneration && (previous.revision ?? -1) > (reply.revision ?? -1))
    return;
  if (previous && previous.processGeneration !== reply.processGeneration) {
    settingsMessages.val = { restart: "Reconnected. Active settings confirmed below." };
  }
  if (previous && (previous.processGeneration !== reply.processGeneration || previous.revision !== reply.revision)) {
    armed.val = "";
  }
  if (previous?.instanceId !== reply.instanceId) {
    drafts.clear();
    editingRevision = null;
    settingsMessages.val = {};
  }
  settings.val = reply;
  for (const [id, draft] of drafts) {
    if (!draft.dirty && id.startsWith(`${reply.instanceId}:`)) {
      const key = id.slice(id.lastIndexOf(":") + 1);
      if (Object.hasOwn(reply.saved, key)) {
        draft.value.val = String(reply.saved[/** @type {keyof SettingsReply["saved"]} */ (key)]);
        draft.revision = reply.revision;
      }
    }
  }
}

/** @param {string} key @param {string} initial */
export function settingDraft(key, initial) {
  const id = `${settings.rawVal?.instanceId ?? "unconfirmed"}:${key}`;
  let draft = drafts.get(id);
  if (!draft) {
    draft = { value: van.state(initial), dirty: false, revision: settings.rawVal?.revision ?? null };
    drafts.set(id, draft);
  }
  return draft.value;
}

/** @param {string} key @param {string} value */
export function editSetting(key, value) {
  const id = `${settings.rawVal?.instanceId ?? "unconfirmed"}:${key}`;
  const draft = drafts.get(id);
  if (!draft) return;
  if (editingRevision === null) {
    editingRevision = settings.rawVal?.revision ?? null;
  }
  if (!draft.dirty) {
    draft.revision = settings.rawVal?.revision ?? null;
  }
  draft.dirty = true;
  draft.value.val = value;
  draftChanges.val += 1;
  settingsMessages.val = { ...settingsMessages.rawVal, [key]: "" };
  armed.val = "";
}

/** @param {string} key @param {Partial<StartupSettings>} changes */
export async function saveSetting(key, changes) {
  const draft = drafts.get(`${settings.rawVal?.instanceId ?? "unconfirmed"}:${key}`);
  const saved = await settingsAction(key, "/settings", "PATCH", {
    revision: draft?.dirty ? draft.revision : settings.rawVal?.revision,
    changes,
  });
  if (!saved || !settingsMessages.rawVal[key]?.startsWith("Saved.")) return;
  editingRevision = null;
  if (draft) {
    draft.dirty = false;
    draft.revision = settings.rawVal?.revision ?? null;
    draftChanges.val += 1;
  }
}

/** @param {string} key @param {string} path @param {string} method @param {Record<string, unknown>} body */
export async function settingsAction(key, path, method, body) {
  if (!settingsConfirmed.rawVal || settingsError.rawVal) {
    settingsMessages.val = { ...settingsMessages.rawVal, [key]: "Reconnect and confirm this Pi before saving." };
    return false;
  }
  const epoch = connectionEpoch;
  const source = settings.rawVal;
  settingsBusy.val = key;
  settingsMessages.val = { ...settingsMessages.rawVal, [key]: "Working…" };
  try {
    const response = await request(path, {
      method,
      headers: { "X-Cool-Eva": path === "/update" ? "update" : "settings", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const reply = /** @type {SettingsActionReply} */ (await response.json());
    if (
      epoch !== connectionEpoch ||
      settings.rawVal?.instanceId !== source?.instanceId ||
      settings.rawVal?.processGeneration !== source?.processGeneration
    )
      return false;
    if (reply.settings) {
      acceptSettings(reply.settings);
    }
    settingsMessages.val = { ...settingsMessages.rawVal, [key]: reply.message };
    if (!reply.ok) return false;
    return true;
  } catch (error) {
    if (
      epoch !== connectionEpoch ||
      settings.rawVal?.instanceId !== source?.instanceId ||
      settings.rawVal?.processGeneration !== source?.processGeneration
    ) {
      console.warn("settings: the previous connection's action could not be confirmed", error);
      return false;
    }
    console.warn("settings: action outcome unknown", error);
    settingsError.val = "Reconnect and read settings before saving again.";
    settingsMessages.val = {
      ...settingsMessages.rawVal,
      [key]: "No confirmed reply. Reconnect and read settings before trying again.",
    };
    return false;
  } finally {
    settingsBusy.val = "";
  }
}

export function restartRequest() {
  const current = settings.rawVal;
  if (BLE_MODE && settingsConfirmed.rawVal && current?.active.bluetoothCodeId && storedSecret()) {
    writePhoneValue(`cool-eva.active-code:${current.active.bluetoothCodeId}`, storedSecret());
  }
  const cached = current?.saved.bluetoothCodeId
    ? readPhoneValue(`cool-eva.pending-code:${current.saved.bluetoothCodeId}`)
    : null;
  return {
    expectedGeneration: current?.processGeneration,
    revision: current?.revision,
    bluetoothCodeId: cached ? current?.saved.bluetoothCodeId : null,
  };
}

export function watchSettings() {
  let wasLive = false;
  van.derive(() => {
    const live = connection.val === "live";
    if (live !== wasLive) {
      invalidateConnection();
      wasLive = live;
      if (live) {
        void refreshSettings();
      }
    }
  });
  if (BLE_MODE) {
    onBleStatus(status => {
      if (status !== "connected") {
        invalidateConnection();
      } else {
        void refreshSettings();
      }
    });
  }
  void refreshSettings();
  setInterval(() => {
    if (
      (destination.rawVal === "settings" || (!destination.rawVal && peekTab() === "more")) &&
      connection.rawVal === "live"
    ) {
      void refreshSettings();
    }
  }, 2_500);
}

function invalidateConnection() {
  connectionEpoch += 1;
  settingsConfirmed.val = false;
  settingsError.val = "Settings are unconfirmed. Reconnect and read this Pi before saving.";
  armed.val = "";
}

/** @param {string} key */
export function settingIsDirty(key) {
  draftChanges.val;
  const draft = drafts.get(`${settings.val?.instanceId ?? "unconfirmed"}:${key}`);
  if (!draft) return false;
  draft.value.val;
  return draft.dirty;
}
/** @param {string} key */
export function discardSetting(key) {
  const current = settings.rawVal;
  const draft = drafts.get(`${current?.instanceId ?? "unconfirmed"}:${key}`);
  if (!current || !draft) return;
  draft.dirty = false;
  draft.revision = current.revision;
  const saved = Object.hasOwn(current.saved, key)
    ? current.saved[/** @type {keyof SettingsReply["saved"]} */ (key)]
    : "";
  draft.value.val = String(saved);
  draftChanges.val += 1;
  armed.val = "";
  settingsMessages.val = { ...settingsMessages.rawVal, [key]: "Unsaved edit discarded." };
}
