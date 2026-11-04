export function printInstallationFailure(error: unknown, log: (...values: unknown[]) => void = console.error): void {
  log(
    "Setup incomplete:",
    error instanceof SyntaxError
      ? "Stored configuration could not be read."
      : error instanceof Error
        ? error.message
        : "Check the service log."
  );
  if (error instanceof MigrationNeedsHelpError) {
    log(
      "Migration failure in the existing service:",
      error.cause instanceof SyntaxError
        ? "Stored configuration could not be read."
        : error.cause instanceof Error
          ? error.cause.message
          : "unknown error"
    );
  }
  log(installationFailureAdvice(error));
}

export class MigrationNeedsHelpError extends Error {}

export function installationFailureAdvice(error: unknown): string {
  return error instanceof MigrationNeedsHelpError
    ? "No ride data was removed. Stop and ask for help; keep the migration service in place and do not keep rerunning setup."
    : "No ride data was removed. Keep bench power on and paste the same setup line to retry.";
}
