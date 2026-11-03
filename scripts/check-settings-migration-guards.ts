import assert from "assert/strict";
import { generateKeyPair } from "crypto";
import { link, lstat, mkdir, readFile, stat, symlink, writeFile } from "fs/promises";
import { join } from "path";
import { promisify } from "util";
import { moveLegacyData, finishLegacyDataMove } from "../src/settings/data-move.ts";
import { UnsafeArchiveError } from "../src/settings/data-permissions.ts";
import { importLegacyEnvironment } from "../src/settings/legacy.ts";
import { migrateLegacySettings } from "../src/settings/migration.ts";
import { importLegacyPublicKey } from "../src/settings/public-key.ts";
import { closeEncryptedLog, initEncryptedLog } from "../src/storage/encrypted-log.ts";
import { closeSettingsFixture, moveFixture, settingsFixture } from "./settings-check-fixtures.ts";

for (const kind of ["symlink", "hard-link"] as const) {
  await checkUnsafeArchive(kind, false);
  await checkUnsafeArchive(kind, true);
}
await checkKeyCompatibility();
await checkMoveLock();
console.log("settings migration guard checks passed");

async function checkUnsafeArchive(kind: "symlink" | "hard-link", interrupted: boolean): Promise<void> {
  const fixture = await settingsFixture();
  try {
    const options = await moveFixture(fixture);
    if (interrupted) {
      await assert.rejects(
        moveLegacyData({
          ...options,
          checkpoint: async step => {
            if (step === "journal-saved") {
              throw new Error("synthetic power cut before any rename");
            }
          },
        }),
        /synthetic power cut/
      );
    }
    const journalBefore = interrupted ? await readFile(fixture.paths.moveJournal, "utf-8") : null;
    const outside = join(fixture.directory, "outside");
    await writeFile(outside, "synthetic outside data");
    const nested = join(options.sourceDirectories.vcuParameterDirectory, "nested");
    await mkdir(nested);
    if (kind === "symlink") {
      await symlink(outside, join(nested, "unsafe"));
    } else {
      await link(outside, join(nested, "unsafe"));
    }
    const sourceInode = (await stat(options.sourceDirectories.rideLogDirectory)).ino;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(moveLegacyData(options), UnsafeArchiveError);
      for (const key of Object.keys(options.sourceDirectories) as (keyof typeof options.sourceDirectories)[]) {
        const source = options.sourceDirectories[key];
        assert.equal((await lstat(source)).isDirectory(), true);
        assert.equal(
          await readFile(join(source, key === "rideLogDirectory" ? "synthetic.celog" : "synthetic.txt"), "utf-8"),
          `synthetic ${key}`
        );
        await assert.rejects(lstat(fixture.paths[key]), { code: "ENOENT" });
      }
      assert.equal((await stat(options.sourceDirectories.rideLogDirectory)).ino, sourceInode);
      if (journalBefore === null) {
        await assert.rejects(readFile(fixture.paths.moveJournal), { code: "ENOENT" });
      } else {
        assert.equal(await readFile(fixture.paths.moveJournal, "utf-8"), journalBefore);
      }
    }
    const result = await migrateLegacySettings({
      store: fixture.store,
      lock: fixture.lock,
      context: {
        codeDirectory: options.codeDirectory,
        workingDirectory: options.codeDirectory,
        paths: fixture.paths,
        captureDirectory: options.legacyCaptureDirectory,
      },
      environment: {},
      beforeDataMove: async () => {},
      flushPermissions: options.flushPermissions,
    });
    assert.equal(result.kind, "missing");
    assert.equal(result.migrationFault?.code, "unsafe-archive");
    assert.match(result.migrationFault?.message ?? "", /Repair it before retrying/);
    console.log(
      `  ${kind}, ${interrupted ? "interrupted journal" : "initial move"}: refusal leaves every old folder and journal intact; named fault returned`
    );
  } finally {
    await closeSettingsFixture(fixture);
  }
}

async function checkKeyCompatibility(): Promise<void> {
  const fixture = await settingsFixture();
  try {
    const { publicKey, privateKey } = await promisify(generateKeyPair)("x25519");
    const canonical = publicKey.export({ type: "spki", format: "pem" }).toString();
    const path = join(fixture.directory, "recipient.pem");
    const context = { codeDirectory: fixture.directory, workingDirectory: fixture.directory, paths: fixture.paths };
    for (const prefix of ["", "\n", "\ufeff", "synthetic key header\n"]) {
      await writeFile(path, prefix + canonical);
      assert.equal(
        await initEncryptedLog({
          publicKeyPath: path,
          directory: join(fixture.directory, "recordings"),
          clockTrust: () => "never-synced",
        }),
        true
      );
      await closeEncryptedLog();
      const imported = importLegacyEnvironment({ RIDE_LOG_PUBKEY: path }, context);
      assert.equal(await importLegacyPublicKey(imported), null);
      assert.equal(imported.document.values.rideLogPublicKeyPem, canonical);
    }
    await writeFile(path, privateKey.export({ type: "pkcs8", format: "pem" }));
    await assert.rejects(
      initEncryptedLog({
        publicKeyPath: path,
        directory: join(fixture.directory, "recordings"),
        clockTrust: () => "never-synced",
      }),
      /public key, not a private key/
    );
    const privateImport = importLegacyEnvironment({ RIDE_LOG_PUBKEY: path }, context);
    assert.equal((await importLegacyPublicKey(privateImport))?.code, "recording-key-unavailable");
    console.log(
      "  logger and migration share public-key parsing: leading newline, BOM and text accepted; private key refused by both"
    );
  } finally {
    await closeEncryptedLog();
    await closeSettingsFixture(fixture);
  }
}

async function checkMoveLock(): Promise<void> {
  const fixture = await settingsFixture();
  try {
    const options = await moveFixture(fixture);
    const foreign = { assertHeld: () => {}, release: async () => {} };
    await assert.rejects(moveLegacyData({ ...options, lock: foreign }), /acquired writer lock/);
    await assert.rejects(finishLegacyDataMove({ ...options, lock: foreign }), /acquired writer lock/);
    await fixture.lock.release();
    await assert.rejects(moveLegacyData(options), /acquired writer lock/);
    await assert.rejects(finishLegacyDataMove(options), /acquired writer lock/);
    await assert.rejects(lstat(fixture.paths.moveJournal), { code: "ENOENT" });
    assert.equal((await lstat(options.sourceDirectories.rideLogDirectory)).isDirectory(), true);
    console.log("  mover refuses foreign/released locks before any journal or data write");
  } finally {
    await closeSettingsFixture(fixture);
  }
}
