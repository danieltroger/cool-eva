import { prepareArchiveDirectories } from "./directories.ts";
import { finishLegacyDataMove, legacyDataMoveCompleted, moveLegacyData, type DataMoveOptions } from "./data-move.ts";
import { UnsafeArchiveError } from "./data-permissions.ts";
import { importLegacyEnvironment, type LegacyContext, type LegacyImport } from "./legacy.ts";
import { importLegacyPublicKey, type LegacyPublicKeyFault } from "./public-key.ts";
import { sweepArchiveReplacementFiles } from "./replacement-cleanup.ts";
import type { SettingsStore, SettingsState } from "./store.ts";
import type { SettingsWriterLock } from "./writer-lock.ts";

export async function migrateLegacySettings(options: LegacyMigrationOptions): Promise<LegacyMigrationState> {
  const loaded = options.store.read();
  if (loaded.kind === "degraded") return { ...loaded, migrationFault: null };
  if (
    loaded.kind === "ready" &&
    (loaded.document.migration.source !== "legacy" || loaded.document.migration.complete)
  ) {
    return { ...loaded, migrationFault: null };
  }
  const imported: LegacyImport =
    loaded.kind === "ready"
      ? {
          document: loaded.document,
          publicKeyWasExplicit: true,
          sourceDirectories: {
            rideLogDirectory: loaded.document.values.rideLogDirectory,
            vcuParameterDirectory: loaded.document.values.vcuParameterDirectory,
            wifiDiagnosticDirectory: options.context.paths.wifiDiagnosticDirectory,
            captureDirectory: options.context.paths.captureDirectory,
          },
        }
      : importLegacyEnvironment(options.environment, options.context);
  const moveOptions: DataMoveOptions = {
    paths: options.context.paths,
    codeDirectory: options.context.codeDirectory,
    legacyCaptureDirectory: options.context.captureDirectory ?? "/home/pi/ride-captures",
    sourceDirectories: imported.sourceDirectories,
    archiveGroupId: options.store.archiveGroupId,
    lock: options.lock,
    flushPermissions: options.flushPermissions,
    checkpoint: options.checkpoint,
  };
  const moveCompleted = await legacyDataMoveCompleted(options.context.paths, options.lock);
  if (!moveCompleted) {
    // A key retry after a completed move must not stop writers or reinstall the capture pruner.
    await options.beforeDataMove();
    try {
      const directories = await moveLegacyData(moveOptions);
      imported.document.values.rideLogDirectory = directories.rideLogDirectory;
      imported.document.values.vcuParameterDirectory = directories.vcuParameterDirectory;
      await prepareArchiveDirectories(options.context.paths, options.store.archiveGroupId);
      await sweepArchiveReplacementFiles(options.context.paths, options.lock);
    } catch (error) {
      if (!(error instanceof UnsafeArchiveError)) {
        throw error;
      }
      console.warn(`settings: ${error.message}`);
      return { ...options.store.read(), migrationFault: { code: error.code, message: error.message } };
    }
  }
  const keyFault = await importLegacyPublicKey(imported);
  const keyReady = imported.document.migration.pendingPublicKeyPath === null;
  imported.document.migration.complete = false;
  if (loaded.kind === "missing") {
    await options.store.initialise(imported.document);
  }
  if (!moveCompleted) {
    await finishLegacyDataMove(moveOptions);
  }
  if (keyReady) {
    await options.store.finishLegacyImport(imported.document.values.rideLogPublicKeyPem);
  }
  return { ...options.store.read(), migrationFault: keyFault };
}

export type LegacyMigrationState = SettingsState & {
  migrationFault: LegacyPublicKeyFault | { code: "unsafe-archive"; message: string } | null;
};

export interface LegacyMigrationOptions {
  store: SettingsStore;
  lock: SettingsWriterLock;
  context: LegacyContext;
  /** The caller passes the running service's own effective process environment. */
  environment: Readonly<Record<string, string | undefined>>;
  beforeDataMove: () => Promise<void>;
  flushPermissions?: DataMoveOptions["flushPermissions"];
  checkpoint?: DataMoveOptions["checkpoint"];
}
