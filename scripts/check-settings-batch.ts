import assert from "node:assert/strict";
import {
  acceptSettings,
  settings,
  settingsConfirmed,
  settingsError,
  settingsMessages,
} from "../public/lib/settings.js";
import type { SettingsReply } from "../src/settings/view.ts";
import type { StartupSettings } from "../src/settings/schema.ts";
import { settingsBatchFixture } from "./settings-batch-fixture.ts";
import { arm, armed } from "../public/lib/arming.js";

type BatchModel = typeof import("../public/lib/settings-batch.js");
interface TestContext {
  reply: SettingsReply;
  requests: { path: string; revision: number; changes: Partial<StartupSettings> }[];
  outcome: "ok" | "refused" | "disconnect" | "missing-readback" | "wrong-readback" | "new-process";
  release: (() => void) | null;
  held: boolean;
}

async function checkSettingsBatch(): Promise<void> {
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
    },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { matchMedia: () => ({ matches: false }) },
  });
  const model = await import("../public/lib/settings-batch.js");
  const theme = await import("../public/lib/theme.js");
  const units = await import("../public/lib/units.js");
  const context: TestContext = {
    reply: settingsBatchFixture("initial"),
    requests: [],
    outcome: "ok",
    release: null,
    held: false,
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options) => respondToPatch(context, String(input), options);
  try {
    await resetCase(model, context, "cancel");
    const originalTheme = theme.themePreference.rawVal;
    const originalUnits = units.unitSystem.rawVal;
    const beforeStorage = [...storage];
    arm("synthetic-update");
    model.editPhoneTheme("light");
    assert.equal(armed.rawVal, "", "A display draft must disarm a previously armed update.");
    model.editPhoneUnits("imperial");
    model.editBooleanChoice("coolantProbesEnabled", true);
    model.editBooleanChoice("radiatorFanEnabled", true);
    assert.equal(theme.themePreference.rawVal, "light");
    assert.equal(units.unitSystem.rawVal, "imperial");
    assert.deepEqual([...storage], beforeStorage, "Preview cannot persist unsaved preferences.");
    assert(model.batchIsDirty());
    model.cancelSettingsBatch();
    assert.equal(theme.themePreference.rawVal, originalTheme);
    assert.equal(units.unitSystem.rawVal, originalUnits);
    assert.deepEqual([...storage], beforeStorage);
    assert.equal(context.requests.length, 0);
    assert.equal(model.batchIsDirty(), false);

    await resetCase(model, context, "one-request");
    model.editBooleanChoice("coolantProbesEnabled", true);
    model.editBooleanChoice("radiatorFanEnabled", true);
    model.editBooleanChoice("automaticDcChargingEnabled", false);
    model.editPhoneTheme("light");
    assert.equal(await model.saveSettingsBatch(), true);
    assert.deepEqual(context.requests, [
      {
        path: "/settings",
        revision: 0,
        changes: { coolantProbesEnabled: true, radiatorFanEnabled: true, automaticDcChargingEnabled: false },
      },
    ]);
    assert.equal(storage.get("coolEva.theme"), "light");
    assert.equal(model.batchIsDirty(), false);
    assert.equal(settings.rawVal?.active.coolantProbesEnabled, false);
    assert.deepEqual(settings.rawVal?.pending, [
      "coolantProbesEnabled",
      "radiatorFanEnabled",
      "automaticDcChargingEnabled",
    ]);
    assert.equal(await model.saveSettingsBatch(), true);
    assert.equal(context.requests.length, 1, "Clean Save sends nothing.");
    model.editBooleanChoice("coolantProbesEnabled", false);
    assert.equal(settingsMessages.rawVal.batch, "", "New edits cannot show an earlier Saved reply.");
    model.cancelSettingsBatch();

    await resetCase(model, context, "phone-only");
    settingsConfirmed.val = false;
    settingsError.val = "Synthetic offline";
    model.editPhoneUnits("imperial");
    assert.equal(await model.saveSettingsBatch(), true, "Phone-only changes do not need Pi contact.");
    assert.equal(context.requests.length, 0);
    assert.equal(storage.get("coolEva.units"), "imperial");

    await resetCase(model, context, "revert");
    model.editBooleanChoice("coolantProbesEnabled", true);
    model.editBooleanChoice("coolantProbesEnabled", false);
    assert.equal(model.batchIsDirty(), false, "Returning to the original choice clears the draft.");
    assert.equal(model.baseSettings.rawVal, null);

    await resetCase(model, context, "stale-revision");
    model.editBooleanChoice("coolantProbesEnabled", true);
    context.reply.revision = 1;
    acceptSettings(structuredClone(context.reply));
    model.editBooleanChoice("radiatorFanEnabled", true);
    assert.equal(await model.saveSettingsBatch(), false);
    assert.equal(context.requests.length, 0, "A known stale edit is refused before a request.");
    assert.equal(draftRevision(model), 0, "Polling cannot silently rebase another phone's edit.");
    assert.equal(model.changes.rawVal.coolantProbesEnabled, true);
    model.cancelSettingsBatch();
    assert.equal(model.booleanChoice("coolantProbesEnabled"), false);

    await resetCase(model, context, "unseen-revision");
    model.editBooleanChoice("coolantProbesEnabled", true);
    context.reply.revision = 1;
    assert.equal(await model.saveSettingsBatch(), false);
    assert.equal(context.requests[0].revision, 0, "The server CAS still covers an unseen concurrent change.");

    for (const outcome of ["refused", "disconnect", "missing-readback", "wrong-readback", "new-process"] as const) {
      await resetCase(model, context, outcome);
      const storedTheme = storage.get("coolEva.theme");
      model.editPhoneTheme("dark");
      model.editBooleanChoice("coolantProbesEnabled", true);
      context.outcome = outcome;
      assert.equal(await model.saveSettingsBatch(), false, outcome);
      assert.equal(model.changes.rawVal.coolantProbesEnabled, true, `${outcome} must keep the unsaved choice.`);
      assert.equal(storage.get("coolEva.theme"), storedTheme, `${outcome} cannot persist phone choices.`);
      assert.equal(model.batchBusy.rawVal, false);
    }

    await resetCase(model, context, "single-flight");
    model.editBooleanChoice("coolantProbesEnabled", true);
    context.held = true;
    const firstSave = model.saveSettingsBatch();
    await flushBindings();
    assert.equal(model.batchBusy.rawVal, true);
    assert.equal(await model.saveSettingsBatch(), false);
    model.editBooleanChoice("radiatorFanEnabled", true);
    model.cancelSettingsBatch();
    assert.equal(model.changes.rawVal.radiatorFanEnabled, undefined);
    assert.equal(model.changes.rawVal.coolantProbesEnabled, true);
    assert(context.release);
    context.release();
    assert.equal(await firstSave, true);
    assert.equal(context.requests.length, 1, "One Save in flight; no repeated Enter write.");

    await resetCase(model, context, "keys");
    const secret = "c".repeat(64);
    model.editBluetoothKey(secret);
    assert.equal(await model.saveSettingsBatch(), false);
    assert.equal(context.requests.length, 0, "Keep the existing recoverable-key confirmation.");
    model.bluetoothKeyBackedUp.val = true;
    assert.equal(await model.saveSettingsBatch(), true);
    assert.equal(storage.get("cool-eva.pending-code:synthetic-code"), secret);
    assert.equal(model.bluetoothKeyShown.rawVal, false);
    assert.equal(model.changes.rawVal.dashboardBluetoothSecret, undefined);
    model.editBluetoothKey("");
    assert.equal(await model.saveSettingsBatch(), true);
    assert.equal(settings.rawVal?.saved.bluetoothCodeId, null);

    await resetCase(model, context, "recording-key");
    assert.equal(model.editRecordingKey("-----BEGIN PRIVATE KEY-----"), false);
    assert.equal(model.changes.rawVal.rideLogPublicKeyPem, undefined);
    model.editRecordingKey("synthetic-public-key");
    assert.equal(await model.saveSettingsBatch(), false);
    model.recordingKeyBackedUp.val = true;
    assert.equal(await model.saveSettingsBatch(), true);
    assert.equal(settings.rawVal?.saved.recordingKeyConfigured, true);

    await resetCase(model, context, "other-pi");
    model.editBluetoothKey(secret);
    model.bluetoothKeyShown.val = true;
    acceptSettings(settingsBatchFixture("replacement"));
    await flushBindings();
    assert.equal(model.changes.rawVal.dashboardBluetoothSecret, undefined);
    assert.equal(model.bluetoothKeyShown.rawVal, false, "A different Pi must not inherit a secret draft.");
    assert.equal(settingsMessages.rawVal.batch ?? "", "");
    console.log(
      "✓ Batched Settings: one CAS PATCH, staged phone preferences, full Cancel, confirmed readback, stale/failed/unknown outcomes, single-flight and existing key handover guards"
    );
  } finally {
    globalThis.fetch = originalFetch;
    model.cancelSettingsBatch();
  }
}

