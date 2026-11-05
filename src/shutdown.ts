export function installRequestedShutdown(steps: readonly ShutdownStep[]): () => boolean {
  let requested = false;
  const stop = (): void => {
    if (requested) return;
    requested = true;
    console.log("\nShutting down…");
    void finishShutdown(steps);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.on("exit", code => {
    // An unrelated timer can throw while cleanup awaits I/O. Keep Node's fatal
    // diagnostic, but never turn the operator's stop into OnFailure rollback.
    if (requested && code !== 0) {
      console.error(`shutdown: requested stop overrides exit status ${code}; the service will remain stopped.`);
      process.exitCode = 0;
    }
  });
  return () => requested;
}

export interface ShutdownStep {
  name: string;
  run: () => unknown;
  background?: boolean;
}

async function finishShutdown(steps: readonly ShutdownStep[]): Promise<void> {
  try {
    for (const step of steps) {
      const completion = attemptShutdownStep(step);
      if (!step.background) {
        await completion;
      }
    }
  } finally {
    process.exit(0);
  }
}

async function attemptShutdownStep(step: ShutdownStep): Promise<void> {
  try {
    await step.run();
  } catch (error) {
    console.error(`shutdown: ${step.name} failed; continuing cleanup:`, error);
  }
}
