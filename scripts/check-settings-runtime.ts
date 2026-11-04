import assert from "assert/strict";
import { mkdir, readFile, writeFile, stat, rename, lstat, symlink } from "fs/promises";
import { generateKeyPair } from "crypto";
import { promisify } from "util";
import { join } from "path";
import { startSettings, runningServiceOwnsMigration } from "../src/settings/startup.ts";
import { moveLegacyData, CrossFilesystemDataMoveError } from "../src/settings/data-move.ts";
import { closeSettingsFixture, settingsFixture, moveFixture } from "./settings-check-fixtures.ts";
import { settingsReply } from "../src/http/settings.ts";
import { createSettingsRestart } from "../src/settings/restart.ts";

assert.equal(runningServiceOwnsMigration("LoadState=loaded\nMainPID=12345\n", 12345), true);
assert.equal(runningServiceOwnsMigration("LoadState=not-found\nMainPID=0\n", 12345), false);
assert.throws(() => runningServiceOwnsMigration("LoadState=loaded\nMainPID=12344\n", 12345), /not this process/);
await checkStartup();
await checkInterruptedStartup();
await checkStartupFaults();
await checkMoveGuards();
await checkKeySettingRecovery();
await checkRefusalResumesWriter();
console.log("settings runtime checks passed");

async function checkStartup(): Promise<void> {
  const fixture = await settingsFixture();
  try {
    let stopped = 0;
    const runtime = await startSettings({
      codeDirectory: fixture.directory,
      workingDirectory: fixture.directory,
      environment: {},
      paths: fixture.paths,
      lock: fixture.lock,
      isLegacyInstallation: async () => false,
      beforeDataMove: async () => {
        stopped += 1;
      },
    });
    assert.equal(stopped, 0);
    assert.equal(runtime.active.coolantProbesEnabled, false);
    assert.equal(runtime.active.automaticDcChargingEnabled, true);
    assert.equal(runtime.active.discoverHubOnce, false);
    assert.equal(runtime.fault, null);
    for (const directory of [fixture.paths.rideLogDirectory, fixture.paths.captureDirectory]) {
      assert.equal((await stat(directory)).mode & 0o7777, 0o2750);
    }
    const loaded = runtime.store.read();
    assert.equal(loaded.kind, "ready");
    if (loaded.kind !== "ready") {
      throw new Error("Expected settings");
    }
    await runtime.store.update(loaded.document.revision, { coolantProbesEnabled: true });
    assert.equal(runtime.active.coolantProbesEnabled, false);
    const second = await startSettings({
      codeDirectory: fixture.directory,
      workingDirectory: fixture.directory,
      environment: { COOLANT_ENABLED: "0" },
      paths: fixture.paths,
      lock: fixture.lock,
    });
    assert.equal(second.active.coolantProbesEnabled, true);
    assert.equal(second.fault, null);
    console.log(
      "  fresh/manual setup is explicit; saves leave the running configuration alone; the next start reads canonical settings"
    );
  } finally {
    await closeSettingsFixture(fixture);
  }
}