async function resetCase(model: BatchModel, context: TestContext, name: string): Promise<void> {
  model.cancelSettingsBatch();
  context.reply = settingsBatchFixture(name);
  context.requests = [];
  context.outcome = "ok";
  context.held = false;
  context.release = null;
  acceptSettings(structuredClone(context.reply));
  settingsConfirmed.val = true;
  settingsError.val = "";
  await flushBindings();
  model.beginSettingsBatch();
}

async function respondToPatch(context: TestContext, path: string, options?: RequestInit): Promise<Response> {
  assert.equal(path, "/settings");
  assert.equal(options?.method, "PATCH");
  const body = JSON.parse(String(options?.body)) as { revision: number; changes: Partial<StartupSettings> };
  context.requests.push({ path, ...body });
  if (context.held) {
    await new Promise<void>(resolve => {
      context.release = resolve;
    });
  }
  if (context.outcome === "disconnect") throw new Error("Synthetic disconnected request");
  if (body.revision !== context.reply.revision || context.outcome === "refused") {
    return new Response(JSON.stringify({ ok: false, message: "Settings changed; reload before saving." }), {
      status: 409,
    });
  }
  if (context.outcome === "new-process") {
    acceptSettings({ ...context.reply, processGeneration: "synthetic-restarted-process" });
  }
  if (context.outcome === "missing-readback") {
    return new Response(JSON.stringify({ ok: true, message: "Saved." }));
  }
  if (context.outcome !== "wrong-readback") {
    for (const key of [
      "coolantProbesEnabled",
      "radiatorFanEnabled",
      "customBmsConfigurationFlashed",
      "automaticDcChargingEnabled",
      "phoneHotspotSsid",
    ] as const) {
      const value = body.changes[key];
      if (value !== undefined) {
        Object.assign(context.reply.saved, { [key]: value });
      }
    }
    if (body.changes.dashboardBluetoothSecret !== undefined) {
      context.reply.saved.bluetoothCodeId = body.changes.dashboardBluetoothSecret ? "synthetic-code" : null;
    }
    if (body.changes.rideLogPublicKeyPem !== undefined) {
      context.reply.saved.recordingKeyConfigured = !!body.changes.rideLogPublicKeyPem;
    }
  }
  context.reply.revision! += 1;
  context.reply.pending = Object.keys(body.changes) as (keyof StartupSettings)[];
  return new Response(JSON.stringify({ ok: true, message: "Saved. Applies after restart.", settings: context.reply }));
}

function flushBindings(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 10));
}

function draftRevision(model: BatchModel) {
  return model.baseSettings.rawVal?.revision;
}

await checkSettingsBatch();
