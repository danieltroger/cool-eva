import assert from "assert/strict";
import { mkdir, readFile, readdir, stat, writeFile } from "fs/promises";
import { join, dirname } from "path";
import { generateKeyPair } from "crypto";
import { promisify } from "util";
import { startSettings, prepareCaptureMove } from "../src/settings/startup.ts";
import { capturePrunerPaths, installCapturePruner, verifyCapturePruner } from "../src/storage/capture-pruner.ts";
import { configureArchiveAccess, ensureArchiveDirectory } from "../src/storage/archive-access.ts";
import { appendDurably, replaceFileDurably } from "../src/storage/durable.ts";
import { appendReading, closeEncryptedLog, flushEncryptedLog, initEncryptedLog } from "../src/storage/encrypted-log.ts";
import { writeDumpText } from "../src/wifi/dump.ts";
import { settingsReply } from "../src/http/settings.ts";
import { createSettingsRestart } from "../src/settings/restart.ts";
import { requireFreshInstallation } from "../src/settings/fresh-setup.ts";
import { closeSettingsFixture, moveFixture, settingsFixture } from "./settings-check-fixtures.ts";

await checkPrunerGates();
await checkCaptureOrder();
await checkLegacyFields();
await checkPausedRecording();
await checkArchiveModes();
await checkCorruptMarker();
await checkOfflineFreshGuard();
console.log("settings first-boot gates passed with synthetic filesystem/process dependencies");

async function checkPrunerGates(): Promise<void> {
  const fixture = await settingsFixture();
  try {
    const root = join(fixture.directory, "root");
    const paths = capturePrunerPaths(root);
    await mkdir(paths.sudoersDirectory, { recursive: true });
    let unsafe = true;
    const writes: string[] = [];
    const options = {
      paths,
      userId: () => 0,
      inspect: async (path: string) => ({
        directory: true,
        symlink: false,
        userId: 0,
        mode: unsafe && path === join(root, "usr/local") ? 0o2775 : 0o755,
      }),
      replace: async (path: string, data: string) => {
        writes.push(path);
        await writeFile(path, data);
      },
      run: async (command: string, arguments_: string[]) => {
        assert.equal(command, "visudo");
        assert.equal(arguments_[0], "-cf");
        return { stdout: "validated" };
      },
    };
    await assert.rejects(installCapturePruner("synthetic_archive", options), /not group\/world-writable/);
    assert.deepEqual(writes, [], "An unsafe prefix must be refused before publishing a root helper or sudo rule.");
    unsafe = false;
    await installCapturePruner("synthetic_archive", options);
    assert.deepEqual(writes, [paths.helper, join(paths.sudoersDirectory, "cool-eva-prune-captures")]);
    for (const result of [
      { code: 0, stdout: "wrong marker\n" },
      { code: 1, stdout: "COOL_EVA_PRUNE_STDIN_OK\n" },
    ]) {
      await assert.rejects(verifyCapturePruner(1234, { paths, probe: async () => result }), /stdin preflight failed/);
    }
    await verifyCapturePruner(1234, {
      paths,
      probe: async (command, arguments_, input) => {
        assert.equal(command, "/usr/bin/sudo");
        assert.deepEqual(arguments_, ["-n", "-u", "#1234", "--", "/usr/bin/sudo", "-n", paths.helper]);
        assert.equal(input, "COOL_EVA_STDIN_PROBE\n");
        return { code: 0, stdout: "COOL_EVA_PRUNE_STDIN_OK\n" };
      },
    });
  } finally {
    await closeSettingsFixture(fixture);
  }
  console.log("  P/O: a writable root prefix and missing probe marker are refused without privileged test operations");
}

async function checkCaptureOrder(): Promise<void> {
  const order: string[] = [];
  let rejectProbe = true;
  const dependencies = {
    run: async (command: string, arguments_: string[]) => {
      order.push(`${command} ${arguments_.join(" ")}`);
      return { stdout: "synthetic_archive:x:1234:\n" };
    },
    installPruner: async () => {
      order.push("install");
    },
    verifyPruner: async () => {
      order.push("verify");
      if (rejectProbe) {
        throw new Error("synthetic missing probe marker");
      }
    },
  };
  await assert.rejects(prepareCaptureMove(1234, 5678, dependencies), /missing probe marker/);
  assert.deepEqual(
    order,
    ["getent group 1234", "install", "verify"],
    "Captures must stay running when the prerequisite fails."
  );
  rejectProbe = false;
  order.length = 0;
  await prepareCaptureMove(1234, 5678, dependencies);
  assert.deepEqual(order, ["getent group 1234", "install", "verify", "systemctl stop can-capture"]);
  console.log("  E: the actual startup prerequisite stops captures only after a verified helper");
}

