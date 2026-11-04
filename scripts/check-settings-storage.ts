import assert from "assert/strict";
import { generateKeyPair } from "crypto";
import { chmod, mkdir, open, readFile, readdir, stat, writeFile } from "fs/promises";
import { join } from "path";
import { pathToFileURL } from "url";
import { promisify } from "util";
import { replaceFileDurably, durabilityCounters } from "../src/storage/durable.ts";
import { sweepReplacementFiles } from "../src/storage/replacement-files.ts";
import { importLegacyEnvironment, legacyConfigurationWarning } from "../src/settings/legacy.ts";
import { settingsPaths } from "../src/settings/paths.ts";
import { effectiveHubAddress, freshSettings, parseSettingsDocument, pendingSettings } from "../src/settings/schema.ts";
import { openSettingsStore } from "../src/settings/store.ts";
import { acquireSettingsWriterLock } from "../src/settings/writer-lock.ts";
import { closeSettingsFixture, settingsFixture } from "./settings-check-fixtures.ts";

await checkLegacyLiterals();
await checkStore();
await checkStoreLockRefusals();
await checkDegradedAndUnknownFields();
await checkReplacement();
console.log("settings storage checks passed");

async function checkLegacyLiterals(): Promise<void> {
  const context = { codeDirectory: "/legacy/code", workingDirectory: "/legacy/work", paths: settingsPaths() };
  const absent = importLegacyEnvironment({}, context);
  assert.equal(absent.document.values.coolantProbesEnabled, false);
  assert.equal(absent.document.values.radiatorFanEnabled, false);
  assert.equal(absent.document.values.customBmsConfigurationFlashed, false);
  assert.equal(absent.document.values.automaticDcChargingEnabled, true);
  assert.equal(absent.document.values.rideLogDirectory, "/legacy/code/ride-logs");
  assert.equal(absent.document.values.vcuParameterDirectory, "/legacy/code/vcu-params");
  assert.equal(absent.document.migration.pendingPublicKeyPath, "/legacy/code/ride-log-key.public.pem");
  assert.equal(absent.document.values.discoverHubOnce, true);
  assert.equal(absent.document.values.hubAddress, null);
  assert.deepEqual(absent.document.migration.notices, ["coolant-default-off", "hub-discover-once"]);
  assert.equal(importLegacyEnvironment({ COOLANT_ENABLED: "" }, context).document.values.coolantProbesEnabled, true);
  assert.equal(importLegacyEnvironment({ COOLANT_ENABLED: "0" }, context).document.values.coolantProbesEnabled, false);
  const source = {
    COOLANT_ENABLED: "1",
    FAN_ENABLED: "1",
    CUSTOM_BMS_CONFIG: "1",
    CHARGE_AUTO_ENABLED: "0",
    WIFI_HOTSPOT_SSID: "synthetic-hotspot",
    BLE_SECRET: "synthetic-access-code",
    BLE_MAC: "02:00:00:00:00:01",
    RIDE_LOG_PUBKEY: "recipient.pem",
    RIDE_LOG_DIR: "./stored-rides",
    VCU_PARAM_DIR: "/external/service",
    CAN_ENABLED: "0",
    OBD_ENABLED: "0",
    ELOCK_ENABLED: "0",
    WIFI_ENABLED: "0",
    WIFI_IFACE: "synthetic-radio",
    BLE_ENABLED: "0",
    GPS_TIME_SYNC: "0",
    SERVICE_MODE_ENABLED: "0",
    SERVICE_WRITE_ENABLED: "0",
    UPDATE_DIR: "/old/update",
    UNRELATED_SECRET: "not-a-setting",
  };
  const imported = importLegacyEnvironment(source, context);
  assert.equal(imported.document.values.coolantProbesEnabled, true);
  assert.equal(imported.document.values.radiatorFanEnabled, true);
  assert.equal(imported.document.values.customBmsConfigurationFlashed, true);
  assert.equal(imported.document.values.automaticDcChargingEnabled, false);
  assert.equal(imported.document.values.phoneHotspotSsid, "synthetic-hotspot");
  assert.equal(imported.document.values.dashboardBluetoothSecret, "synthetic-access-code");
  assert.equal(imported.document.values.hubAddress, "02:00:00:00:00:01");
  assert.equal(imported.document.values.discoverHubOnce, false);
  assert.equal(imported.document.values.rideLogDirectory, "/legacy/work/stored-rides");
  assert.equal(imported.document.values.vcuParameterDirectory, "/external/service");
  assert.equal(imported.document.migration.pendingPublicKeyPath, "/legacy/work/recipient.pem");
  assert.equal(imported.document.migration.suppliedLegacyKeys.length, 20);
  assert.equal(imported.document.migration.notices.filter(notice => notice.startsWith("retired:")).length, 10);
  const warning = legacyConfigurationWarning(source)!;
  assert.ok(warning.includes("WIFI_IFACE") && warning.includes("UPDATE_DIR"));
  assert.equal(warning.split("WIFI_IFACE").length, 2);
  assert.ok(!warning.includes("synthetic-access-code") && !warning.includes("not-a-setting"));
  assert.equal(legacyConfigurationWarning({ UNRELATED_SECRET: "not-a-setting" }), null);
  const unusual = importLegacyEnvironment(
    { FAN_ENABLED: "true", CUSTOM_BMS_CONFIG: "01", CHARGE_AUTO_ENABLED: "false" },
    context
  );
  assert.equal(unusual.document.values.radiatorFanEnabled, false);
  assert.equal(unusual.document.values.customBmsConfigurationFlashed, false);
  assert.equal(unusual.document.values.automaticDcChargingEnabled, true);
  const emptyDirectory = importLegacyEnvironment({ RIDE_LOG_DIR: "" }, context);
  assert.equal(emptyDirectory.document.values.rideLogDirectory, join(context.codeDirectory, "ride-logs"));
  assert.ok(emptyDirectory.document.migration.notices.includes("ride-log-directory-empty"));
  console.log(
    "  literal migration expectations: effective unit/drop-in values, explicit strings, coolant OFF and old paths"
  );
}

