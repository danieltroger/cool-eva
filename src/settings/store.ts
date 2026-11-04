import { chmod, chown, lstat, readFile } from "fs/promises";
import { randomUUID } from "crypto";
import { replaceFileDurably } from "../storage/durable.ts";
import { sweepReplacementFiles } from "../storage/replacement-files.ts";
import { prepareSettingsDirectories } from "./directories.ts";
import { readErrorCode } from "./error-code.ts";
import { sweepArchiveReplacementFiles } from "./replacement-cleanup.ts";
import { assertSettingsWriterLock, type SettingsWriterLock } from "./writer-lock.ts";
import {
  degradedSettings,
  parseSettingsDocument,
  record,
  SettingsFormatError,
  type ParsedSettings,
  type SettingsDocument,
  type SettingsFault,
  type StartupSettings,
} from "./schema.ts";
import type { SettingsPaths } from "./paths.ts";

export async function openSettingsStore(
  paths: SettingsPaths,
  lock: SettingsWriterLock,
  archiveGroupId: number
): Promise<SettingsStore> {
  assertSettingsWriterLock(lock);
  let markerFault: SettingsState | null = null;
  try {
    archiveGroupId = await storedArchiveGroup(paths, archiveGroupId);
  } catch (error) {
    markerFault = degradedState(paths, "invalid-install-marker", error);
  }
  if (!markerFault) {
    await prepareSettingsDirectories(paths, archiveGroupId);
    await sweepReplacementFiles(paths.privateDirectory);
    await sweepArchiveReplacementFiles(paths, lock);
  }
  let loaded = markerFault ?? (await loadSettings(paths));
  if (loaded.kind === "ready") {
    if (
      typeof loaded.raw.instanceId !== "string" ||
      (loaded.document.values.dashboardBluetoothSecret && typeof loaded.raw.bluetoothCodeId !== "string")
    ) {
      if (typeof loaded.raw.instanceId !== "string") {
        loaded.raw.instanceId = randomUUID();
      }
      if (loaded.document.values.dashboardBluetoothSecret && typeof loaded.raw.bluetoothCodeId !== "string") {
        loaded.raw.bluetoothCodeId = randomUUID();
      }
      await saveSettings(paths, loaded.raw);
    }
    await writeInstallationMarker(paths, archiveGroupId);
  }
  let queue: Promise<unknown> = Promise.resolve();
  let reservation: symbol | null = null;
  const save = async (raw: Record<string, unknown>): Promise<void> => {
    try {
      await saveSettings(paths, raw);
    } catch (error) {
      // A rename may have succeeded before directory fsync failed. Readback resolves that uncertainty.
      loaded = await loadSettings(paths);
      throw error;
    }
  };
  const serial = <Result>(operation: string, work: () => Promise<Result>): Promise<Result> => {
    const result = queue.then(() => {
      assertSettingsWriterLock(lock);
      return work();
    });
    queue = result.catch((error: unknown) =>
      console.warn(`settings: ${operation} refused or failed:`, safeError(error))
    );
    return result;
  };
  return {
    archiveGroupId,
    read: () => structuredClone(loaded),
    initialise: document =>
      serial("initialise", async () => {
        if (loaded.kind !== "missing") {
          throw new Error("Settings already exist or need recovery; initialisation is refused.");
        }
        const parsed = parseSettingsDocument(document);
        parsed.raw.bluetoothCodeId = parsed.document.values.dashboardBluetoothSecret ? randomUUID() : null;
        parsed.raw.instanceId = randomUUID();
        await save(parsed.raw);
        loaded = { kind: "ready", ...parsed };
        await writeInstallationMarker(paths, archiveGroupId);
        return structuredClone(parsed.document);
      }),
    update: (expectedRevision, changes) =>
      serial("update", async () => {
        if (reservation !== null) {
          throw new Error("A restart is reserved; wait for reconnection before saving.");
        }
        const current = readySettings(loaded);
        if (current.document.revision !== expectedRevision) {
          throw new Error("Settings changed on another connection; reload before saving.");
        }
        const values = { ...record(current.raw.values, "settings values") };
        for (const key of Object.keys(changes)) {
          if (!Object.hasOwn(current.document.values, key)) {
            throw new Error("The settings patch contains an unsupported field.");
          }
          values[key] = changes[key as keyof StartupSettings];
        }
        const raw: Record<string, unknown> = { ...current.raw, values, revision: current.document.revision + 1 };
        if (Object.hasOwn(changes, "rideLogPublicKeyPem")) {
          raw.migration = { ...record(current.raw.migration, "migration state"), pendingPublicKeyPath: null };
        }
        const parsed = parseSettingsDocument(raw);
        const cleaned: Record<string, unknown> = { ...raw, values: { ...values, ...parsed.document.values } };
        if (
          changes.dashboardBluetoothSecret !== undefined &&
          changes.dashboardBluetoothSecret !== current.document.values.dashboardBluetoothSecret
        ) {
          cleaned.bluetoothCodeId = changes.dashboardBluetoothSecret ? randomUUID() : null;
        }
        await save(cleaned);
        loaded = { kind: "ready", raw: cleaned, document: parsed.document };
        return structuredClone(parsed.document);
      }),
    learnHub: address =>
      serial("learn hub", async () => {
        if (reservation !== null) return false;
        const current = readySettings(loaded);
        if (
          !current.document.values.discoverHubOnce ||
          current.document.values.hubAddress !== null ||
          current.document.learned.hubAddress !== null
        ) {
          return false;
        }
        const learned = { ...record(current.raw.learned ?? {}, "learned settings"), hubAddress: address };
        const raw = { ...current.raw, learned };
        const parsed = parseSettingsDocument(raw);
        await save(raw);
        loaded = { kind: "ready", ...parsed };
        return true;
      }),
    finishLegacyImport: (publicKeyPem, notices) =>
      serial("finish migration", async () => {
        if (reservation !== null) {
          throw new Error("A restart is reserved.");
        }
        const current = readySettings(loaded);
        const values = { ...record(current.raw.values, "settings values"), rideLogPublicKeyPem: publicKeyPem };
        const migration = {
          ...record(current.raw.migration, "migration state"),
          complete: true,
          pendingPublicKeyPath: null,
          notices: notices ?? current.document.migration.notices,
        };
        const raw = { ...current.raw, values, migration };
        const parsed = parseSettingsDocument(raw);
        await save(raw);
        loaded = { kind: "ready", ...parsed };
        return structuredClone(parsed.document);
      }),
    settled: async () => {
      await queue;
    },
    reserve: expectedRevision =>
      serial("reserve restart", async () => {
        if (reservation !== null) {
          throw new Error("A restart is already reserved.");
        }
        const revision = loaded.kind === "ready" ? loaded.document.revision : null;
        if (expectedRevision !== revision) {
          throw new Error("Settings changed; reload before restarting.");
        }
        const token = Symbol("restart");
        reservation = token;
        return {
          release: () =>
            serial("release restart", async () => {
              if (reservation === token) {
                reservation = null;
              }
            }),
        };
      }),
  };
}