async function checkLegacyFields(): Promise<void> {
  const publicKey = await makePublicKey();
  for (const environment of [{ BLE_MAC: "02-00-00-00-00-01" }, { BLE_MAC: "invalid" }, { RIDE_LOG_DIR: "" }]) {
    const fixture = await settingsFixture();
    try {
      const move = await moveFixture(fixture);
      await writeFile(join(move.codeDirectory, "ride-log-key.public.pem"), publicKey);
      const runtime = await startSettings({
        codeDirectory: move.codeDirectory,
        workingDirectory: move.codeDirectory,
        paths: fixture.paths,
        lock: fixture.lock,
        legacyCaptureDirectory: move.legacyCaptureDirectory,
        environment: { ...environment, BLE_SECRET: "ab".repeat(32), SERVICE_WRITE_ENABLED: "1" },
        isLegacyInstallation: async () => true,
        beforeDataMove: async () => {},
        afterDataMove: async () => {},
        flushPermissions: async () => {},
      });
      assert.equal(runtime.dataWritable, true);
      assert.equal(runtime.active.rideLogPublicKeyPem, publicKey);
      assert.equal(runtime.active.dashboardBluetoothSecret, "ab".repeat(32));
      const loaded = runtime.store.read();
      assert.equal(loaded.kind, "ready");
      if (loaded.kind !== "ready") {
        throw new Error("Expected a usable imported document");
      }
      if (environment.BLE_MAC === "invalid") {
        assert.equal(runtime.active.hubAddress, null);
        assert.equal(runtime.active.discoverHubOnce, false);
        assert.ok(loaded.document.migration.notices.includes("hub-address-invalid"));
      } else if (environment.BLE_MAC) {
        assert.equal(runtime.active.hubAddress, "02:00:00:00:00:01");
      } else {
        assert.equal(runtime.active.rideLogDirectory, fixture.paths.rideLogDirectory);
        assert.ok(loaded.document.migration.notices.includes("ride-log-directory-empty"));
      }
      await runtime.store.update(loaded.document.revision, { coolantProbesEnabled: true });
    } finally {
      await closeSettingsFixture(fixture);
    }
  }
  console.log(
    "  legacy dash addresses normalize; invalid hub/empty recording fields leave recording, Bluetooth and writes usable"
  );
}

async function checkPausedRecording(): Promise<void> {
  const fixture = await settingsFixture();
  try {
    const move = await moveFixture(fixture);
    const publicKey = await makePublicKey();
    await writeFile(join(move.codeDirectory, "ride-log-key.public.pem"), publicKey);
    const runtime = await startSettings({
      codeDirectory: move.codeDirectory,
      workingDirectory: move.codeDirectory,
      paths: fixture.paths,
      lock: fixture.lock,
      legacyCaptureDirectory: move.legacyCaptureDirectory,
      environment: {},
      isLegacyInstallation: async () => true,
      beforeDataMove: async () => {},
      afterDataMove: async () => {
        throw new Error("must not resume captures");
      },
      flushPermissions: async () => {},
      checkpoint: async step => {
        if (step === "renamed") {
          throw new Error("synthetic partial move");
        }
      },
    });
    assert.equal(runtime.dataWritable, false);
    assert.equal(
      runtime.active.rideLogPublicKeyPem,
      null,
      "C: a real imported key must not reach recording during a partial move."
    );
    assert.equal(
      await initEncryptedLog({
        directory: runtime.active.rideLogDirectory,
        ...(runtime.active.rideLogPublicKeyPem ? { publicKeyPem: runtime.active.rideLogPublicKeyPem } : {}),
        clockTrust: () => "never-synced",
      }),
      false
    );
    const restart = createSettingsRestart({ store: runtime.store, motionBlockers: () => [] });
    try {
      const view = settingsReply({
        runtime,
        restart,
        codeDirectory: move.codeDirectory,
        scanHubs: async () => [],
        drainBluetooth: async () => {},
      });
      assert.equal(
        view.active.recordingKeyConfigured,
        true,
        "The configured boot choice remains distinct from temporary recording availability."
      );
      assert.equal(
        view.pending.includes("rideLogPublicKeyPem"),
        false,
        "A runtime pause is not an owner choice awaiting restart."
      );
    } finally {
      await restart.close();
    }
  } finally {
    await closeEncryptedLog();
    await closeSettingsFixture(fixture);
  }
  console.log("  C: a partial move pauses real recording without presenting the pause as a saved key change");
}

