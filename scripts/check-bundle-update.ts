import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createUpdateFixture,
  invokeUpdater,
  publishFixtureRelease,
  readState,
  REPOSITORY,
} from "./update-check/fixture.ts";

export async function checkBundleUpdate(): Promise<void> {
  const parent = join(REPOSITORY, ".preview-shots");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "bundle-transactions-"));
  try {
    const fixture = await createUpdateFixture(directory);
    const initialHelper = await readlink(join(fixture.code, "updater/current"));
    const staleDownload = join(fixture.data, "updater/download.interrupted");
    await mkdir(staleDownload);
    await writeFile(join(staleDownload, "partial-archive"), "orphaned download after a synthetic power cut");
    const archiveNames = ["ride-logs", "vcu-params", "wifi-diag", "captures"];
    for (const name of archiveNames) {
      await writeFile(join(fixture.data, name, "preserved.txt"), `synthetic ${name} archive`);
    }
    const newTag = await publishFixtureRelease(fixture, "candidate", "b".repeat(40));
    // Git status and an upstream lockfile cannot participate in a bundle update (#324 F5).
    await writeFile(join(fixture.code, "releases/old/package-lock.json"), "local lockfile edits\n");
    const output = await invokeUpdater(fixture, "update");
    assert.match(output, /Update installed/);
    await assert.rejects(readFile(join(staleDownload, "partial-archive")), /ENOENT/);
    for (const name of archiveNames) {
      assert.equal(await readFile(join(fixture.data, name, "preserved.txt"), "utf8"), `synthetic ${name} archive`);
    }
    const promoted = await readState(fixture);
    assert.notEqual(promoted.current, "old");
    assert.equal(promoted.previous, "old");
    assert.equal(promoted.pending, null);
    assert.equal(await readlink(join(fixture.code, "current")), `releases/${promoted.current}`);
    assert.equal(await readFile(fixture.settings, "utf8"), await readFile(promoted.snapshot!, "utf8"));
    const calls = await readFile(join(fixture.root, "commands.txt"), "utf8");
    assert(!/\bgit\b|\bnpm\b|api.github.com/.test(calls));
    assert.match(calls, /systemctl start --no-block/);
    assert.match(calls, /sync[\s\S]*mv -fT[\s\S]*sync/);
    assert((calls.match(/cut -d \. -f 1 \/proc\/uptime/g) ?? []).length >= 4, "trial must span 60 monotonic seconds");
    const helper = await readlink(join(fixture.code, "updater/current"));
    assert.match(helper, /^versions\/helper\./);
    assert.notEqual(helper, initialHelper);
    assert.equal(await readlink(join(fixture.code, "updater/previous")), initialHelper);
    assert.equal(
      await readFile(join(fixture.code, "updater", helper, "run.sh"), "utf8"),
      await readFile(join(REPOSITORY, "scripts/update/run.sh"), "utf8")
    );
    assert.match(await invokeUpdater(fixture, "update"), /Already up to date/);

    // A checksum failure leaves both code and settings intact, before stopping any writer.
    const badTag = await publishFixtureRelease(fixture, "bad-download", "c".repeat(40));
    const correctArchive = await readFile(join(fixture.root, "assets", badTag, "bundle.tar.zst"));
    await writeFile(join(fixture.root, "assets", badTag, "bundle.tar.zst"), "corrupt download");
    await writeFile(join(fixture.root, "commands.txt"), "");
    await assert.rejects(invokeUpdater(fixture, "update"), /download was incomplete/);
    assert.equal((await readState(fixture)).current, promoted.current);
    assert(!/systemctl stop/.test(await readFile(join(fixture.root, "commands.txt"), "utf8")));
    const corruptArchive = Buffer.from(correctArchive);
    corruptArchive[corruptArchive.length - 1] ^= 1;
    await writeFile(join(fixture.root, "assets", badTag, "bundle.tar.zst"), corruptArchive);
    await assert.rejects(invokeUpdater(fixture, "update"), /checksum did not match/);

    // A failed trial rolls back once, rejects the clean failing release, then permits a new update.
    const failingTag = await publishFixtureRelease(fixture, "unhealthy", "d".repeat(40));
    await writeFile(join(fixture.root, "health.txt"), "fail");
    await assert.rejects(invokeUpdater(fixture, "update"), /failed its health check/);
    const rolledBack = await readState(fixture);
    assert.equal(rolledBack.current, promoted.current);
    assert.equal(rolledBack.previous, null);
    assert.equal(rolledBack.pending, null);
    assert.deepEqual(rolledBack.rejected, [failingTag.slice("cool-eva-".length)]);
    await assert.rejects(invokeUpdater(fixture, "update"), /already failed/);
    await publishFixtureRelease(fixture, "good-next", "e".repeat(40));
    await writeFile(join(fixture.code, "releases", promoted.current, "src/index.ts"), "// local edit\n");
    assert.match(await invokeUpdater(fixture, "update"), /Update installed/);
    assert((await readdir(join(fixture.data, "updater"))).some(name => /^edits\..*\.tar$/.test(name)));

    // The only service data mover has not finished: fail closed without stopping the app.
    const settings = JSON.parse(await readFile(fixture.settings, "utf8"));
    settings.migration.complete = false;
    await writeFile(fixture.settings, JSON.stringify(settings));
    await writeFile(join(fixture.root, "commands.txt"), "");
    await assert.rejects(invokeUpdater(fixture, "update"), /migration is incomplete/);
    assert(!/systemctl stop/.test(await readFile(join(fixture.root, "commands.txt"), "utf8")));
    assert(newTag.startsWith("cool-eva-main-"));
    console.log(
      "bundle update: promotion, checksum refusal, trial rollback, rejection, next update, edit archive and migration gate passed"
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

await checkBundleUpdate();
