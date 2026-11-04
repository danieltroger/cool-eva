import type { ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { settingsPaths, type SettingsPaths } from "../settings/paths.ts";
import { parseSettingsDocument, record } from "../settings/schema.ts";
import { readReleaseMetadata } from "../release/metadata.ts";

export async function handleReleaseHealth(
  res: ServerResponse,
  directory: string,
  paths = settingsPaths()
): Promise<void> {
  try {
    const metadata = await readReleaseMetadata(directory);
    if (metadata === null) {
      throw new Error("This is a checkout, not a release");
    }
    await verifyReleaseStorage(paths);
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ ok: true, release: metadata.release }));
  } catch (error) {
    console.warn("release health: settings migration is not ready:", error);
    res.writeHead(503, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ ok: false }));
  }
}

export async function verifyReleaseStorage(paths: SettingsPaths): Promise<void> {
  const marker = record(JSON.parse(await readFile(paths.installationMarker, "utf8")), "installation marker");
  if (marker.installed !== true || !Number.isSafeInteger(marker.archiveGroupId) || Number(marker.archiveGroupId) < 0) {
    throw new Error("The service installation marker is incomplete");
  }
  const { document } = parseSettingsDocument(JSON.parse(await readFile(paths.settingsFile, "utf8")));
  if (!document.migration.complete) {
    throw new Error("The service migration is incomplete");
  }
  if (document.migration.source === "legacy") {
    const journal: unknown = JSON.parse(await readFile(paths.moveJournal, "utf8"));
    if (journal === null || typeof journal !== "object" || !("complete" in journal) || journal.complete !== true) {
      throw new Error("The service data move is incomplete");
    }
  }
}
