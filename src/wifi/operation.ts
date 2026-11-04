export function acquireWifiOperation(owner: "recovery" | "settings"): (() => void) | null {
  if (heldBy !== null || (owner === "recovery" && recoveryPaused)) return null;
  heldBy = owner;
  let held = true;
  return () => {
    if (held) {
      held = false;
      heldBy = null;
    }
  };
}

export function excludeNetworkCandidates(identities: readonly string[]): void {
  excluded = new Set(identities);
}

export function networkCandidateExcluded(uuid: string): boolean {
  return excluded.has(uuid);
}

let heldBy: "recovery" | "settings" | null = null;
let excluded = new Set<string>();
let recoveryPaused = false;

export function pauseWifiRecovery(paused: boolean): void {
  recoveryPaused = paused;
}
