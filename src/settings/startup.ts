import { stat, lstat } from "fs/promises";
import { join } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { installCapturePruner, verifyCapturePruner } from "../storage/capture-pruner.ts";
import { legacyConfigurationWarning, captureLegacyEnvironment } from "./legacy.ts";
import { openSettingsStore, type SettingsStore } from "./store.ts";
import { acquireSettingsWriterLock, type SettingsWriterLock } from "./writer-lock.ts";
import { settingsPaths, DEFAULT_SETTINGS_LOCK, type SettingsPaths } from "./paths.ts";
import { degradedSettings, freshSettings, type StartupSettings } from "./schema.ts";
import { migrateLegacySettings } from "./migration.ts";
import { prepareArchiveDirectories, ensureDirectory } from "./directories.ts";
import { legacyDataMoveCompleted, type DataMoveOptions } from "./data-move.ts";
import { sweepArchiveReplacementFiles } from "./replacement-cleanup.ts";
import type { SettingsReadiness } from "./view.ts";

export async function startSettings(options: StartupOptions): Promise<SettingsRuntime> {
  const paths = options.paths ?? settingsPaths();
  const ownership = await stat(options.codeDirectory);
  const lock = options.lock ?? (await acquireSettingsWriterLock(options.lockPath ?? DEFAULT_SETTINGS_LOCK));
  const store = await openSettingsStore(paths, lock, ownership.gid);
  const runtime: SettingsRuntime = {
    paths,
    lock,
    store,
    active: degradedSettings(paths),
    activeCodeId: null,
    fault: null,
    dataWritable: true,
    wifiDiagnosticDirectory: paths.wifiDiagnosticDirectory,
    readiness: {
      coolant: "Off",
      fan: "Off",
      recording: "Not configured",
      bluetooth: "Off",
      hub: "Not selected",
      can: "Starting",
    },
  };
  let loaded = store.read();
  let prepared = false;
  try {
    if (loaded.kind === "missing" && !(await (options.isLegacyInstallation ?? isLegacyInstallation)(options))) {
      await store.initialise(freshSettings(paths));
      await prepareArchiveDirectories(paths, store.archiveGroupId);
    } else {
      const result = await migrateLegacySettings({
        store,
        lock,
        context: {
          codeDirectory: options.codeDirectory,
          workingDirectory: options.workingDirectory,
          paths,
          captureDirectory: options.legacyCaptureDirectory,
        },
        flushPermissions: options.flushPermissions,
        checkpoint: options.checkpoint,
        environment: options.environment,
        beforeDataMove: async () => {
          await (options.beforeDataMove ?? (() => prepareCaptureMove(store.archiveGroupId, ownership.uid)))();
          prepared = true;
        },
      });
      runtime.fault = result.migrationFault?.message ?? null;
      if (result.migrationFault?.code === "unsafe-archive") {
        runtime.dataWritable = !(await exists(paths.moveJournal));
      }
    }
  } catch (error) {
    runtime.fault = `Settings migration needs repair: ${safeMigrationError(error)}`;
    console.warn(`settings: ${runtime.fault}`);
    runtime.dataWritable = !(await exists(paths.moveJournal));
  }
  loaded = store.read();
  if (loaded.kind === "ready") {
    runtime.active = structuredClone(loaded.document.values);
    runtime.activeCodeId = bluetoothCodeId(loaded.raw);
    try {
      const moved =
        loaded.document.migration.source === "legacy" &&
        (loaded.document.migration.complete || (await legacyDataMoveCompleted(paths, lock)));
      if (runtime.dataWritable && (prepared || moved)) {
        await (options.afterDataMove ?? resumeCaptures)();
      }
      if (loaded.document.migration.source === "legacy" && !moved) {
        runtime.wifiDiagnosticDirectory = join(options.codeDirectory, "wifi-diag");
      }
      if (loaded.document.migration.source === "fresh" || loaded.document.migration.complete) {
        await prepareArchiveDirectories(paths, store.archiveGroupId);
      }
      if (runtime.dataWritable) {
        for (const directory of [runtime.active.rideLogDirectory, runtime.active.vcuParameterDirectory]) {
          if (!(await exists(directory))) {
            await ensureDirectory(directory, 0o2750, store.archiveGroupId);
          }
        }
        await sweepArchiveReplacementFiles(paths, lock, [
          runtime.active.rideLogDirectory,
          runtime.active.vcuParameterDirectory,
        ]);
      }
    } catch (error) {
      runtime.fault = `Data locations need repair: ${safeMigrationError(error)}`;
      console.warn(`settings: ${runtime.fault}`);
      runtime.dataWritable = false;
    }
    const warning = legacyConfigurationWarning(options.environment);
    if (warning) {
      console.warn(`settings: ${warning}`);
    }
  } else {
    runtime.dataWritable = false;
    runtime.active = loaded.kind === "degraded" ? loaded.configuration : degradedSettings(paths);
    runtime.fault =
      loaded.kind === "degraded"
        ? loaded.message
        : (runtime.fault ??
          "Earlier settings could not be imported. Restore a supported settings document and restart.");
  }
  if (!runtime.dataWritable) {
    runtime.active.rideLogPublicKeyPem = null;
  }
  return runtime;
}

