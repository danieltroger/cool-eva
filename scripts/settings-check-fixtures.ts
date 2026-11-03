import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { settingsPaths } from "../src/settings/paths.ts";
import { openSettingsStore } from "../src/settings/store.ts";
import { acquireSettingsWriterLock, type LockCommand } from "../src/settings/writer-lock.ts";

export async function settingsFixture(): Promise<SettingsFixture> {
  const directory = await mkdtemp(join(tmpdir(), "cool-eva-settings-check-"));
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
const path = process.argv[4];
let handle;
try { handle = await open(path, 'wx'); } catch { process.exit(1); }
process.stdout.write('cool-eva-settings-lock\\n');
process.stdin.resume();
process.stdin.once('end', async () => { await handle.close(); await unlink(path); });
`
  );
  return { executable: process.execPath, arguments: [script] };
}
