import assert from "assert/strict";
import { generateKeyPair } from "crypto";
import { lstat, mkdir, readFile, readlink, realpath, readdir, stat, symlink, writeFile } from "fs/promises";
import { join } from "path";
import { appendDurably, durabilityCounters, replaceFileDurably } from "../src/storage/durable.ts";
import { promisify } from "util";
import {
  moveLegacyData,
  finishLegacyDataMove,
  type DataMoveCheckpoint,
  type DataMoveOptions,
} from "../src/settings/data-move.ts";
import { migrateLegacySettings } from "../src/settings/migration.ts";
import { effectiveHubAddress, pendingSettings } from "../src/settings/schema.ts";
import { openSettingsStore } from "../src/settings/store.ts";
import { closeSettingsFixture, moveFixture, settingsFixture, type SettingsFixture } from "./settings-check-fixtures.ts";

await checkMoves();
for (const step of [
  "journal-saved",
  "renamed",
  "parents-synced",
  "permissions-applied",
  "link-created",
  "linked",
  "permissions-synced",
  "committed",
] as const) {
  await checkInterruptedMove(step);
}
await checkConflictAndOverride();
await checkPermissionSyncFailure();
await checkFullMigration();
console.log("settings data-move checks passed");

async function checkMoves(): Promise<void> {
  const fixture = await settingsFixture();
  try {
    const options = await moveFixture(fixture);
    const before = await stat(join(options.sourceDirectories.rideLogDirectory, "synthetic.celog"));
    let afterRename = 0;
    let permissionSyncs = 0;
    options.flushPermissions = async () => {
      permissionSyncs += 1;
    };
    options.checkpoint = async step => {
      if (step === "renamed") {
        afterRename = durabilityCounters().directorySyncs;
      }
      if (step === "parents-synced") {
        assert.equal(durabilityCounters().directorySyncs - afterRename, 2);
      }
    };
    const moved = await moveLegacyData(options);
    assert.deepEqual(moved, expectedDirectories(fixture));
    assert.equal(permissionSyncs, 1);
    assert.equal((await stat(join(moved.rideLogDirectory, "synthetic.celog"))).ino, before.ino);
    for (const key of Object.keys(moved) as (keyof typeof moved)[]) {
      const destination = moved[key];
      assert.equal(
        await readFile(join(destination, key === "rideLogDirectory" ? "synthetic.celog" : "synthetic.txt"), "utf-8"),
        `synthetic ${key}`
      );
      assert.equal(await realpath(options.sourceDirectories[key]), await realpath(destination));
      assert.equal((await lstat(options.sourceDirectories[key])).isSymbolicLink(), true);
      const directoryMetadata = await stat(destination);
      assert.equal(directoryMetadata.mode & 0o7777, 0o2750);
      assert.equal(directoryMetadata.uid, process.getuid!());
      assert.equal(directoryMetadata.gid, process.getgid!());
      const fileMetadata = await stat(
        join(destination, key === "rideLogDirectory" ? "synthetic.celog" : "synthetic.txt")
      );
      assert.equal(fileMetadata.mode & 0o777, 0o640);
      assert.equal(fileMetadata.gid, process.getgid!());
    }
    const oldMask = process.umask(0o027);
    try {
      await appendDurably(join(moved.rideLogDirectory, "new.celog"), "synthetic append");
      await replaceFileDurably(join(moved.vcuParameterDirectory, "new.json"), "{}");
      await replaceFileDurably(join(moved.wifiDiagnosticDirectory, "new.txt"), "synthetic dump");
      await writeFile(join(moved.captureDirectory, "new.log.gz"), "synthetic capture");
    } finally {
      process.umask(oldMask);
    }
    for (const [directory, name] of [
      [moved.rideLogDirectory, "new.celog"],
      [moved.vcuParameterDirectory, "new.json"],
      [moved.wifiDiagnosticDirectory, "new.txt"],
      [moved.captureDirectory, "new.log.gz"],
    ]) {
      const created = await stat(join(directory, name));
      assert.equal(created.gid, process.getgid!());
      assert.equal(created.mode & 0o777, 0o640);
    }
    await finishLegacyDataMove(options);
    assert.deepEqual(await moveLegacyData(options), moved);
    assert.equal(JSON.parse(await readFile(fixture.paths.moveJournal, "utf-8")).complete, true);
    console.log(
      "  four data folders move once, preserve bytes/inodes, retain rollback links and owner-group read access"
    );
  } finally {
    await closeSettingsFixture(fixture);
  }
}

