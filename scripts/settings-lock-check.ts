import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { acquireSettingsWriterLock, assertSettingsWriterLock } from "../src/settings/writer-lock.ts";

export async function checkSettingsLockShutdown(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "cool-eva-lock-shutdown-"));
  const script = join(directory, "holder.mjs");
  await writeFile(
    script,
    `import { writeFile } from 'node:fs/promises';
await writeFile(process.argv[4] + '.pid', String(process.pid));
process.stdin.resume();
process.stdin.once('end', () => process.kill(process.pid, 'SIGTERM'));
process.stdout.write('cool-eva-settings-lock\\n');
`
  );
  const command = { executable: process.execPath, arguments: [script] };
  try {
    const lock = await acquireSettingsWriterLock(join(directory, "stopping.lock"), command);
    assertSettingsWriterLock(lock);
    await lock.release();
    assert.throws(() => assertSettingsWriterLock(lock), /acquired writer lock/);
    await lock.release();

    const path = join(directory, "lost.lock");
    const lost = await acquireSettingsWriterLock(path, command);
    try {
      const holderPid = Number(await readFile(path + ".pid", "utf8"));
      assert(Number.isSafeInteger(holderPid) && holderPid > 1);
      process.kill(holderPid, "SIGTERM");
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          lost.assertHeld();
        } catch (error) {
          assert.match((error as Error).message, /no longer held/);
          break;
        }
        await delay(10);
      }
      assert.throws(
        () => assertSettingsWriterLock(lost),
        /no longer held/,
        "A terminated holder must still fence writes"
      );
    } finally {
      await lost.release();
    }
    console.log("  settings holder SIGTERM: normal release succeeds; unexpected loss still fences writes");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
