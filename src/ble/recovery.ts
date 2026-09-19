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

/**
 * BlueZ btd_error_busy()'s text, relayed by node-ble as the Error message.
 *
 * ⚠️ The TEXT and not the D-Bus error NAME, and that is not laziness. `btd_error_busy()`
 * and `btd_error_in_progress()` both raise `org.bluez.Error.InProgress`; only the text
 * separates a wedged adapter from a pending `Device1.Connect()`, so the name cannot gate
 * this. docs/ble-adapter-wedge.md § "It is not the hub, and not a pending `Connect()`".
 */
export const ADAPTER_BUSY_MESSAGE = "Operation already in progress";

/** The D-Bus error name both of those share — used only to notice a text we do not know. */
const IN_PROGRESS_ERROR_NAME = "org.bluez.Error.InProgress";

/**
 * Is this the wedged adapter? dbus-next rejects with a DBusError carrying `.type`, and
 * node-ble re-rejects it unwrapped, so the name survives to here.
 *
 * ⚠️ An `InProgress` we cannot classify is reported LOUDLY rather than treated as "not
 * busy". Silence there is the whole fix disarming itself on a BlueZ that reworded the
 * string, with every check still green — exactly what the never-swallow rule is for.
 */
export function isAdapterBusy(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (message === ADAPTER_BUSY_MESSAGE) {
    return true;
  }
  const name = (error as { type?: unknown } | null)?.type;
  if (name === IN_PROGRESS_ERROR_NAME) {
    console.warn(
      `ble: ${IN_PROGRESS_ERROR_NAME} with text this build does not recognise: "${message}". ` +
        "The adapter power-cycle is gated on the text and will NOT fire — docs/ble-adapter-wedge.md."
    );
  }
  return false;
}

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
  private lastResetAtMs = -Infinity;
  private repeatingMessage: string | null = null;
  private repeatCount = 0;
  private windowStartedAtMs = 0;

  /** A session that got past startDiscovery() and connected: the adapter demonstrably works. */
  onSessionConnected(nowMs: number): string[] {
    const lines = this.flush(nowMs);
    this.consecutiveFailures = 0;
    this.consecutiveBusyFailures = 0;
    this.resetsSinceConnect = 0;
    this.lastResetAtMs = -Infinity;
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
    const messageChanged = message !== this.repeatingMessage;
    if (!messageChanged && nowMs - this.windowStartedAtMs < LOG_REPEAT_INTERVAL_MS) {
      this.repeatCount += 1;
    } else {
      const flushed = this.flush(nowMs);
      logLines.push(...flushed);
      // A count line stands in for this failure's own line only while the message is
      // unchanged. A new message must always print, and a window that elapsed with nothing
      // suppressed would otherwise go completely silent — which is how a session slower to
      // fail than the window is wide reports nothing at all.
      if (messageChanged || flushed.length === 0) {
        const note = messageChanged && hubObjectNote ? ` — ${hubObjectNote}` : "";
        logLines.push(`ble: session failed: ${message}${note}`);
      }
      this.repeatingMessage = message;
      this.windowStartedAtMs = nowMs;
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
    const message = this.repeatingMessage;
    const count = this.repeatCount;
    this.repeatingMessage = null;
    this.repeatCount = 0;
    if (count === 0) {
      return [];
    }
    const seconds = Math.round((nowMs - this.windowStartedAtMs) / 1000);
    return [`ble: session failed: ${message} (×${count} more in the last ${seconds} s)`];
  }

  private shouldResetAdapter(nowMs: number): boolean {
    // Reset to -Infinity by onSessionConnected(), so the floor only ever spaces out bounces
    // that did NOT work. A bounce followed by a connect did its job, and the next wedge is a
    // fresh event rather than a retry of a failed remedy. Testing resetsSinceConnect here as
    // well used to say the same thing twice, which made deleting either an equivalent
    // mutant — two mechanisms where the rule needs one.
    return (
      this.consecutiveBusyFailures >= ADAPTER_RESET_AFTER_BUSY_FAILURES &&
      nowMs - this.lastResetAtMs >= ADAPTER_RESET_MIN_INTERVAL_MS
    );
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
