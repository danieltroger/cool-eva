// What to do when a BLE session fails, as a pure decision over (message, clock).
//
// It exists because one failure is not like the others: `Operation already in
// progress` means the kernel's discovery state machine is stuck and NOTHING in
// userspace clears it — a `systemctl restart` does not, only powering the
// adapter off and on does. Every other failure here is transient and a
// power-cycle would only drop a link that was coming back.
//
// Why it takes `nowMs` instead of reading a clock: so a check can replay an
// eleven-hour episode in milliseconds. The caller passes monotonicNow().
//
// docs/ble-adapter-wedge.md has the evidence, the kernel citations and the
// experiment that established the power-cycle.

/** BlueZ btd_error_busy()'s text, relayed by node-ble as the Error message. */
export const ADAPTER_BUSY_MESSAGE = "Operation already in progress";

/** First retry spacing, and the ceiling the backoff doubles up to: 5, 10, 20, 30, 30 … */
export const RECONNECT_DELAY_MS = 5_000;
export const MAX_RECONNECT_DELAY_MS = 30_000;

/** While one message repeats, print at most one line this often — carrying the count. */
export const LOG_REPEAT_INTERVAL_MS = 60_000;

// 3 rather than 6: across the 14 wedges in the 2026-09-15..19 journal NOT ONE ever
// recovered on its own — every single one ran to the end of its boot — so waiting
// longer only buys a self-recovery that has never once happened. Not 1, because a
// single busy reply could in principle race a legitimate concurrent scan.
export const ADAPTER_RESET_AFTER_BUSY_FAILURES = 3;

// Between two power-cycles with NO successful connect in between — i.e. a remedy that
// did not work, being retried. A bounce that IS followed by a connect clears this, so
// the next wedge is a fresh event rather than a retry of a failed remedy. That is the
// constant's own semantics, and it needs no rate to justify: the floor spaces out
// retries, and a bounce a connect followed did not need retrying. Without the clause a
// second wedge would wait out the floor, and today a wedge costs the rest of the boot.
export const ADAPTER_RESET_MIN_INTERVAL_MS = 600_000;

/** Consecutive power-cycles that bought nothing before the log stops being routine. */
export const ESCALATE_AFTER_RESETS = 3;

export interface FailurePlan {
  /** Lines to print now. Empty while a repeat is being counted, never lossy. */
  logLines: string[];
  /** How long to wait before the next session attempt. */
  delayMs: number;
  /** Power-cycle the adapter before that wait. */
  resetAdapter: boolean;
}

export class BleRetryPolicy {
  private consecutiveFailures = 0;
  private consecutiveBusyFailures = 0;
  private resetsSinceConnect = 0;
  private lastResetAtMs: number | null = null;
  private repeatingMessage: string | null = null;
  private repeatCount = 0;
  private windowStartedAtMs = 0;

  /** A session that got past startDiscovery() and connected: the adapter demonstrably works. */
  onSessionConnected(nowMs: number): string[] {
    const lines = this.flush(nowMs);
    this.consecutiveFailures = 0;
    this.consecutiveBusyFailures = 0;
    this.resetsSinceConnect = 0;
    this.lastResetAtMs = null;
    return lines;
  }

