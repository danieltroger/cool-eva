import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  createUpdateFixture,
  createFixtureRelease,
  invokeUpdater,
  publishFixtureRelease,
  readState,
  repackFixtureRelease,
  updateFixtureManifest,
  REPOSITORY,
} from "./update-check/fixture.ts";

export async function checkBundleBoundaries(): Promise<void> {
  await mkdir(join(REPOSITORY, ".preview-shots"), { recursive: true });
  const parent = await mkdtemp(join(REPOSITORY, ".preview-shots/bundle-boundaries-"));
  try {
    const fixture = await createUpdateFixture(parent);
    const tag = await publishFixtureRelease(fixture, "candidate", "b".repeat(40));
    const manifestPath = join(fixture.root, "assets", tag, "manifest.txt");
    const manifest = await readFile(manifestPath, "utf8");
    for (const malformed of [
      manifest.replace(/^node=.*$/m, `commit=${"b".repeat(40)}`),
      manifest.replace(/^node=.*$/m, "node=24;id"),
      manifest.replace(/^node=.*\n/m, ""),
    ]) {
      await writeFile(manifestPath, malformed);
      await assert.rejects(invokeUpdater(fixture, "update"), /Invalid release manifest/);
    }
    await writeFile(manifestPath, manifest);
    await createFixtureRelease(fixture, "candidate", "b".repeat(40));
    await symlink("../../outside", join(fixture.code, "releases/candidate/src/escape"));
    await repackFixtureRelease(fixture, "candidate", tag);
    await assert.rejects(invokeUpdater(fixture, "update"), /link or special file/);
    assert.equal((await readState(fixture)).current, "old");

    // A valid checksum must not make a path traversal safe. No real outside file is written.
    const rawTar = join(fixture.root, "unsafe.tar");
    await writeFile(rawTar, traversalTar());
    const archive = join(fixture.root, "assets", tag, "bundle.tar.zst");
    await execFileAsync("zstd", ["-q", "-f", rawTar, "-o", archive]);
    await updateFixtureManifest(fixture, tag);
    await assert.rejects(invokeUpdater(fixture, "update"), /unsafe path/);
    assert.equal((await readState(fixture)).current, "old");

    // A data path canonically inside releases blocks cleanup before any release/data deletion.
    const settings = JSON.parse(await readFile(fixture.settings, "utf8"));
    settings.values.rideLogDirectory = join(fixture.code, "releases/old/ride-logs");
    await mkdir(settings.values.rideLogDirectory);
    await writeFile(join(settings.values.rideLogDirectory, "preserved.txt"), "synthetic archive");
    await writeFile(fixture.settings, JSON.stringify(settings));
    await assert.rejects(invokeUpdater(fixture, "update"), /data directory is still inside/);
    assert.equal(await readFile(join(settings.values.rideLogDirectory, "preserved.txt"), "utf8"), "synthetic archive");
    settings.values.rideLogDirectory = join(fixture.data, "updater/download.reserved");
    await mkdir(settings.values.rideLogDirectory);
    await writeFile(join(settings.values.rideLogDirectory, "preserved.txt"), "synthetic reserved-path archive");
    await writeFile(fixture.settings, JSON.stringify(settings));
    await assert.rejects(invokeUpdater(fixture, "update"), /reserved updater directory/);
    assert.equal(
      await readFile(join(settings.values.rideLogDirectory, "preserved.txt"), "utf8"),
      "synthetic reserved-path archive"
    );
    console.log(
      "bundle boundaries: links, traversal with a valid checksum and data inside code refused before extraction/cleanup"
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

const execFileAsync = promisify(execFile);

function traversalTar(): Buffer {
  const header = Buffer.alloc(512);
  header.write("../../escaped.txt", 0);
  header.write("0000644\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write("00000000001\0", 124);
  header.write("00000000000\0", 136);
  header.fill(32, 148, 156);
  header[156] = 48;
  header.write("ustar\0", 257);
  header.write("00", 263);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148);
  const payload = Buffer.alloc(512);
  payload[0] = 120;
  return Buffer.concat([header, payload, Buffer.alloc(1024)]);
}

await checkBundleBoundaries();
