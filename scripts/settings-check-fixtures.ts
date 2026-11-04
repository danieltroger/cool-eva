import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { settingsPaths } from "../src/settings/paths.ts";
import { importLegacyEnvironment } from "../src/settings/legacy.ts";
import type { DataMoveOptions } from "../src/settings/data-move.ts";
import { openSettingsStore } from "../src/settings/store.ts";
import { acquireSettingsWriterLock, type LockCommand } from "../src/settings/writer-lock.ts";

export async function settingsFixture(parentDirectory = tmpdir()): Promise<SettingsFixture> {
  const directory = await mkdtemp(join(parentDirectory, "cool-eva-settings-check-"));
  const command = await testLockCommand(directory);
  const lock = await acquireSettingsWriterLock(join(directory, "locks", "settings.lock"), command);
  const paths = settingsPaths(join(directory, "data"));
  try {
    const store = await openSettingsStore(paths, lock, process.getgid!());
    return { directory, paths, store, lock, command };
  } catch (error) {
    await lock.release();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export type SettingsFixture = {
  directory: string;
  paths: ReturnType<typeof settingsPaths>;
  store: Awaited<ReturnType<typeof openSettingsStore>>;
  lock: Awaited<ReturnType<typeof acquireSettingsWriterLock>>;
  command: LockCommand;
};

export async function closeSettingsFixture(fixture: SettingsFixture): Promise<void> {
  await fixture.store.settled();
  await fixture.lock.release();
  await rm(fixture.directory, { recursive: true, force: true });
}

export async function moveFixture(fixture: SettingsFixture): Promise<DataMoveOptions> {
  const codeDirectory = join(fixture.directory, "legacy-code");
  const legacyCaptureDirectory = join(fixture.directory, "legacy-captures");
  await mkdir(codeDirectory);
  const imported = importLegacyEnvironment(
    {},
    { codeDirectory, workingDirectory: codeDirectory, paths: fixture.paths, captureDirectory: legacyCaptureDirectory }
  );
  for (const key of Object.keys(imported.sourceDirectories) as (keyof typeof imported.sourceDirectories)[]) {
    const directory = imported.sourceDirectories[key];
    await mkdir(directory);
    await writeFile(
      join(directory, key === "rideLogDirectory" ? "synthetic.celog" : "synthetic.txt"),
      `synthetic ${key}`
    );
  }
  return {
    paths: fixture.paths,
    codeDirectory,
    sourceDirectories: imported.sourceDirectories,
    legacyCaptureDirectory,
    archiveGroupId: process.getgid!(),
    lock: fixture.lock,
    flushPermissions: async () => {},
  };
}

async function testLockCommand(directory: string): Promise<LockCommand> {
  if (process.platform === "linux") {
    return { executable: "flock", arguments: [] };
  }
  // CI exercises Linux's kernel lock. This host tests the same holder/queue protocol with a Node fixture.
  const script = join(directory, "lock-holder.mjs");
  await mkdir(directory, { recursive: true });
  await writeFile(
    script,
    `import {open, unlink} from 'node:fs/promises';
import {spawn} from 'node:child_process';
const path = process.argv[4];
let handle;
try { handle = await open(path, 'wx'); } catch (error) { console.error(error.code); process.exit(1); }
const [executable, ...arguments_] = process.argv.slice(5);
if (executable !== '/bin/sh') { throw new Error('production lock holder must use a minimal shell'); }
const child = spawn(executable, arguments_, {stdio: 'inherit'});
child.once('error', error => { console.error(error.code); process.exitCode = 1; });
child.once('exit', async code => { await handle.close(); await unlink(path); process.exitCode = code ?? 1; });
`
  );
  return { executable: process.execPath, arguments: [script] };
}