export interface StartupOptions {
  codeDirectory: string;
  workingDirectory: string;
  environment: Readonly<Record<string, string | undefined>>;
  paths?: SettingsPaths;
  lockPath?: string;
  lock?: SettingsWriterLock;
  isLegacyInstallation?: (options: StartupOptions) => Promise<boolean>;
  beforeDataMove?: () => Promise<void>;
  afterDataMove?: () => Promise<void>;
  legacyCaptureDirectory?: string;
  flushPermissions?: DataMoveOptions["flushPermissions"];
  checkpoint?: DataMoveOptions["checkpoint"];
}

export interface SettingsRuntime {
  paths: SettingsPaths;
  lock: SettingsWriterLock;
  store: SettingsStore;
  active: StartupSettings;
  activeCodeId: string | null;
  fault: string | null;
  dataWritable: boolean;
  wifiDiagnosticDirectory: string;
  readiness: SettingsReadiness;
}

export function bluetoothCodeId(raw: Record<string, unknown>): string | null {
  const value = raw.bluetoothCodeId;
  return typeof value === "string" && /^[0-9a-f-]{36}$/.test(value) ? value : null;
}

async function isLegacyInstallation(options: StartupOptions): Promise<boolean> {
  if (Object.keys(captureLegacyEnvironment(options.environment)).length > 0) return true;
  try {
    const { stdout } = await runCommand(
      "systemctl",
      ["show", "cool-eva", "thermometer", "--property=MainPID", "--property=LoadState"],
      { timeout: 5_000 }
    );
    return runningServiceOwnsMigration(stdout, process.pid);
  } catch (error) {
    if (error instanceof ServiceOriginError) {
      throw error;
    }
    console.warn("settings: no existing systemd service; opening fresh manual setup", safeMigrationError(error));
    return false;
  }
}

async function prepareCaptureMove(groupId: number, ownerUid: number): Promise<void> {
  const { stdout } = await runCommand("getent", ["group", String(groupId)], { timeout: 5_000 });
  const name = stdout.split(":")[0];
  await installCapturePruner(name);
  await verifyCapturePruner(ownerUid);
  try {
    await runCommand("systemctl", ["stop", "can-capture"], { timeout: 20_000 });
  } catch (error) {
    const status = await runCommand("systemctl", ["show", "can-capture", "--property=LoadState", "--value"], {
      timeout: 5_000,
    });
    if (status.stdout.trim() !== "not-found") {
      throw error;
    }
    console.log("settings: no capture service is installed; no capture writer to stop");
  }
}

async function resumeCaptures(): Promise<void> {
  try {
    await runCommand("systemctl", ["start", "can-capture"], { timeout: 20_000 });
  } catch (error) {
    console.warn("settings: capture service could not resume; telemetry continues", safeMigrationError(error));
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function safeMigrationError(error: unknown): string {
  return error instanceof Error && !(error instanceof SyntaxError)
    ? error.message
    : "The stored configuration could not be read.";
}

const runCommand = promisify(execFile);

export function runningServiceOwnsMigration(output: string, processId: number): boolean {
  if (output.split(/\r?\n/).includes(`MainPID=${processId}`)) return true;
  if (output.split(/\r?\n/).includes("LoadState=loaded")) {
    throw new ServiceOriginError(
      "The installed service is not this process. Start it under its unchanged unit to capture its own configuration before migration."
    );
  }
  return false;
}
class ServiceOriginError extends Error {}