export type SettingsState =
  | ({ kind: "ready" } & ParsedSettings)
  | { kind: "missing" }
  | { kind: "degraded"; fault: SettingsFault; message: string; configuration: StartupSettings };

export interface SettingsStore {
  readonly archiveGroupId: number;
  read: () => SettingsState;
  initialise: (document: SettingsDocument) => Promise<SettingsDocument>;
  update: (expectedRevision: number, changes: Partial<StartupSettings>) => Promise<SettingsDocument>;
  learnHub: (address: string) => Promise<boolean>;
  finishLegacyImport: (publicKeyPem: string | null, notices?: string[]) => Promise<SettingsDocument>;
  settled: () => Promise<void>;
  reserve: (expectedRevision: number | null) => Promise<{ release: () => Promise<void> }>;
}

async function loadSettings(paths: SettingsPaths): Promise<SettingsState> {
  let contents: string;
  try {
    const metadata = await lstat(paths.settingsFile);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new SettingsFormatError("unreadable", "The settings file must be a regular file.");
    }
    if (metadata.size > 1024 * 1024) {
      throw new SettingsFormatError("invalid-document", "The settings file exceeds the supported size.");
    }
    if (metadata.uid !== process.getuid!() || metadata.gid !== process.getgid!()) {
      await chown(paths.settingsFile, process.getuid!(), process.getgid!());
    }
    if ((metadata.mode & 0o777) !== 0o600) {
      await chmod(paths.settingsFile, 0o600);
    }
    contents = await readFile(paths.settingsFile, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      for (const sentinel of [paths.installationMarker, paths.moveJournal]) {
        try {
          await lstat(sentinel);
        } catch (sentinelError) {
          if ((sentinelError as NodeJS.ErrnoException).code === "ENOENT") continue;
          return degradedState(paths, "unreadable", sentinelError);
        }
        return degradedState(paths, "missing-after-install");
      }
      console.log(
        "settings: no settings document or prior-install evidence; explicit initialisation or legacy import is required"
      );
      return { kind: "missing" };
    }
    return degradedState(paths, "unreadable", error);
  }
  try {
    const value: unknown = JSON.parse(contents);
    return { kind: "ready", ...parseSettingsDocument(value) };
  } catch (error) {
    return degradedState(paths, error instanceof SettingsFormatError ? error.kind : "invalid-document");
  }
}