async function checkStore(): Promise<void> {
  const fixture = await settingsFixture();
  try {
    const document = freshSettings(fixture.paths);
    document.values.discoverHubOnce = true;
    document.migration.source = "legacy";
    await fixture.store.initialise(document);
    {
      const { publicKey, privateKey } = await promisify(generateKeyPair)("x25519");
      const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
      const before = await readFile(fixture.paths.settingsFile, "utf-8");
      for (const submittedKey of [privateKeyPem, publicKey.export({ type: "spki", format: "pem" }) + privateKeyPem]) {
        await assert.rejects(
          fixture.store.update(document.revision, { rideLogPublicKeyPem: submittedKey }),
          /X25519 public key/
        );
        assert.equal(await readFile(fixture.paths.settingsFile, "utf-8"), before);
      }
    }
    const active = structuredClone(document.values);
    const revision = document.revision;
    assert.equal(await fixture.store.learnHub("02:00:00:00:00:02"), true);
    const learned = fixture.store.read();
    assert.equal(learned.kind, "ready");
    if (learned.kind !== "ready") {
      throw new Error("settings did not load");
    }
    assert.equal(learned.document.revision, revision);
    assert.equal(effectiveHubAddress(learned.document), "02:00:00:00:00:02");
    assert.deepEqual(pendingSettings(learned.document.values, active), []);
    const saved = await fixture.store.update(revision, { phoneHotspotSsid: "synthetic-new-hotspot" });
    assert.equal(saved.revision, revision + 1);
    assert.equal(await fixture.store.learnHub("02:00:00:00:00:03"), false);
    const interleaving = await Promise.allSettled([
      fixture.store.update(saved.revision, { automaticDcChargingEnabled: false }),
      fixture.store.update(saved.revision, { radiatorFanEnabled: true }),
    ]);
    assert.equal(interleaving.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(interleaving.filter(result => result.status === "rejected").length, 1);
    assert.equal((await stat(fixture.paths.settingsFile)).mode & 0o777, 0o600);
    await chmod(fixture.paths.settingsFile, 0o644);
    const markerInode = (await stat(fixture.paths.installationMarker)).ino;
    const reloaded = await openSettingsStore(fixture.paths, fixture.lock, process.getgid!() + 1000);
    assert.equal(reloaded.read().kind, "ready");
    assert.equal(reloaded.archiveGroupId, process.getgid!());
    assert.equal((await stat(fixture.paths.dataRoot)).gid, process.getgid!());
    assert.equal((await stat(fixture.paths.settingsFile)).mode & 0o777, 0o600);
    assert.equal((await stat(fixture.paths.installationMarker)).ino, markerInode);
    await assert.rejects(acquireSettingsWriterLock(join(fixture.directory, "locks", "settings.lock"), fixture.command));
    console.log(
      `  learned hub is active without pending/revision churn; writers serialise (${process.platform === "linux" ? "kernel flock" : "holder protocol; kernel flock runs in Linux CI"})`
    );
  } finally {
    await closeSettingsFixture(fixture);
  }
}

async function checkStoreLockRefusals(): Promise<void> {
  const fixture = await settingsFixture();
  try {
    const foreign = { assertHeld: () => {}, release: async () => {} };
    await assert.rejects(openSettingsStore(fixture.paths, foreign, process.getgid!()), /acquired writer lock/);
    await assert.rejects(
      acquireSettingsWriterLock(join(fixture.directory, "locks", "missing.lock"), {
        executable: join(fixture.directory, "missing-flock"),
        arguments: [],
      }),
      (error: unknown) => {
        assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
        assert.match((error as Error).message, /ENOENT/);
        return true;
      }
    );
    await fixture.lock.release();
    await assert.rejects(fixture.store.initialise(freshSettings(fixture.paths)), /acquired writer lock/);
    await assert.rejects(readFile(fixture.paths.settingsFile), { code: "ENOENT" });
  } finally {
    await closeSettingsFixture(fixture);
  }
  const ready = await settingsFixture();
  try {
    await ready.store.initialise(freshSettings(ready.paths));
    const before = await readFile(ready.paths.settingsFile, "utf-8");
    await ready.lock.release();
    await assert.rejects(ready.store.update(0, { radiatorFanEnabled: true }), /acquired writer lock/);
    assert.equal(await readFile(ready.paths.settingsFile, "utf-8"), before);
    console.log("  store refuses foreign/released locks; spawn error retains ENOENT");
  } finally {
    await closeSettingsFixture(ready);
  }
}

async function checkDegradedAndUnknownFields(): Promise<void> {
  const fixture = await settingsFixture();
  try {
    const document = freshSettings(fixture.paths);
    const extended = {
      ...document,
      futureAdditive: { retained: 17 },
      values: { ...document.values, futureChoice: "keep" },
    };
    await writeFile(fixture.paths.settingsFile, JSON.stringify(extended));
    const compatible = await openSettingsStore(fixture.paths, fixture.lock, process.getgid!());
    await compatible.update(0, { radiatorFanEnabled: true });
    const roundTripped = JSON.parse(await readFile(fixture.paths.settingsFile, "utf-8"));
    assert.deepEqual(roundTripped.futureAdditive, { retained: 17 });
    assert.equal(roundTripped.values.futureChoice, "keep");
    const future = JSON.stringify({ ...extended, schemaVersion: 2, futurePrivate: "synthetic-must-survive" });
    await writeFile(fixture.paths.settingsFile, future);
    const oldBranch = await openSettingsStore(fixture.paths, fixture.lock, process.getgid!());
    const degraded = oldBranch.read();
    assert.equal(degraded.kind, "degraded");
    if (degraded.kind !== "degraded") {
      throw new Error("future document did not degrade");
    }
    assert.equal(degraded.configuration.automaticDcChargingEnabled, false);
    assert.equal(degraded.configuration.dashboardBluetoothSecret, "");
    assert.equal(degraded.configuration.rideLogPublicKeyPem, null);
    await assert.rejects(oldBranch.update(0, { automaticDcChargingEnabled: true }));
    assert.equal(await readFile(fixture.paths.settingsFile, "utf-8"), future);
    // Load a copy with the next incompatible version, then return to it after the old reader.
    const futureBuild = join(fixture.directory, "future-build");
    await mkdir(futureBuild);
    const schemaSource = await readFile(new URL("../src/settings/schema.ts", import.meta.url), "utf-8");
    assert.ok(schemaSource.includes("export const SETTINGS_SCHEMA_VERSION = 1;"));
    await writeFile(
      join(futureBuild, "schema.ts"),
      schemaSource.replace("export const SETTINGS_SCHEMA_VERSION = 1;", "export const SETTINGS_SCHEMA_VERSION = 2;")
    );
    await writeFile(
      join(futureBuild, "public-key.ts"),
      `export { validatePublicKey } from ${JSON.stringify(new URL("../src/settings/public-key.ts", import.meta.url).href)};\n`
    );
    const futureReader = (await import(
      pathToFileURL(join(futureBuild, "schema.ts")).href
    )) as typeof import("../src/settings/schema.ts");
    const newerReader = futureReader.parseSettingsDocument(
      JSON.parse(await readFile(fixture.paths.settingsFile, "utf-8"))
    );
    assert.equal(newerReader.document.schemaVersion, 2);
    assert.equal(newerReader.document.values.automaticDcChargingEnabled, true);
    assert.equal(newerReader.raw.futurePrivate, "synthetic-must-survive");
    const corrupt = '{"secret":"synthetic-do-not-echo", malformed';
    await writeFile(fixture.paths.settingsFile, corrupt);
    const messages: string[] = [];
    const originalWarning = console.warn;
    console.warn = (...values: unknown[]) => {
      messages.push(values.map(String).join(" "));
    };
    try {
      const broken = await openSettingsStore(fixture.paths, fixture.lock, process.getgid!());
      assert.equal(broken.read().kind, "degraded");
      await assert.rejects(broken.initialise(document));
    } finally {
      console.warn = originalWarning;
    }
    assert.ok(!messages.join(" ").includes("synthetic-do-not-echo"));
    assert.equal(await readFile(fixture.paths.settingsFile, "utf-8"), corrupt);
    await writeFile(fixture.paths.settingsFile, JSON.stringify(document));
    const returned = await openSettingsStore(fixture.paths, fixture.lock, process.getgid!());
    assert.equal(returned.read().kind, "ready");
    const fileParent = join(fixture.paths.dataRoot, "synthetic-file-parent");
    await writeFile(fileParent, "not a directory");
    const ioFault = (
      await openSettingsStore(
        { ...fixture.paths, settingsFile: join(fileParent, "settings.json") },
        fixture.lock,
        process.getgid!()
      )
    ).read();
    assert.equal(ioFault.kind, "degraded");
    if (ioFault.kind !== "degraded") {
      throw new Error("expected a named read fault");
    }
    assert.match(ioFault.message, /ENOTDIR/);
    const { unlink } = await import("fs/promises");
    await unlink(fixture.paths.settingsFile);
    const absentAfterInstall = await openSettingsStore(fixture.paths, fixture.lock, process.getgid!());
    assert.equal(absentAfterInstall.read().kind, "degraded");
    assert.throws(() =>
      parseSettingsDocument({
        ...document,
        values: { ...document.values, rideLogPublicKeyPem: "-----BEGIN PRIVATE KEY-----\nsynthetic\n" },
      })
    );
    console.log(
      "  additive fields round-trip; old branch preserves future/corrupt bytes, disables automation and refuses writes"
    );
  } finally {
    await closeSettingsFixture(fixture);
  }
}

async function checkReplacement(): Promise<void> {
  const fixture = await settingsFixture();
  try {
    const target = join(fixture.directory, "concurrent.json");
    const payloads = Array.from({ length: 6 }, (_unused, index) =>
      JSON.stringify({ writer: index, text: String(index).repeat(4000 + index) })
    );
    for (let round = 0; round < 8; round += 1) {
      await Promise.all(payloads.map(payload => replaceFileDurably(target, payload)));
      assert.ok(payloads.includes(await readFile(target, "utf-8")));
    }
    const before = durabilityCounters();
    await replaceFileDurably(target, "{}", { mode: 0o600 });
    const after = durabilityCounters();
    assert.ok(after.flushes > before.flushes && after.directorySyncs > before.directorySyncs);
    assert.equal((await stat(target)).mode & 0o777, 0o600);
    const held = await open(target, "r");
    try {
      const inode = (await held.stat()).ino;
      await replaceFileDurably(target, '{"new":true}', { mode: 0o600 });
      assert.equal(await held.readFile("utf-8"), "{}");
      assert.notEqual((await stat(target)).ino, inode);
    } finally {
      await held.close();
    }
    const orphan = join(fixture.directory, ".cool-eva-replace-00000000-0000-0000-0000-000000000000.tmp");
    await writeFile(orphan, "interrupted");
    await writeFile(join(fixture.directory, "unrelated.tmp"), "keep");
    await mkdir(join(fixture.directory, ".cool-eva-replace-00000000-0000-0000-0000-000000000001.tmp"));
    assert.equal(await sweepReplacementFiles(fixture.directory), 1);
    assert.ok((await readdir(fixture.directory)).includes("unrelated.tmp"));
    const archiveOrphan = ".cool-eva-replace-00000000-0000-0000-0000-000000000002.tmp";
    for (const directory of [
      fixture.paths.rideLogDirectory,
      fixture.paths.vcuParameterDirectory,
      fixture.paths.wifiDiagnosticDirectory,
      fixture.paths.captureDirectory,
    ]) {
      await mkdir(join(directory, "nested"), { recursive: true });
      await writeFile(join(directory, archiveOrphan), "interrupted replacement");
      await writeFile(join(directory, "nested", archiveOrphan), "interrupted nested replacement");
      await writeFile(join(directory, "unrelated.tmp"), "keep archive file");
    }
    await openSettingsStore(fixture.paths, fixture.lock, process.getgid!());
    for (const directory of [
      fixture.paths.rideLogDirectory,
      fixture.paths.vcuParameterDirectory,
      fixture.paths.wifiDiagnosticDirectory,
      fixture.paths.captureDirectory,
    ]) {
      await assert.rejects(readFile(join(directory, archiveOrphan)), { code: "ENOENT" });
      await assert.rejects(readFile(join(directory, "nested", archiveOrphan)), { code: "ENOENT" });
      assert.equal(await readFile(join(directory, "unrelated.tmp"), "utf-8"), "keep archive file");
    }
    console.log("  concurrent atomic replacements, flushes, private modes and selective orphan sweep");
  } finally {
    await closeSettingsFixture(fixture);
  }
}
