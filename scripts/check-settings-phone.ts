import assert from "assert/strict";
import {
  acceptSettings,
  settings,
  settingDraft,
  editSetting,
  saveSetting,
  settingsConfirmed,
  settingsMessages,
  discardSetting,
  settingsAction,
} from "../public/lib/settings.js";
import { armed, arm } from "../public/lib/arming.js";
import type { SettingsReply, SettingsActionReply } from "../src/settings/view.ts";
import { settingsStateLines, pendingChoiceDescriptions } from "../public/lib/settings-state.js";
import { retiredLegacyChoices } from "../src/settings/legacy.ts";
import { requireCurrentPage, pageReloadRequired } from "../public/lib/page-reload.js";
import { request } from "../public/lib/transport.js";
import { csrfRefusal } from "../src/http/mutation-guard.ts";

const first: SettingsReply = {
  ok: true,
  source: "legacy",
  version: "Synthetic",
  recordingFingerprint: null,
  processGeneration: "synthetic-generation-one",
  instanceId: "synthetic-pi-one",
  revision: 0,
  hotspotNameOwnership: "manual",
  saved: {
    coolantProbesEnabled: false,
    radiatorFanEnabled: false,
    customBmsConfigurationFlashed: false,
    automaticDcChargingEnabled: true,
    phoneHotspotSsid: "",
    rideLogDirectory: "/synthetic/ride-logs",
    vcuParameterDirectory: "/synthetic/vcu-params",
    hubAddress: null,
    discoverHubOnce: true,
    recordingKeyConfigured: false,
    bluetoothCodeId: null,
  },
  active: {
    coolantProbesEnabled: false,
    radiatorFanEnabled: false,
    customBmsConfigurationFlashed: false,
    automaticDcChargingEnabled: true,
    phoneHotspotSsid: "",
    rideLogDirectory: "/synthetic/ride-logs",
    vcuParameterDirectory: "/synthetic/vcu-params",
    hubAddress: null,
    discoverHubOnce: true,
    recordingKeyConfigured: false,
    bluetoothCodeId: null,
  },
  pending: [],
  fault: null,
  notices: ["coolant-default-off"],
  readiness: {
    coolant: "Off",
    fan: "Off",
    recording: "Not configured",
    bluetooth: "Off",
    hub: "Not selected",
    can: "Starting",
  },
  restart: { state: "idle", message: "" },
  locations: { root: "/synthetic", wifi: "/synthetic/wifi-diag", captures: "/synthetic/captures" },
};
acceptSettings(structuredClone(first));
const pendingChoice = structuredClone(first);
pendingChoice.active.automaticDcChargingEnabled = false;
pendingChoice.pending = ["automaticDcChargingEnabled"];
assert.deepEqual(settingsStateLines(pendingChoice, true, "automaticDcChargingEnabled", true), [
  "Draft — not saved.",
  "Saved for next start: On.",
  "Active now: Off.",
]);
assert.deepEqual(pendingChoiceDescriptions(pendingChoice), ["Automatic current reduction: On"]);
assert.match(
  settingsStateLines(pendingChoice, false, "automaticDcChargingEnabled", true).join(" "),
  /Pi unconfirmed.*Last confirmed saved: On.*Active at last contact: Off/
);
assert.equal(settingsStateLines(null, false, "automaticDcChargingEnabled", false).join(" ").includes("Off"), false);
const unreadable = structuredClone(first);
unreadable.ok = false;
assert.deepEqual(settingsStateLines(unreadable, true, "coolantProbesEnabled", false), [
  "Saved choice unreadable. The original document is retained.",
  "Active safe default: Off.",
]);
assert.deepEqual(retiredLegacyChoices(["retired:WIFI_IFACE", "retired:OBD_ENABLED", "retired:WIFI_IFACE"]), [
  { name: "WIFI_IFACE", behavior: "Wi-Fi monitoring and recovery now use wlan0." },
  { name: "OBD_ENABLED", behavior: "OBD polling is now always enabled." },
]);
await assert.rejects(
  requireCurrentPage({ status: 403, json: async () => csrfRefusal("Reload the page.") }),
  /Reload the page/
);
assert.equal(pageReloadRequired.rawVal, true);
pageReloadRequired.val = false;
await checkReloadRefusals();
const coolant = settingDraft("coolantProbesEnabled", "false");
settingsMessages.val = { coolantProbesEnabled: "Saved. Applies after restart." };
editSetting("coolantProbesEnabled", "true");
assert.equal(settingsMessages.rawVal.coolantProbesEnabled, "", "Editing again clears the old save-success claim.");
const otherPhone = structuredClone(first);
otherPhone.revision = 1;
otherPhone.saved.automaticDcChargingEnabled = false;
arm("settings-restart:apply");
acceptSettings(otherPhone);
assert.equal(armed.rawVal, "");
assert.equal(coolant.rawVal, "true");
let requests = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (_input, init) => {
  requests += 1;
  const body = JSON.parse(String(init?.body));
  assert.equal(body.revision, 0, "An open dirty edit must retain the revision it was based on.");
  const reply: SettingsActionReply = { ok: false, message: "Settings changed. Reload before saving." };
  return new Response(JSON.stringify(reply), { status: 409, headers: { "Content-Type": "application/json" } });
};
try {
  settingsConfirmed.val = true;
  await saveSetting("coolantProbesEnabled", { coolantProbesEnabled: true });
  assert.equal(requests, 1);
  assert.match(settingsMessages.rawVal.coolantProbesEnabled, /Settings changed/);
  assert.equal(coolant.rawVal, "true");
  discardSetting("coolantProbesEnabled");
  assert.equal(coolant.rawVal, "false");
  const clean = settingDraft("automaticDcChargingEnabled", "false");
  const newer = structuredClone(otherPhone);
  newer.revision = 2;
  newer.saved.automaticDcChargingEnabled = true;
  acceptSettings(newer);
  assert.equal(clean.rawVal, "true", "Unedited controls follow confirmed server values.");
  acceptSettings(otherPhone);
  assert.equal(settings.rawVal?.revision, 2, "A late GET cannot rewind the same process revision.");
  const pinned = structuredClone(newer);
  pinned.saved.hubAddress = "02:00:00:00:00:01";
  pinned.active.hubAddress = "02:00:00:00:00:01";
  arm("settings-restart:apply");
  acceptSettings(pinned);
  assert.equal(armed.rawVal, "settings-restart:apply", "A learned hub must not disarm apply.");
  const restarted = structuredClone(pinned);
  restarted.processGeneration = "synthetic-generation-two";
  acceptSettings(restarted);
  assert.equal(armed.rawVal, "");
  settingsConfirmed.val = false;
  await saveSetting("coolantProbesEnabled", { coolantProbesEnabled: true });
  assert.equal(requests, 1, "No settings write can leave an unconfirmed connection.");
  const differentPi = structuredClone(first);
  differentPi.instanceId = "synthetic-pi-two";
  acceptSettings(differentPi);
  assert.equal(
    settingDraft("coolantProbesEnabled", "false").rawVal,
    "false",
    "Drafts from another Pi must not be replayed."
  );
  for (const changedIdentity of ["instanceId", "processGeneration"] as const) {
    const original: SettingsReply = structuredClone(settings.rawVal!);
    let completeReply: (response: Response) => void = () => {
      throw new Error("The action has not started.");
    };
    globalThis.fetch = () =>
      new Promise<Response>(resolve => {
        completeReply = resolve;
      });
    settingsConfirmed.val = true;
    const pendingAction = settingsAction("late-reply", "/settings", "PATCH", {
      revision: original.revision,
      changes: {},
    });
    const current: SettingsReply = structuredClone(original);
    current[changedIdentity] = `${original[changedIdentity]}-reconnected`;
    acceptSettings(current);
    completeReply(
      new Response(JSON.stringify({ ok: true, message: "Saved. Applies after restart.", settings: original }))
    );
    assert.equal(
      await pendingAction,
      false,
      "A reply from the previous Pi or process cannot confirm a current action."
    );
    assert.equal(
      settings.rawVal?.[changedIdentity],
      current[changedIdentity],
      "A late action cannot rewind confirmed identity."
    );
  }
} finally {
  globalThis.fetch = originalFetch;
}
console.log(
  "settings phone checks passed: dirty edits survive readback, stale revisions and unknown connections cannot save, learned hubs keep arming, generation/choice changes disarm, and drafts stay with their Pi"
);