function degradedState(paths: SettingsPaths, fault: SettingsFault, error?: unknown): SettingsState {
  const code = readErrorCode(error);
  const recovery =
    fault === "invalid-install-marker"
      ? "The installed.json ownership marker is preserved; restore it from a known-good backup before retrying settings."
      : fault === "missing-after-install"
        ? "Restore the saved settings. Existing archives were left in place."
        : "The original file is preserved; repair it or use compatible software.";
  const message = `Settings cannot be loaded (${fault}${code ? `, ${code}` : ""}). ${recovery}`;
  console.warn(`settings: ${message}`);
  return { kind: "degraded", fault, message, configuration: degradedSettings(paths) };
}

async function saveSettings(paths: SettingsPaths, raw: Record<string, unknown>): Promise<void> {
  await replaceFileDurably(paths.settingsFile, `${JSON.stringify(raw, null, 2)}\n`, {
    mode: 0o600,
    userId: process.getuid!(),
    groupId: process.getgid!(),
  });
}

function readySettings(loaded: SettingsState): ParsedSettings {
  if (loaded.kind !== "ready") {
    throw new Error("Settings need initialisation or recovery; changes are refused.");
  }
  return loaded;
}

function safeError(error: unknown): string {
  return error instanceof SettingsFormatError ? error.kind : "settings operation failed; no values were logged";
}

async function writeInstallationMarker(paths: SettingsPaths, archiveGroupId: number): Promise<void> {
  let existing: Record<string, unknown> = {};
  try {
    existing = record(JSON.parse(await readFile(paths.installationMarker, "utf-8")), "installation marker");
    if (existing.installed !== true || existing.archiveGroupId !== archiveGroupId) {
      throw new Error("The installation marker or archive group needs repair; it was not overwritten.");
    }
    const metadata = await lstat(paths.installationMarker);
    if (metadata.uid === process.getuid!() && metadata.gid === process.getgid!() && (metadata.mode & 0o777) === 0o600) {
      return;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error("The installation marker could not be validated; it was not overwritten.");
    }
    console.log("settings: recording the installation marker");
  }
  await replaceFileDurably(
    paths.installationMarker,
    `${JSON.stringify({ ...existing, installed: true, archiveGroupId })}\n`,
    { mode: 0o600, userId: process.getuid!(), groupId: process.getgid!() }
  );
}

async function storedArchiveGroup(paths: SettingsPaths, fallback: number): Promise<number> {
  let contents: string;
  try {
    contents = await readFile(paths.installationMarker, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw new Error("The archive ownership marker could not be read.");
  }
  try {
    const marker = record(JSON.parse(contents), "installation marker");
    if (
      marker.installed !== true ||
      !Number.isSafeInteger(marker.archiveGroupId) ||
      Number(marker.archiveGroupId) < 0
    ) {
      throw new Error("invalid archive group");
    }
    return Number(marker.archiveGroupId);
  } catch {
    throw new Error("The archive ownership marker needs repair; it was not overwritten.");
  }
}