  /**
   * @param hubObjectNote what BlueZ still knew about the hub, when the caller probed.
   *        Observation only — it never changes the decision.
   */
  onFailure(message: string, nowMs: number, hubObjectNote?: string | null): FailurePlan {
    const isBusy = message === ADAPTER_BUSY_MESSAGE;
    this.consecutiveFailures += 1;
    this.consecutiveBusyFailures = isBusy ? this.consecutiveBusyFailures + 1 : 0;

    const logLines: string[] = [];
    if (message !== this.repeatingMessage) {
      logLines.push(...this.flush(nowMs));
      this.repeatingMessage = message;
      this.repeatCount = 0;
      this.windowStartedAtMs = nowMs;
      logLines.push(`ble: session failed: ${message}${hubObjectNote ? ` — ${hubObjectNote}` : ""}`);
    } else if (nowMs - this.windowStartedAtMs >= LOG_REPEAT_INTERVAL_MS) {
      // The flush carries the suppressed ones AND stands as this failure's own line. If
      // nothing was suppressed it returns nothing, and then this failure would be neither
      // printed nor counted — which is how a session that takes longer to fail than the
      // window is wide goes completely silent. So fall back to printing it plainly.
      const flushed = this.flush(nowMs);
      this.repeatingMessage = message;
      this.windowStartedAtMs = nowMs;
      logLines.push(...(flushed.length > 0 ? flushed : [`ble: session failed: ${message}`]));
    } else {
      this.repeatCount += 1;
    }

    const resetAdapter = this.shouldResetAdapter(nowMs);
    if (resetAdapter) {
      this.lastResetAtMs = nowMs;
      this.resetsSinceConnect += 1;
      this.consecutiveBusyFailures = 0;
      logLines.push(
        this.resetsSinceConnect >= ESCALATE_AFTER_RESETS
          ? `ble: ${this.resetsSinceConnect} adapter power-cycles have not cleared this and no connect has ` +
              "succeeded since. Only a reboot is known to clear it; this process will keep trying."
          : "ble: adapter looks wedged — power-cycling it before the next attempt"
      );
    }

    return { logLines, delayMs: this.nextDelayMs(), resetAdapter };
  }

  /** Emit any counted-but-unprinted repeat. Called on connect, on stop, and before a new message. */
  flush(nowMs: number): string[] {
    if (this.repeatingMessage === null || this.repeatCount === 0) {
      this.repeatingMessage = null;
      this.repeatCount = 0;
      return [];
    }
    const seconds = Math.round((nowMs - this.windowStartedAtMs) / 1000);
    const line = `ble: session failed: ${this.repeatingMessage} (×${this.repeatCount} more in the last ${seconds} s)`;
    this.repeatingMessage = null;
    this.repeatCount = 0;
    return [line];
  }

  private shouldResetAdapter(nowMs: number): boolean {
    if (this.consecutiveBusyFailures < ADAPTER_RESET_AFTER_BUSY_FAILURES) {
      return false;
    }
    // Cleared by onSessionConnected(), so the floor only ever spaces out bounces that did
    // NOT work. A bounce followed by a connect did its job, and the next wedge is a fresh
    // event rather than a retry of a failed remedy. Testing resetsSinceConnect here as
    // well used to say the same thing twice, which made deleting either an equivalent
    // mutant — two mechanisms where the rule needs one.
    if (this.lastResetAtMs === null) {
      return true;
    }
    return nowMs - this.lastResetAtMs >= ADAPTER_RESET_MIN_INTERVAL_MS;
  }

  private nextDelayMs(): number {
    const doubled = RECONNECT_DELAY_MS * 2 ** (this.consecutiveFailures - 1);
    return Math.min(doubled, MAX_RECONNECT_DELAY_MS);
  }
}

/**
 * What BlueZ still knows about the hub, for the journal only.
 *
 * ⚠️ NEVER THROWS, and that is the whole contract. It runs on the path that has just
 * failed with the busy reply, and the message that reaches BleRetryPolicy has to stay
 * that reply — a throw escaping here would replace it and silently disarm the reset.
 */
export async function describeKnownHub(
  listAddresses: () => Promise<string[]>,
  readName: (address: string) => Promise<string>,
  namePattern: RegExp
): Promise<string> {
  let addresses: string[];
  try {
    addresses = await listAddresses();
  } catch (error) {
    return `could not ask BlueZ for known devices: ${(error as Error).message}`;
  }

  let unreadable = 0;
  let lastNameError = "";
  for (const address of addresses) {
    try {
      if (namePattern.test(await readName(address))) {
        return `BlueZ still holds the hub's device object (${addresses.length} known)`;
      }
    } catch (error) {
      unreadable += 1;
      lastNameError = (error as Error).message;
    }
  }
  const unread = unreadable > 0 ? `, ${unreadable} unreadable: ${lastNameError}` : "";
  return `BlueZ holds no hub-named device (${addresses.length} known${unread})`;
}