async function checkArchiveModes(): Promise<void> {
  const previousMask = process.umask(0o022);
  const fixture = await settingsFixture();
  try {
    configureArchiveAccess(fixture.paths);
    const move = await moveFixture(fixture);
    const publicKey = await makePublicKey();
    await writeFile(join(move.codeDirectory, "ride-log-key.public.pem"), publicKey);
    const runtime = await startSettings({
      codeDirectory: move.codeDirectory,
      workingDirectory: move.codeDirectory,
      paths: fixture.paths,
      lock: fixture.lock,
      legacyCaptureDirectory: move.legacyCaptureDirectory,
      environment: {},
      isLegacyInstallation: async () => true,
      captureMove: {
        run: async () => ({ stdout: "synthetic_archive:x:1234:\n" }),
        installPruner: async () => {},
        verifyPruner: async () => {
          throw new Error("synthetic failed prerequisite");
        },
      },
    });
    assert.equal(runtime.dataWritable, true);
    assert.equal(runtime.active.rideLogDirectory, move.sourceDirectories.rideLogDirectory);
    const oldFiles = new Set(await readdir(runtime.active.rideLogDirectory));
    assert.equal(
      await initEncryptedLog({
        directory: runtime.active.rideLogDirectory,
        publicKeyPem: runtime.active.rideLogPublicKeyPem!,
        clockTrust: () => "satellite-backed",
      }),
      true
    );
    appendReading(Date.now(), "soc", 50, "%", "battery", "stream");
    await flushEncryptedLog();
    await closeEncryptedLog();
    const recordings = (await readdir(runtime.active.rideLogDirectory)).filter(
      name => name.endsWith(".celog") && !oldFiles.has(name)
    );
    assert.equal(recordings.length, 1);
    assert.equal((await stat(join(runtime.active.rideLogDirectory, recordings[0]!))).mode & 0o777, 0o644);
    const external = join(fixture.directory, "explicit-external");
    await ensureArchiveDirectory(external);
    await appendDurably(join(external, "audit.jsonl"), "synthetic\n");
    await replaceFileDurably(join(external, "snapshot.json"), "{}\n");
    const dump = await writeDumpText(join(move.codeDirectory, "wifi-diag"), 1, "synthetic dump");
    assert.ok(dump);
    for (const path of [join(external, "audit.jsonl"), join(external, "snapshot.json"), dump]) {
      assert.equal((await stat(path)).mode & 0o777, 0o644);
    }
    await ensureArchiveDirectory(join(fixture.paths.vcuParameterDirectory, "nested"));
    await appendDurably(join(fixture.paths.vcuParameterDirectory, "audit.jsonl"), "synthetic\n");
    await replaceFileDurably(join(fixture.paths.vcuParameterDirectory, "nested/snapshot.json"), "{}\n");
    assert.equal((await stat(join(fixture.paths.vcuParameterDirectory, "nested"))).mode & 0o7777, 0o2750);
    for (const path of [
      join(fixture.paths.vcuParameterDirectory, "audit.jsonl"),
      join(fixture.paths.vcuParameterDirectory, "nested/snapshot.json"),
    ]) {
      assert.equal((await stat(path)).mode & 0o777, 0o640);
    }
  } finally {
    process.umask(previousMask);
    configureArchiveAccess();
    await closeEncryptedLog();
    await closeSettingsFixture(fixture);
  }
  console.log("  refusal/external files retain main's 0644; only managed archive files/directories use 0640/2750");
}

async function checkCorruptMarker(): Promise<void> {
  const fixture = await settingsFixture();
  try {
    const corrupt = "{truncated ownership marker\n";
    await writeFile(fixture.paths.installationMarker, corrupt);
    const runtime = await startSettings({
      codeDirectory: fixture.directory,
      workingDirectory: fixture.directory,
      environment: {},
      paths: fixture.paths,
      lock: fixture.lock,
      isLegacyInstallation: async () => {
        throw new Error("must not re-import");
      },
      beforeDataMove: async () => {
        throw new Error("must not move");
      },
    });
    assert.equal(runtime.store.read().kind, "degraded");
    assert.equal(runtime.dataWritable, false);
    assert.match(runtime.fault ?? "", /invalid-install-marker/);
    assert.equal(await readFile(fixture.paths.installationMarker, "utf-8"), corrupt);
  } finally {
    await closeSettingsFixture(fixture);
  }
  console.log("  a corrupt install marker becomes a preserved degraded fault rather than crashing startup");
}

async function checkOfflineFreshGuard(): Promise<void> {
  const fixture = await settingsFixture();
  try {
    const code = join(fixture.directory, "fresh-code");
    await mkdir(code);
    const absent = { inspectUnits: async () => ({ stdout: "LoadState=not-found\n" }) };
    await requireFreshInstallation(code, {}, absent);
    await assert.rejects(
      requireFreshInstallation(code, {}, { inspectUnits: async () => ({ stdout: "LoadState=loaded\n" }) }),
      /existing service unit/
    );
    await assert.rejects(requireFreshInstallation(code, { OBD_ENABLED: "0" }, absent), /Legacy configuration/);
    await mkdir(join(code, "ride-logs"));
    await assert.rejects(requireFreshInstallation(code, {}, absent), /Existing archive folders/);
  } finally {
    await closeSettingsFixture(fixture);
  }
  console.log("  offline fresh setup refuses legacy units, configuration and archive evidence");
}

async function makePublicKey(): Promise<string> {
  const pair = await promisify(generateKeyPair)("x25519");
  return pair.publicKey.export({ type: "spki", format: "pem" }).toString();
}
