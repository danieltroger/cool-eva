import { prepareExistingService, restoreService, type ServiceBackup } from "./service.ts";
import { MigrationNeedsHelpError, ServiceRecoveryError, ServiceRestoredError } from "./errors.ts";

export async function failAfterServiceRecovery(backup: ServiceBackup | null, failure: unknown): Promise<never> {
  try {
    await restoreService(backup, failure);
  } catch (restoreError) {
    if (backup === null && restoreError === failure) {
      throw failure;
    }
    console.error(
      "Restoring a running service failed:",
      restoreError instanceof SyntaxError
        ? "Stored configuration could not be read."
        : restoreError instanceof Error
          ? restoreError.message
          : "unknown error"
    );
    throw new ServiceRecoveryError(backup?.service ?? "cool-eva.service", { cause: failure });
  }
  throw new ServiceRestoredError(failure);
}

export async function prepareServiceWithRecovery(directory: string): Promise<ServiceBackup | null> {
  let backup: ServiceBackup | null = null;
  try {
    return await prepareExistingService(directory, captured => {
      backup = captured;
    });
  } catch (error) {
    // An unfinished service-owned data move must stay quiescent for repair.
    if (error instanceof MigrationNeedsHelpError) {
      throw error;
    }
    if (backup === null) {
      throw error;
    }
    return failAfterServiceRecovery(backup, error);
  }
}