async function checkInterruptedStartup(): Promise<void> {
  for (const step of ["journal-saved", "renamed", "permissions-synced", "committed"] as const) {
    const fixture = await settingsFixture();
    try {
      const move = await moveFixture(fixture);
      const sourceInode = (await stat(move.sourceDirectories.rideLogDirectory)).ino;
      let stopped = 0;
      const options = {
        codeDirectory: move.codeDirectory,
        workingDirectory: move.codeDirectory,
        environment: { COOLANT_ENABLED: "1", FAN_ENABLED: "0", CHARGE_AUTO_ENABLED: "0" },
        paths: fixture.paths,
        lock: fixture.lock,
        legacyCaptureDirectory: move.legacyCaptureDirectory,
        isLegacyInstallation: async () => true,
        beforeDataMove: async () => {
          stopped += 1;
        },
        afterDataMove: async () => {},
        flushPermissions: async () => {},
      };
      const first = await startSettings({
        ...options,
        checkpoint: async reached => {
          if (reached === step) {
            throw new Error("synthetic power cut");
          }
        },
      });
      assert.match(first.fault ?? "", /synthetic power cut/);
      const captured = JSON.parse(await readFile(fixture.paths.settingsFile, "utf-8"));
      assert.equal(captured.values.coolantProbesEnabled, true);
      const second = await startSettings({
        ...options,
        environment: { COOLANT_ENABLED: "0", CHARGE_AUTO_ENABLED: "1" },
      });
      assert.equal(second.fault, null);
      assert.equal(second.active.coolantProbesEnabled, true);
      assert.equal(second.active.automaticDcChargingEnabled, false);
      assert.equal(second.active.rideLogDirectory, fixture.paths.rideLogDirectory);
      assert.equal((await stat(fixture.paths.rideLogDirectory)).ino, sourceInode);
      assert.equal((await lstat(move.sourceDirectories.rideLogDirectory)).isSymbolicLink(), true);
      const beforeHub = second.store.read();
      assert.equal(beforeHub.kind, "ready");
      if (beforeHub.kind !== "ready") {
        throw new Error("Expected settings");
      }
      const restart = createSettingsRestart({
        store: second.store,
        motionBlockers: () => [],
        schedule: async () => {},
      });
      const context = {
        runtime: second,
        restart,
        codeDirectory: move.codeDirectory,
        scanHubs: async () => [],
        drainBluetooth: async () => {},
      };
      assert.equal(await second.store.learnHub("02:00:00:00:00:01"), true);
      const view = settingsReply(context);
      assert.equal(view.revision, beforeHub.document.revision);
      assert.deepEqual(view.pending, []);
      assert.equal(view.active.hubAddress, "02:00:00:00:00:01");
      await second.store.update(beforeHub.document.revision, { radiatorFanEnabled: true });
      await restart.close();
      assert.ok(stopped > 0);
    } finally {
      await closeSettingsFixture(fixture);
    }
  }
  console.log(
    "  canonical environment snapshot precedes every move; interrupted first boots resume without re-import; first ride pin stays active and keeps the open-edit revision"
  );
}

async function checkStartupFaults(): Promise<void> {
  const fixture = await settingsFixture();
  try {
    const move = await moveFixture(fixture);
    const runtime = await startSettings({
      codeDirectory: move.codeDirectory,
      workingDirectory: move.codeDirectory,
      environment: {},
      paths: fixture.paths,
      lock: fixture.lock,
      legacyCaptureDirectory: move.legacyCaptureDirectory,
      isLegacyInstallation: async () => true,
      beforeDataMove: async () => {},
      afterDataMove: async () => {
        throw new Error("must not resume an unflushed move");
      },
      flushPermissions: async () => {
        throw new Error("bounded sync timeout");
      },
    });
    assert.match(runtime.fault ?? "", /bounded sync timeout/);
    assert.equal(runtime.dataWritable, false);
    assert.equal(runtime.active.rideLogPublicKeyPem, null);
    assert.equal(JSON.parse(await readFile(fixture.paths.moveJournal, "utf-8")).complete, false);
    await symlink(join(fixture.directory, "synthetic-outside"), join(fixture.paths.rideLogDirectory, "unsafe-link"));
    const refusedResume = await startSettings({
      codeDirectory: move.codeDirectory,
      workingDirectory: move.codeDirectory,
      environment: {},
      paths: fixture.paths,
      lock: fixture.lock,
      legacyCaptureDirectory: move.legacyCaptureDirectory,
      isLegacyInstallation: async () => true,
      beforeDataMove: async () => {},
      afterDataMove: async () => {
        throw new Error("An unsafe partial move must not resume capture writers.");
      },
      flushPermissions: async () => {},
    });
    assert.match(refusedResume.fault ?? "", /symlink, hard link or special file/);
    assert.equal(refusedResume.dataWritable, false, "An unsafe partial journal keeps every archive writer paused.");
    const unsupported = '{"schemaVersion":99,"futureCredential":"synthetic"}\n';
    await writeFile(fixture.paths.settingsFile, unsupported);
    const older = await startSettings({
      codeDirectory: move.codeDirectory,
      workingDirectory: move.codeDirectory,
      environment: { CHARGE_AUTO_ENABLED: "1" },
      paths: fixture.paths,
      lock: fixture.lock,
    });
    assert.equal(older.active.automaticDcChargingEnabled, false);
    assert.match(older.fault ?? "", /unsupported-version/);
    assert.equal(await readFile(fixture.paths.settingsFile, "utf-8"), unsupported);
  } finally {
    await closeSettingsFixture(fixture);
  }
  console.log(
    "  incomplete flush and newer-branch settings produce visible faults without a boot retry loop or overwriting the original"
  );
}

