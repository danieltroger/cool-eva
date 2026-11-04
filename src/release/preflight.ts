import { createRequire } from "node:module";
import { readFile, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { parseSettingsDocument } from "../settings/schema.ts";

export async function releasePreflight(action: string, settingsFile?: string): Promise<void> {
  if (action === "settings") {
    if (!settingsFile) {
      throw new Error("A settings document is required");
    }
    parseSettingsDocument(JSON.parse(await readFile(settingsFile, "utf8")));
    return;
  }
  if (action !== "native") {
    throw new Error("Unknown release preflight");
  }
  const require = createRequire(import.meta.url);
  require("socketcan");
  require("spi-device");
  const dbusRequire = createRequire(require.resolve("dbus-next"));
  try {
    dbusRequire.resolve("usocket");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "MODULE_NOT_FOUND") {
      const database = new Database(":memory:");
      try {
        const result = database.prepare("select 42 as value").get() as { value: number };
        if (result.value !== 42) {
          throw new Error("SQLite release preflight failed");
        }
      } finally {
        database.close();
      }
      return;
    }
    throw error;
  }
  throw new Error("usocket must be absent so D-Bus uses the Node net transport");
}

const entryPoint = process.argv[1];
if (entryPoint && (await realpath(entryPoint)) === fileURLToPath(import.meta.url)) {
  await releasePreflight(process.argv[2] ?? "", process.argv[3]);
}