async function checkInterruptedMove(step: DataMoveCheckpoint): Promise<void> {
  const fixture = await settingsFixture();
  try {
    const options = await moveFixture(fixture);
    let interrupted = false;
    const crashing: DataMoveOptions = {
      ...options,
      checkpoint: async reached => {
        if (reached === step && !interrupted) {
          interrupted = true;
          throw new Error("synthetic power cut");
        }
      },
    };
    if (step === "committed") {
      await moveLegacyData(crashing);
      await assert.rejects(finishLegacyDataMove(crashing), /synthetic power cut/);
    } else {
      await assert.rejects(moveLegacyData(crashing), /synthetic power cut/);
    }
    assert.equal(interrupted, true);
    let resumedLinkChecked = false;
    if (step === "link-created") {
      let directorySyncsAfterJournal = 0;
      options.checkpoint = async reached => {
        if (reached === "journal-saved") {
          directorySyncsAfterJournal = durabilityCounters().directorySyncs;
        }
        if (reached === "linked" && !resumedLinkChecked) {
          assert.equal(durabilityCounters().directorySyncs - directorySyncsAfterJournal, 1);
          resumedLinkChecked = true;
        }
      };
    }
    const moved = await moveLegacyData(options);
    if (step === "link-created") {
      assert.equal(resumedLinkChecked, true);
    }
    await finishLegacyDataMove(options);
    for (const key of Object.keys(moved) as (keyof typeof moved)[]) {
      assert.equal(
        await readFile(join(moved[key], key === "rideLogDirectory" ? "synthetic.celog" : "synthetic.txt"), "utf-8"),
        `synthetic ${key}`
      );
      assert.equal(await readlink(options.sourceDirectories[key]), moved[key]);
      assert.equal((await readdir(moved[key])).length, 1);
    }
    console.log(`  interrupted ${step}: resume preserves every file and creates no duplicate archive`);
  } finally {
    await closeSettingsFixture(fixture);
  }
}

async function checkConflictAndOverride(): Promise<void> {
  const fixture = await settingsFixture();
  try {
    const options = await moveFixture(fixture);
    const external = join(fixture.directory, "explicit-external");
    await mkdir(external, { mode: 0o700 });
    await writeFile(join(external, "keep"), "explicit override");
    const externalBefore = await stat(external);
    const externalLink = join(options.codeDirectory, "explicit-link");
    await symlink(external, externalLink, "dir");
    options.sourceDirectories.rideLogDirectory = externalLink;
    const moved = await moveLegacyData(options);
    assert.equal(moved.rideLogDirectory, await realpath(external));
    assert.equal((await stat(external)).mode, externalBefore.mode);
    assert.equal(await readFile(join(external, "keep"), "utf-8"), "explicit override");
  } finally {
    await closeSettingsFixture(fixture);
  }
  const conflict = await settingsFixture();
  try {
    const options = await moveFixture(conflict);
    await mkdir(conflict.paths.rideLogDirectory);
    await writeFile(join(conflict.paths.rideLogDirectory, "foreign"), "never overwrite");
    await assert.rejects(moveLegacyData(options), /already exists/);
    assert.equal(
      await readFile(join(options.sourceDirectories.rideLogDirectory, "synthetic.celog"), "utf-8"),
      "synthetic rideLogDirectory"
    );
    assert.equal(await readFile(join(conflict.paths.rideLogDirectory, "foreign"), "utf-8"), "never overwrite");
    console.log("  explicit external paths remain untouched; conflicting destinations never merge or overwrite");
  } finally {
    await closeSettingsFixture(conflict);
  }
}