async function checkReloadRefusals(): Promise<void> {
  const originalFetch = globalThis.fetch;
  try {
    const message = "Service data is unavailable. Resolve the Settings fault before reading.";
    for (const path of ["/lifetime-read", "/freeze-frame-read", "/vcu-probe", "/vcu-read"]) {
      const payload = { message };
      globalThis.fetch = async () => new Response(JSON.stringify(payload), { status: 403 });
      const response = await request(path, { method: "POST", headers: { "X-Cool-Eva": "service-mode" } });
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), payload, `${path} must retain its real refusal and readable body.`);
      assert.equal(pageReloadRequired.rawVal, false, `${path} needs settings repair, not a page reload.`);
    }
    globalThis.fetch = async () => new Response("Read permission is unavailable.", { status: 403 });
    const plain = await request("/synthetic-refusal");
    assert.equal(await plain.text(), "Read permission is unavailable.");
    assert.equal(pageReloadRequired.rawVal, false);
    for (const csrfRefusal of [false, "true"]) {
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ csrfRefusal, message: "Reload the page" }), { status: 403 });
      assert.equal((await request("/synthetic-refusal")).status, 403);
      assert.equal(pageReloadRequired.rawVal, false, "Only the explicit guard marker triggers a reload.");
    }
    globalThis.fetch = async () => new Response(JSON.stringify(csrfRefusal("Reload the page.")), { status: 403 });
    await assert.rejects(request("/settings", { method: "PATCH" }), /Reload the page/);
    assert.equal(pageReloadRequired.rawVal, true);
  } finally {
    pageReloadRequired.val = false;
    globalThis.fetch = originalFetch;
  }
  console.log("  only marked CSRF refusals request reload; all four service-data 403s retain their repair message");
}