async function checkMoveGuards(): Promise<void> {
  const fixture = await settingsFixture();
  try {
    const move = await moveFixture(fixture);
    const source = move.sourceDirectories.rideLogDirectory;
    const device = (await lstat(source, { bigint: true })).dev;
    await assert.rejects(
      moveLegacyData({ ...move, destinationDevice: async () => device + 1n }),
      CrossFilesystemDataMoveError
    );
    assert.equal((await lstat(source)).isDirectory(), true);
    await assert.rejects(readFile(fixture.paths.moveJournal), { code: "ENOENT" });
    await assert.rejects(
      moveLegacyData({
        ...move,
        checkpoint: async step => {
          if (step === "renamed") {
            throw new Error("synthetic power cut");
          }
        },
      }),
      /synthetic power cut/
    );
    await rename(fixture.paths.rideLogDirectory, join(fixture.directory, "original-archive"));
    await mkdir(fixture.paths.rideLogDirectory);
    await writeFile(join(fixture.paths.rideLogDirectory, "synthetic.txt"), "replacement archive");
    await assert.rejects(moveLegacyData(move), /journalled data directory cannot be found/);
  } finally {
    await closeSettingsFixture(fixture);
  }
  console.log("  M8 cross-filesystem refusal precedes the journal; M12 resume refuses a different destination inode");
}

async function checkKeySettingRecovery(): Promise<void> {
  const fixture = await settingsFixture();
  try {
    const move = await moveFixture(fixture);
    let stopped = 0;
    const options = {
      codeDirectory: move.codeDirectory,
      workingDirectory: move.codeDirectory,
      environment: { RIDE_LOG_PUBKEY: join(fixture.directory, "missing.pem") },
      paths: fixture.paths,
      lock: fixture.lock,
      legacyCaptureDirectory: move.legacyCaptureDirectory,
      isLegacyInstallation: async () => true,
      beforeDataMove: async () => {
        stopped += 1;
      },
      afterDataMove: async () => {},
      flushPermissions: async () => {},
    };
    const first = await startSettings(options);
    assert.match(first.fault ?? "", /public key is unavailable/);
    const snapshot = first.store.read();
    assert.equal(snapshot.kind, "ready");
    if (snapshot.kind !== "ready") throw new Error("Expected ready settings");
    const pair = await promisify(generateKeyPair)("x25519");
    const pem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
    await first.store.update(snapshot.document.revision, {
      rideLogPublicKeyPem: "\ufeff\nSynthetic key header\n" + pem,
    });
    assert.equal(
      JSON.parse(await readFile(fixture.paths.settingsFile, "utf-8")).values.rideLogPublicKeyPem,
      pem,
      "The store must persist cleaned SPKI, even without the HTTP validator."
    );
    const second = await startSettings(options);
    assert.equal(second.fault, null);
    assert.equal(second.active.rideLogPublicKeyPem, pem);
    assert.equal(stopped, 1, "A settings-supplied replacement must not rerun move prerequisites.");
    const done = second.store.read();
    assert.equal(done.kind, "ready");
    if (done.kind === "ready") assert.equal(done.document.migration.complete, true);
  } finally {
    await closeSettingsFixture(fixture);
  }
  console.log(
    "  choosing a recording key in Settings resolves a legacy missing-file fault at restart without re-running the move"
  );
}

async function checkRefusalResumesWriter(): Promise<void> {
  const fixture = await settingsFixture();
  try {
    const move = await moveFixture(fixture);
    let resumed = 0;
    const sourceInode = (await stat(move.sourceDirectories.rideLogDirectory)).ino;
    const runtime = await startSettings({
      codeDirectory: move.codeDirectory,
      workingDirectory: move.codeDirectory,
      environment: { RIDE_LOG_DIR: "custom-recordings" },
      paths: fixture.paths,
      lock: fixture.lock,
      legacyCaptureDirectory: move.legacyCaptureDirectory,
      isLegacyInstallation: async () => true,
      beforeDataMove: async () => {},
      afterDataMove: async () => {
        resumed += 1;
      },
      flushPermissions: async () => {},
    });
    assert.match(runtime.fault ?? "", /inside code/);
    assert.equal(runtime.dataWritable, true);
    assert.equal(resumed, 1);
    assert.equal((await stat(move.sourceDirectories.rideLogDirectory)).ino, sourceInode);
    await assert.rejects(readFile(fixture.paths.moveJournal), { code: "ENOENT" });
  } finally {
    await closeSettingsFixture(fixture);
  }
  console.log("  an explicit in-code override faults before moving anything and resumes the intact capture writer");
}