async function checkFullMigration(): Promise<void> {
  const fixture = await settingsFixture();
  try {
    const moveOptions = await moveFixture(fixture);
    const environment = {
      FAN_ENABLED: "1",
      CUSTOM_BMS_CONFIG: "1",
      CHARGE_AUTO_ENABLED: "0",
      RIDE_LOG_PUBKEY: join(fixture.directory, "later-key.pem"),
    };
    let preparationCalls = 0;
    const options = {
      store: fixture.store,
      lock: fixture.lock,
      context: {
        codeDirectory: moveOptions.codeDirectory,
        workingDirectory: moveOptions.codeDirectory,
        paths: fixture.paths,
        captureDirectory: moveOptions.legacyCaptureDirectory,
      },
      environment,
      flushPermissions: moveOptions.flushPermissions,
      beforeDataMove: async () => {
        preparationCalls += 1;
      },
    };
    const pending = await migrateLegacySettings(options);
    assert.equal(preparationCalls, 1);
    assert.equal(pending.migrationFault?.code, "recording-key-unavailable");
    assert.equal(pending.kind, "ready");
    if (pending.kind !== "ready") {
      throw new Error("migration did not create settings");
    }
    assert.equal(pending.document.values.coolantProbesEnabled, false);
    assert.equal(pending.document.values.radiatorFanEnabled, true);
    assert.equal(pending.document.values.customBmsConfigurationFlashed, true);
    assert.equal(pending.document.values.automaticDcChargingEnabled, false);
    assert.equal(pending.document.migration.complete, false);
    assert.equal(pending.document.migration.pendingPublicKeyPath, environment.RIDE_LOG_PUBKEY);
    const completedJournal = await readFile(fixture.paths.moveJournal, "utf-8");
    const completedJournalInode = (await stat(fixture.paths.moveJournal)).ino;
    for (let restart = 0; restart < 2; restart += 1) {
      const retry = await migrateLegacySettings({
        ...options,
        store: await openSettingsStore(fixture.paths, fixture.lock, process.getgid!()),
      });
      assert.equal(retry.migrationFault?.code, "recording-key-unavailable");
      assert.equal(
        retry.migrationFault && "errorCode" in retry.migrationFault ? retry.migrationFault.errorCode : null,
        "ENOENT"
      );
      assert.equal(preparationCalls, 1);
      assert.equal(await readFile(fixture.paths.moveJournal, "utf-8"), completedJournal);
      assert.equal((await stat(fixture.paths.moveJournal)).ino, completedJournalInode);
    }
    const { publicKey } = await promisify(generateKeyPair)("x25519");
    await writeFile(environment.RIDE_LOG_PUBKEY, publicKey.export({ type: "spki", format: "pem" }));
    const resumedStore = await openSettingsStore(fixture.paths, fixture.lock, process.getgid!());
    const completed = await migrateLegacySettings({
      ...options,
      store: resumedStore,
      environment: { FAN_ENABLED: "0" },
    });
    assert.equal(completed.kind, "ready");
    assert.equal(completed.migrationFault, null);
    assert.equal(preparationCalls, 1);
    if (completed.kind !== "ready") {
      throw new Error("migration did not complete");
    }
    assert.equal(completed.document.migration.complete, true);
    assert.equal(completed.document.values.radiatorFanEnabled, true);
    assert.equal(completed.document.values.automaticDcChargingEnabled, false);
    assert.ok(completed.document.values.rideLogPublicKeyPem?.startsWith("-----BEGIN PUBLIC KEY-----"));
    const active = structuredClone(completed.document.values);
    const revision = completed.document.revision;
    await resumedStore.learnHub("02:00:00:00:00:10");
    const firstRide = resumedStore.read();
    if (firstRide.kind !== "ready") {
      throw new Error("first ride lost settings");
    }
    assert.equal(effectiveHubAddress(firstRide.document), "02:00:00:00:00:10");
    assert.deepEqual(pendingSettings(firstRide.document.values, active), []);
    assert.equal(firstRide.document.revision, revision);
    await resumedStore.update(revision, { phoneHotspotSsid: "synthetic-first-ride" });
    assert.equal((await stat(fixture.paths.privateDirectory)).mode & 0o777, 0o700);
    assert.equal((await stat(fixture.paths.installationMarker)).mode & 0o777, 0o600);
    console.log(
      "  service-environment migration retries an explicit missing key; canonical values win; first learned hub does not stale an edit"
    );
  } finally {
    await closeSettingsFixture(fixture);
  }
}

async function checkPermissionSyncFailure(): Promise<void> {
  const fixture = await settingsFixture();
  try {
    const options = await moveFixture(fixture);
    await assert.rejects(
      moveLegacyData({
        ...options,
        flushPermissions: async () => {
          throw new Error("synthetic permission sync failure");
        },
      }),
      /synthetic permission sync failure/
    );
    await assert.rejects(finishLegacyDataMove(options), /not ready to commit/);
    assert.equal(JSON.parse(await readFile(fixture.paths.moveJournal, "utf-8")).complete, false);
    for (const key of Object.keys(options.sourceDirectories) as (keyof typeof options.sourceDirectories)[]) {
      assert.equal(await readlink(options.sourceDirectories[key]), fixture.paths[key]);
    }
    await moveLegacyData(options);
    await finishLegacyDataMove(options);
    console.log(
      "  failed permission sync leaves rollback links intact and cannot commit; retry flushes once and completes"
    );
  } finally {
    await closeSettingsFixture(fixture);
  }
}

function expectedDirectories(fixture: SettingsFixture) {
  return {
    rideLogDirectory: fixture.paths.rideLogDirectory,
    vcuParameterDirectory: fixture.paths.vcuParameterDirectory,
    wifiDiagnosticDirectory: fixture.paths.wifiDiagnosticDirectory,
    captureDirectory: fixture.paths.captureDirectory,
  };
}
