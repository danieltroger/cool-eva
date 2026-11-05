export function printInstallationFailure(error: unknown, log: (...values: unknown[]) => void = console.error): void {
  log(
    "Setup incomplete:",
    error instanceof SyntaxError
      ? "Stored configuration could not be read."
      : error instanceof Error
        ? error.message
        : "Check the service log."
  );
  if (error instanceof MigrationNeedsHelpError || error instanceof ServiceRecoveryError) {
    log(
      error instanceof MigrationNeedsHelpError
        ? "Migration failure in the existing service:"
        : "Original setup failure:",
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

export class ServiceRestoredError extends Error {
  constructor(cause: unknown) {
    super(
      cause instanceof SyntaxError
        ? "Stored configuration could not be read."
        : cause instanceof Error
          ? cause.message
          : "Setup could not finish.",
      { cause }
    );
  }
}

export class ServiceRecoveryError extends Error {
  service: string;
  constructor(service: string, options: ErrorOptions) {
    super("Setup failed and a running app could not be restored or confirmed.", options);
    this.service = service;
  }
}

export function installationFailureAdvice(error: unknown): string {
  if (error instanceof ServiceRestoredError) {
    return "No ride data was removed. A service is running again. Setup did not finish; keep bench power on and paste the same setup line to resume.";
  }
  if (error instanceof ServiceRecoveryError) {
    const service = error.service;
    return `No ride data was removed. Treat the app as STOPPED: its running state could not be confirmed. Keep bench power on. In SSH run sudo systemctl daemon-reload, then sudo systemctl start ${service}. If it does not stay running, stop and ask for help with journalctl -u ${service}.`;
  }
  return error instanceof MigrationNeedsHelpError
    ? "No ride data was removed. The app may be STOPPED for data safety. Stop and ask for help; keep the migration service in place and do not keep rerunning setup."
    : "No ride data was removed. Keep bench power on and paste the same setup line to retry.";
}
