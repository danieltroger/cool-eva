import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, open, readFile, readdir, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { writeFileInventory } from "../release/files.ts";
import { createUpdateFixture, invokeUpdater, publishFixtureRelease, readState } from "./fixture.ts";

export async function checkUpdaterRetention(parent: string): Promise<void> {
  const fixture = await createUpdateFixture(parent);
  const privateDirectory = join(fixture.data, "updater");
  const initialDirectory = join(fixture.code, "releases/old");
  await writeFile(join(initialDirectory, "src/unchanged.bin"), Buffer.alloc(256 * 1024, 42));
  await writeFile(join(initialDirectory, "src/deleted.ts"), "// synthetic file removed locally\n");
  await writeFileInventory(initialDirectory);
  await unlink(join(initialDirectory, "src/deleted.ts"));
  await writeFile(join(initialDirectory, "src/untracked.ts"), "// synthetic untracked scratch file\n");
  let firstArchiveTime = 0;
  const firstArchive = join(privateDirectory, `edits.main-${"a".repeat(40)}.tar`);
  for (const [index, commit] of ["b", "c", "d", "e", "f"].entries()) {
    const before = await readState(fixture);
    if (index !== 1) {
      await writeFile(join(fixture.code, "releases", before.current, "src/index.ts"), `// local edit ${index}\n`);
    }
    if (index === 3) {
      await writeFile(
        join(fixture.code, "releases", before.current, "src/index.ts"),
        Buffer.alloc(8 * 1024 * 1024, 42)
      );
    }
    await publishFixtureRelease(fixture, `next-${index}`, commit.repeat(40));
    await writeFile(join(fixture.root, "os-packages.txt"), "bluez\t2\nsystemd\t1\n");
    await invokeUpdater(fixture, "update");
    const promoted = await readState(fixture);
    assert.equal(
      promoted.osPackages?.[promoted.current],
      "bluez\t2\nsystemd\t1",
      "promotion must record this host, after the image catch-up upgrade"
    );
    assert(Object.keys(promoted.osPackages!).length <= 2, "OS baselines retain only current and previous releases");
    const archives = (await readdir(privateDirectory)).filter(name => /^edits\..*\.tar$/.test(name));
    assert(archives.length <= 3, "repeated edits must not accumulate archives");
    for (const name of archives) {
      const details = await stat(join(privateDirectory, name));
      assert(details.size <= 16 * 1024 * 1024);
      assert.equal(details.mode & 0o777, 0o600);
    }
    assert((await readdir(privateDirectory)).filter(name => /^settings\./.test(name)).length <= 3);
    assert(promoted.snapshot);
    assert.equal((await stat(promoted.snapshot)).mode & 0o777, 0o600);
    if (index === 0) {
      firstArchiveTime = (await stat(firstArchive)).mtimeMs;
      const { stdout } = await promisify(execFile)("tar", ["-tf", firstArchive]);
      assert.match(stdout, /files\/src\/index.ts/);
      assert.match(stdout, /changes.txt/);
      assert.doesNotMatch(stdout, /runtime\/bin\/node|unchanged.bin|node_modules|untracked.ts|files\/src\/deleted.ts/);
      assert.match(
        (await promisify(execFile)("tar", ["-xOf", firstArchive, "changes.txt"])).stdout,
        /deleted  src\/deleted.ts/
      );
      assert.match(
        (await promisify(execFile)("tar", ["-xOf", firstArchive, "files/src/index.ts"])).stdout,
        /local edit 0/
      );
    }
    if (index === 2) {
      assert.equal(
        (await stat(firstArchive)).mtimeMs,
        firstArchiveTime,
        "pruning the same edited release must reuse its identical archive"
      );
    }
  }
  await assert.rejects(stat(firstArchive), /ENOENT/, "the oldest of four distinct edit archives must be removed");
  const current = await readState(fixture);
  assert(current.snapshot);
  await utimes(current.snapshot, 1, 1);
  for (let index = 0; index < 6; index++) {
    await copyFile(fixture.settings, join(privateDirectory, `settings.orphan-${index}`));
  }
  const oversizedLegacy = join(privateDirectory, "edits.legacy.tar");
  const legacyArchive = await open(oversizedLegacy, "w", 0o600);
  try {
    await legacyArchive.truncate(16 * 1024 * 1024 + 1);
  } finally {
    await legacyArchive.close();
  }
  await writeFile(
    join(fixture.code, "releases", current.current, "src/index.ts"),
    Buffer.alloc(8 * 1024 * 1024 + 1, 42)
  );
  await publishFixtureRelease(fixture, "oversized-edit", "1".repeat(40));
  await writeFile(join(fixture.root, "commands.txt"), "");
  await assert.rejects(invokeUpdater(fixture, "update"), /Local edits exceed 8 MiB/);
  await assert.rejects(
    stat(oversizedLegacy),
    /ENOENT/,
    "legacy whole-release archives must also respect the size bound"
  );
  assert.doesNotMatch(await readFile(join(fixture.root, "commands.txt"), "utf8"), /systemctl stop/);
  assert((await readdir(privateDirectory)).filter(name => /^settings\./.test(name)).length <= 3);
  assert.equal(
    (await stat(current.snapshot)).mode & 0o777,
    0o600,
    "the rollback's required snapshot survives even when older than the retained extras"
  );
  const growingSource = join(fixture.code, "releases", current.current, "src/index.ts");
  await writeFile(growingSource, "// synthetic edit grows after the size check\n");
  const boundedRead = join(fixture.commandDirectory, "head");
  await writeFile(
    boundedRead,
    '#!/bin/sh\nfor argument do source=$argument; done\n/usr/bin/head -c 16777216 /dev/zero >> "$source"\nexec /usr/bin/head "$@"\n',
    { mode: 0o755 }
  );
  try {
    await writeFile(join(fixture.root, "commands.txt"), "");
    await assert.rejects(invokeUpdater(fixture, "update"), /Local edits grew beyond the 8 MiB/);
    const caches = (await readdir(privateDirectory)).filter(name => name.startsWith("edit-cache."));
    assert.equal(caches.length, 1);
    assert(
      (await stat(join(privateDirectory, caches[0], "files/src/index.ts"))).size <= 8 * 1024 * 1024 + 1,
      "a source that grows after its size check must still have a bounded copy"
    );
    assert.doesNotMatch(await readFile(join(fixture.root, "commands.txt"), "utf8"), /systemctl stop/);
  } finally {
    await unlink(boundedRead);
  }
}
