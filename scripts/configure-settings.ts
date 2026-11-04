import { requireFreshInstallation } from "../src/settings/fresh-setup.ts";
import { execFile } from "child_process";
import { promisify } from "util";
import { installCapturePruner, verifyCapturePruner } from "../src/storage/capture-pruner.ts";
import { stat } from "fs/promises";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { openSettingsStore } from "../src/settings/store.ts";
import { acquireSettingsWriterLock } from "../src/settings/writer-lock.ts";
import { settingsPaths, DEFAULT_SETTINGS_LOCK } from "../src/settings/paths.ts";
import { freshSettings, record } from "../src/settings/schema.ts";
import { validateSettingsPatch } from "../src/settings/validation.ts";
import { prepareArchiveDirectories } from "../src/settings/directories.ts";

// Installer interface: JSON on stdin, never credentials in arguments or the environment.
await configureSettings();

async function configureSettings(): Promise<void> {
  if (process.getuid?.() !== 0) {
    throw new Error("Run the offline settings writer as root, with Cool Eva stopped.");
  }
  const codeDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const paths = settingsPaths();
  const lock = await acquireSettingsWriterLock(DEFAULT_SETTINGS_LOCK);
  try {
    const store = await openSettingsStore(paths, lock, (await stat(codeDirectory)).gid);
    let current = store.read();
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of process.stdin) {
      const bytes = Buffer.from(chunk);
      length += bytes.length;
      if (length > 16 * 1024) {
        throw new Error("The settings request is too large.");
      }
      chunks.push(bytes);
    }
    let submitted: Record<string, unknown>;
    try {
      submitted = record(JSON.parse(Buffer.concat(chunks).toString("utf-8")), "settings request");
    } catch (error) {
      console.warn("settings: invalid installer input", error instanceof Error ? error.name : "unknown error");
      throw new Error("Pass a settings object as JSON on stdin.");
    }
    const changes = Object.keys(submitted).length ? await validateSettingsPatch(submitted, paths, codeDirectory) : {};
    if (current.kind === "missing") {
      await requireFreshInstallation(codeDirectory, process.env);
      const ownership = await stat(codeDirectory);
      const { stdout } = await promisify(execFile)("getent", ["group", String(ownership.gid)], { timeout: 5_000 });
      await installCapturePruner(stdout.split(":")[0]);
      await verifyCapturePruner(ownership.uid);
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
      `Settings saved at ${paths.settingsFile}; applies at the next service start (revision ${current.kind === "ready" ? current.document.revision : "unknown"}).`
    );
  } finally {
    await lock.release();
  }
}
