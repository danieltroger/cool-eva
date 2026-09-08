import { monotonicNow } from "../monotonic.ts";

// ── Parking the poller, so a multi-frame read gets a quiet bus of OUR traffic ──
//
// ⚠️ AN ACKNOWLEDGEMENT, NOT A FLAG: `holdObdPoller` resolves only once the loop has
// PARKED, because a boolean set from an HTTP handler cannot unwind a trouble-code
// transfer four retries deep. Fail-safe — a loop that never parks means a refusal, never
// a false grant. And ⚠️ THE HOLD IS CAPPED BY THE LOOP, not by the holder: a leaked one
// would take speed, rpm, the temperatures and the whole DTC list off the dashboard AND
// out of the log, with a healthy journal, on a bike where there is no reception.
//
// Why the poller is worth parking at all, why parked implies nothing of ours is in
// flight, and where the three park points are: docs/lifetime-battery-statistics.md
// § "The poller is parked, and that is the point".

/** A parked poller. Releasing twice is safe, which is what a `finally` on a retried path does. */
export interface ObdPollerHold {
  release: () => void;
}

/**
 * How long a caller may keep the poller parked before it resumes anyway.
 *
 * Sized from the work it is protecting, not picked: two components, two attempts each,
 * bounded by the transport's own first-reply and transfer timeouts, plus the session
 * opens — comfortably inside ten seconds. Past that, something is wrong with the read
 * and telemetry matters more.
 */
const MAX_HOLD_MS = 15_000;

/**
 * How long to WAIT for the loop to park before giving up.
 *
 * The worst case is one trouble-code mode in flight when the hold is asked for:
 * 5 attempts × (300 ms first reply + 400 ms transfer) + 4 × 120 ms between them =
 * 3.98 s (src/can/obd-dtc.ts). It is not the 14.2 s of a whole `pollOnce`, because the
 * loop parks between PIDs and between the three modes as well as at the top — every one
 * of those calls is awaited, so the implication above holds at all three. The common
 * case is one `requestPid` timeout, 200 ms, since 119 rounds in 120 are PIDs only.
 */
const HOLD_WAIT_MS = 6000;

let hold: {
  name: string;
  parked: boolean;
  announce: (() => void) | null;
  expiresAt: number;
  maxHoldMs: number;
} | null = null;

/**
 * Parks the 2 Hz poller and resolves once it has actually stopped, or null on timeout.
 *
 * `reason` is shown to a person, so it is a phrase: "a lifetime-statistics read".
 */
export async function holdObdPoller(
  reason: string,
  // ⚠️ Both are injectable for the same reason: scripts/check-obd-poller-hold.ts has to
  // watch the loop take the poller back, and waiting out the real cap would put fifteen
  // seconds into a suite that runs in ten. No production caller passes either.
  { waitMs = HOLD_WAIT_MS, maxHoldMs = MAX_HOLD_MS }: { waitMs?: number; maxHoldMs?: number } = {}
): Promise<ObdPollerHold | null> {
  if (hold) {
    console.warn(`obd: refusing to park for ${reason} — ${hold.name} already has it`);
    return null;
  }
  const mine = { name: reason, parked: false, announce: null as (() => void) | null, expiresAt: 0, maxHoldMs };
  hold = mine;
  const parked = await new Promise<boolean>(resolve => {
    const timer = setTimeout(() => {
      mine.announce = null;
      resolve(false);
    }, waitMs);
    timer.unref?.();
    mine.announce = () => {
      clearTimeout(timer);
      resolve(true);
    };
  });
  if (!parked) {
    hold = null;
    console.warn(`obd: the poller did not park within ${waitMs} ms — refusing ${reason}`);
    return null;
  }
  mine.expiresAt = monotonicNow() + maxHoldMs;
  console.log(`obd: parked for ${reason}`);
  return {
    release: () => {
      // Only clears the hold if it is still OURS — the same identity check
      // src/vcu/bus-lease.ts makes, for the same reason: a late release must not free
      // somebody else's.
      if (hold === mine) {
        hold = null;
        console.log(`obd: resumed after ${reason}`);
      }
    },
  };
}

/** Whether the poller is currently parked. Read at each park point. */
export function obdPollerHeldBy(): string | null {
  return hold?.name ?? null;
}

/**
 * Called at each park point. True when the caller should stop and not transmit.
 *
 * ⚠️ This is where the cap is enforced, by the loop rather than by the holder — see the
 * header. A hold past its expiry is dropped loudly and the poller carries on.
 */
export function parkedForHold(): boolean {
  if (!hold) {
    return false;
  }
  if (hold.parked && hold.expiresAt > 0 && monotonicNow() > hold.expiresAt) {
    console.warn(`obd: ${hold.name} held the poller past ${hold.maxHoldMs} ms — resuming anyway`);
    hold = null;
    return false;
  }
  if (!hold.parked) {
    hold.parked = true;
    hold.announce?.();
    hold.announce = null;
  }
  return true;
}
