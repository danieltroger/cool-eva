import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readlink,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  createUpdateFixture,
  createFixtureRelease,
  invokeUpdater,
  readState,
  saveState,
  REPOSITORY,
  fixtureEnvironment,
  quote,
  type UpdateFixture,
  type FixtureState,
} from "./update-check/fixture.ts";
import { readUpdateStatus } from "../src/release/update-status.ts";

export async function checkBundleRecovery(): Promise<void> {
  const parent = join(REPOSITORY, ".preview-shots");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "bundle-recovery-"));
  try {
    const fixture = await createUpdateFixture(directory);
    const release = await createFixtureRelease(fixture, "new", "b".repeat(40));
    const snapshot = join(fixture.data, "updater/settings.test");
    await copyFile(fixture.settings, snapshot);
    const initial = await readState(fixture);
    const promoted: FixtureState = { ...initial, current: "new", previous: "old", snapshot };
    for (const currentLink of ["old", "new"]) {
      await saveState(fixture, { ...initial, pending: { target: "new", rollback: "old", snapshot, phase: "trial" } });
      await changeSettings(fixture, 1, 10);
      await setCurrentLink(fixture, currentLink);
      const previousState = await readFile(fixture.state, "utf8");
      const heldState = await open(fixture.state, "r");
      let output: string;
      try {
        output = await invokeUpdater(fixture, "recover");
        assert.equal(
          await heldState.readFile("utf8"),
          previousState,
          "journal replacement must leave an existing reader on the old inode"
        );
      } finally {
        await heldState.close();
      }
      assert.match(output, /interrupted.*press Update again/i);
      assert.equal(await readlink(join(fixture.code, "current")), "releases/old");
      assert.equal((await readState(fixture)).pending, null);
      assert.deepEqual((await readState(fixture)).rejected, []);
      assert.equal(JSON.parse(await readFile(fixture.settings, "utf8")).revision, 0);
      await invokeUpdater(fixture, "recover");
      assert.equal((await readState(fixture)).current, "old");
    }
    // A cut after the promotion journal but before its link has a committed target, not a trial.
    await saveState(fixture, promoted);
    await invokeUpdater(fixture, "recover");
    assert.equal(await readlink(join(fixture.code, "current")), "releases/new");

    await writeFile(join(fixture.root, "NRestarts.txt"), "0");
    await invokeUpdater(fixture, "failure");
    assert.equal((await readState(fixture)).current, "new");
    assert.equal((await readState(fixture)).previous, "old");
    assert.match(await readFile(join(fixture.root, "commands.txt"), "utf8"), /reset-failed/);
    await writeFile(join(fixture.root, "reset-unloaded"), "");
    assert.match(await invokeUpdater(fixture, "failure"), /was unloaded/);
    assert.equal((await readState(fixture)).current, "new");
    await unlink(join(fixture.root, "reset-unloaded"));
    await writeFile(join(fixture.root, "reset-denied"), "");
    await assert.rejects(invokeUpdater(fixture, "failure"), /Access denied/);
    await unlink(join(fixture.root, "reset-denied"));
    await writeFile(join(fixture.root, "NRestarts.txt"), "3");
    await writeFile(join(fixture.root, "Result.txt"), "exit-code");
    await checkStartLimitEvidence(fixture);

    await changeSettings(fixture, 1, 20);
    await invokeUpdater(fixture, "failure");
    assert.equal((await readState(fixture)).current, "old");
    assert.equal(JSON.parse(await readFile(fixture.settings, "utf8")).revision, 20);
    assert.equal((await readState(fixture)).lastRollback?.settingsRestored, false);
    assert.equal((await readState(fixture)).previous, null);
    assert.match(
      await readFile(join(fixture.root, "commands.txt"), "utf8"),
      /journalctl --boot --no-pager --output=json --lines=16 _PID=1 UNIT=synthetic-cool-eva.service INVOCATION_ID=dddddddddddddddddddddddddddddddd/
    );
    await writeFile(join(fixture.root, "Result.txt"), "start-limit-hit");
    await invokeUpdater(fixture, "failure");
    assert.equal((await readState(fixture)).current, "old", "a second OnFailure cannot toggle back to the failed code");
    assert.deepEqual((await readState(fixture)).rejected, [release]);

    await saveState(fixture, promoted);
    await changeSettings(fixture, 2, 30);
    await invokeUpdater(fixture, "failure");
    assert.equal(JSON.parse(await readFile(fixture.settings, "utf8")).schemaVersion, 1);
    assert.equal((await readState(fixture)).lastRollback?.settingsRestored, true);
    assert.deepEqual((await readState(fixture)).rejected, [release]);

    // Replaying a rollback intent after its link changed still selects exactly the old target.
    await saveState(fixture, {
      ...promoted,
      pending: {
        target: "new",
        rollback: "old",
        snapshot,
        phase: "rollback",
        policy: "late",
        reason: "start-limit-hit",
        reject: true,
      },
    });
    await invokeUpdater(fixture, "recover");
    assert.equal((await readState(fixture)).current, "old");
    await invokeUpdater(fixture, "recover");
    assert.equal((await readState(fixture)).current, "old");

    await saveState(fixture, promoted);
    await writeFile(join(fixture.code, "releases/new/src/index.ts"), "// edited on the bike\n");
    await invokeUpdater(fixture, "failure");
    assert.deepEqual((await readState(fixture)).rejected, []);
    assert.equal((await readState(fixture)).lastRollback?.reason, "edited-release-failed");
    assert.equal(await readFile(snapshot, "utf8"), await readFile(fixture.settings, "utf8"));
    await saveState(fixture, { ...initial, pending: { target: "new", rollback: "old", snapshot, phase: "trial" } });
    await writeFile(join(fixture.code, "releases/new/runtime/bin/node"), "#!/bin/sh\nexit 127\n");
    assert.match(await invokeUpdater(fixture, "recover"), /interrupted.*Update again/i);
    assert.equal((await readState(fixture)).current, "old");
    assert.deepEqual((await readState(fixture)).rejected, []);
    await saveState(fixture, promoted);
    await writeFile(join(fixture.code, "releases/new/release.json"), "damaged release metadata\n");
    assert.match(await invokeUpdater(fixture, "failure"), /identity is unreadable/);
    assert.equal((await readState(fixture)).current, "old");
    assert.deepEqual((await readState(fixture)).rejected, []);
    await checkHelperFallback(fixture);
    console.log(
      "bundle recovery: interrupted trial, idempotent explicit targets, manual/automatic restart causes, compatible settings, incompatible restore and edited release passed"
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function checkStartLimitEvidence(fixture: UpdateFixture): Promise<void> {
  const event = {
    _PID: "1",
    UNIT: "synthetic-cool-eva.service",
    INVOCATION_ID: "d".repeat(32),
    MESSAGE: "synthetic-cool-eva.service: Start request repeated too quickly.",
  };
  const journal = join(fixture.root, "journal.jsonl");
  await writeFile(journal, JSON.stringify(event));
  await writeFile(join(fixture.root, "commands.txt"), "");
  for (const substate of ["auto-restart", "failed-before-auto-restart", "inactive"]) {
    await writeFile(join(fixture.root, "SubState.txt"), substate);
    await invokeUpdater(fixture, "failure");
    assert.equal((await readState(fixture)).current, "new", "a pending restart or manual stop must not roll back");
  }
  assert.doesNotMatch(await readFile(join(fixture.root, "commands.txt"), "utf8"), /journalctl/);
  await writeFile(join(fixture.root, "SubState.txt"), "failed");
  for (const records of [
    [],
    [{ ...event, INVOCATION_ID: "e".repeat(32) }],
    [{ ...event, UNIT: "another.service" }],
    [{ ...event, _PID: "100" }],
    [{ ...event, MESSAGE: "synthetic-cool-eva.service: Main process exited." }],
  ]) {
    await writeFile(journal, records.map(record => JSON.stringify(record)).join("\n"));
    assert.match(await invokeUpdater(fixture, "failure"), /No start-limit event/);
    assert.equal(
      (await readState(fixture)).current,
      "new",
      "only the current invocation's manager limiter event counts"
    );
    assert.equal((await readState(fixture)).previous, "old");
  }
  await writeFile(journal, JSON.stringify(event));
  await writeFile(join(fixture.root, "NRestarts.txt"), "0");
  assert.match(await invokeUpdater(fixture, "failure"), /Manual restart limit/);
  assert.equal((await readState(fixture)).current, "new");
  assert.equal((await readState(fixture)).previous, "old");
  await writeFile(join(fixture.root, "NRestarts.txt"), "3");
}

async function changeSettings(fixture: UpdateFixture, schemaVersion: number, revision: number): Promise<void> {
  const document = JSON.parse(await readFile(fixture.settings, "utf8"));
  await writeFile(fixture.settings, JSON.stringify({ ...document, schemaVersion, revision }));
}

async function setCurrentLink(fixture: UpdateFixture, name: string): Promise<void> {
  await unlink(join(fixture.code, "current"));
  await symlink(`releases/${name}`, join(fixture.code, "current"));
}

async function checkHelperFallback(fixture: UpdateFixture): Promise<void> {
  const helperRoot = join(fixture.code, "updater");
  const working = await readlink(join(helperRoot, "current"));
  const broken = join(helperRoot, "versions/broken");
  await cp(join(helperRoot, working), broken, { recursive: true });
  await symlink(working, join(helperRoot, "previous"));
  await unlink(join(helperRoot, "current"));
  await symlink("versions/broken", join(helperRoot, "current"));
  await writeFile(join(broken, "run.sh"), "if broken syntax\n");
  const dispatcher = join(fixture.root, "dispatch.sh");
  const source = await readFile(join(REPOSITORY, "scripts/update/dispatch.sh"), "utf8");
  await writeFile(dispatcher, source.replace("helper_root=/opt/cool-eva/updater", `helper_root=${quote(helperRoot)}`));
  const execute = promisify(execFile);
  const options = { env: fixtureEnvironment(fixture), timeout: 30_000 };
  await execute("sh", [dispatcher, "recover", "--config", fixture.configuration], options);
  assert.equal((await readState(fixture)).current, "old");
  await copyFile(join(helperRoot, working, "run.sh"), join(broken, "run.sh"));
  const lifecycle = await readFile(join(broken, "lifecycle.sh"), "utf8");
  await writeFile(
    join(broken, "lifecycle.sh"),
    lifecycle +
      '\napply_update() { read_state; save_state ".sequence = 99"; record_status true true trying; systemctl stop "$SERVICE"; exit 9; }\n'
  );
  await writeFile(join(fixture.root, "commands.txt"), "");
  await assert.rejects(
    execute("sh", [dispatcher, "update", "--config", fixture.configuration], options),
    error => error instanceof Error && "code" in error && error.code === 9
  );
  const calls = await readFile(join(fixture.root, "commands.txt"), "utf8");
  assert.match(calls, /systemctl stop[\s\S]*reset-failed[\s\S]*start --no-block/);
  const status = await readUpdateStatus(join(fixture.data, "updater"));
  assert.equal(status.sequence, 99);
  assert.equal(status.running, false);
  assert.match(status.message, /interrupted/);
}

await checkBundleRecovery();
