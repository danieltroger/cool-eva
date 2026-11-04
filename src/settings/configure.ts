import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import { requireFreshInstallation } from "./fresh-setup.ts";
import { installCapturePruner, verifyCapturePruner } from "../storage/capture-pruner.ts";
import { openSettingsStore } from "./store.ts";
import { acquireSettingsWriterLock } from "./writer-lock.ts";
import { settingsPaths, DEFAULT_SETTINGS_LOCK } from "./paths.ts";
import { freshSettings } from "./schema.ts";
import { validateSettingsPatch } from "./validation.ts";
import { prepareArchiveDirectories } from "./directories.ts";

export async function configureSettings(
  codeDirectory: string,
  submitted: Record<string, unknown>,
  archiveOwner?: { userId: number; groupId: number }
): Promise<void> {
  if (process.getuid?.() !== 0) {
    throw new Error("Run the settings writer as root, with Cool Eva stopped.");
  }
  const ownership = await stat(codeDirectory);
  const owner = archiveOwner ?? { userId: ownership.uid, groupId: ownership.gid };
  const paths = settingsPaths();
  const lock = await acquireSettingsWriterLock(DEFAULT_SETTINGS_LOCK);
  try {
    const store = await openSettingsStore(paths, lock, owner.groupId);
    let current = store.read();
    const changes = Object.keys(submitted).length ? await validateSettingsPatch(submitted, paths, codeDirectory) : {};
    if (current.kind === "missing") {
      await requireFreshInstallation(codeDirectory, process.env);
      const { stdout } = await promisify(execFile)("getent", ["group", String(owner.groupId)], { timeout: 5_000 });
      await installCapturePruner(stdout.split(":")[0]);
      await verifyCapturePruner(owner.userId);
      const document = freshSettings(paths);
      document.values = { ...document.values, ...changes };
      await store.initialise(document);
    } else if (current.kind === "ready" && current.document.migration.complete) {
      if (Object.keys(changes).length) {
        await store.update(current.document.revision, changes);
      }
    } else {
      throw new Error("Settings need recovery or the running service's migration. Offline import is refused.");
    }
    await prepareArchiveDirectories(paths, store.archiveGroupId);
    await store.settled();
    current = store.read();
    console.log(
      `Settings saved; applies at the next service start (revision ${current.kind === "ready" ? current.document.revision : "unknown"}).`
    );
  } finally {
    await lock.release();
  }
}
