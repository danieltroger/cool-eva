import { monotonicNow } from "../monotonic.ts";

export function createTransmitFailureLogger(
  sender: string,
  now: () => number = monotonicNow
): (message: string, error: unknown) => void {
  const state: TransmitLogState = { lastLoggedAt: -Infinity, suppressed: 0 };
  return (message, error) => logFailure(state, sender, now(), message, error);
}

const LOG_INTERVAL_MS = 5000;

interface TransmitLogState {
  lastLoggedAt: number;
  suppressed: number;
}

function logFailure(state: TransmitLogState, sender: string, now: number, message: string, error: unknown): void {
  if (now - state.lastLoggedAt < LOG_INTERVAL_MS) {
    state.suppressed += 1;
    return;
  }
  const suppressed = state.suppressed > 0 ? ` (${state.suppressed} transmit failures suppressed)` : "";
  console.error(`${sender}: ${message}${suppressed}`, error);
  state.lastLoggedAt = now;
  state.suppressed = 0;
}
