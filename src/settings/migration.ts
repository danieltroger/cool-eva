import { prepareArchiveDirectories } from "./directories.ts";
import { finishLegacyDataMove, moveLegacyData, type DataMoveOptions } from "./data-move.ts";
import { importLegacyEnvironment, type LegacyContext, type LegacyImport } from "./legacy.ts";
import { importLegacyPublicKey } from "./public-key.ts";
import type { SettingsStore, SettingsState } from "./store.ts";
import type { SettingsWriterLock } from "./writer-lock.ts";

export async function migrateLegacySettings(options: LegacyMigrationOptions): Promise<SettingsState> {
  const loaded = options.store.read();
  if (loaded.kind === "degraded") return loaded;
  if (
    loaded.kind === "ready" &&
    (loaded.document.migration.source !== "legacy" || loaded.document.migration.complete)
  ) {
    return loaded;
  }
  // Integration stops the capture writer and installs its non-interactive deletion helper first.
  await options.beforeDataMove();
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
    checkpoint: options.checkpoint,
  };
  const directories = await moveLegacyData(moveOptions);
  imported.document.values.rideLogDirectory = directories.rideLogDirectory;
  imported.document.values.vcuParameterDirectory = directories.vcuParameterDirectory;
  await prepareArchiveDirectories(options.context.paths, options.store.archiveGroupId);
  await importLegacyPublicKey(imported);
  const keyReady = imported.document.migration.pendingPublicKeyPath === null;
  imported.document.migration.complete = false;
  if (loaded.kind === "missing") {
    await options.store.initialise(imported.document);
  }
  await finishLegacyDataMove(moveOptions);
  if (keyReady) {
    await options.store.finishLegacyImport(imported.document.values.rideLogPublicKeyPem);
  }
  return options.store.read();
}

export interface LegacyMigrationOptions {
  store: SettingsStore;
  lock: SettingsWriterLock;
  context: LegacyContext;
  /** The caller passes the running service's own effective process environment. */
  environment: Readonly<Record<string, string | undefined>>;
  beforeDataMove: () => Promise<void>;
  checkpoint?: DataMoveOptions["checkpoint"];
}
