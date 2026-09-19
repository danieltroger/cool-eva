import { WIFI_LINK_STATE, type WifiLinkState } from "./parse.ts";

// When to try to recover the wifi, and what to try. Pure the way ./parse.ts is pure:
// every clock it reasons about is passed in, so scripts/check-wifi-recover.ts walks the
// whole escalation with no radio and no nmcli. ./recover.ts is the half that acts.
//
// The failure this exists for is in docs/wifi.md: NetworkManager latched the hotspot
// profile out of autoconnect and stopped trying, for twenty minutes, mid-charge.

/** Why a recovery ran, which decides how far it is allowed to go. */
export const RECOVER_TRIGGER = {
  /** The poller saw the fault hold. */
  WATCHDOG: "watchdog",
  /** A thumb on the handlebar. */
  GESTURE: "gesture",
} as const;

export type RecoverTrigger = (typeof RECOVER_TRIGGER)[keyof typeof RECOVER_TRIGGER];

/** What `wifi_rejoin_outcome` carries. A code, because a signal is a number. */
export const REJOIN_OUTCOME = {
  NONE: 0,
  /** The link was up and the hold did not touch it. */
  DUMP_ONLY: 1,
  /** Activation succeeded. */
  REJOINED: 2,
  /** Activation was attempted and did not take. */
  FAILED: 3,
  /**
   * The hotspot was not in the refreshed scan, so nothing was attempted.
   *
   * ⚠️ Its own code rather than FAILED, because the two spend different resources:
   * `ssid-not-found` never reaches NetworkManager's auth path, so it cannot consume the
   * `connection.auth-retries` budget whose exhaustion is what creates the latch.
   */
  NOT_IN_RANGE: 4,
} as const;

export type RejoinOutcome = (typeof REJOIN_OUTCOME)[keyof typeof REJOIN_OUTCOME];

/**
 * The backoff between attempts, in minutes, and the last entry repeats for ever.
 *
 * ⚠️ A SAFETY PROPERTY, not politeness. Every activation attempt that reaches an
 * association failure spends one of the profile's `connection.auth-retries`, and running
 * that budget to zero is precisely what raises `NO_SECRETS` and latches the profile
 * (docs/wifi.md §1). An over-eager watchdog would therefore *create* the fault it exists
 * to escape. It cannot run away: the last step repeats rather than growing.
 */
export const REJOIN_BACKOFF_MINUTES = [2, 4, 8, 15] as const;

/**
 * How many consecutive polls a connection must hold before the backoff is forgiven.
 *
 * ⚠️ Two, and NOT one. A single poll of CONNECTED can be a flap — the link comes up,
 * DHCP fails, it drops again — and forgiving on one would pin the backoff at its 2-minute
 * floor for the whole of a flapping episode, which is the shape of trouble most likely to
 * be flapping in the first place.
 */
export const CONNECTED_POLLS_TO_FORGIVE = 2;

export interface FaultClock {
  /** Monotonic instant the current fault began, or null when there is no fault. */
  faultSince: number | null;
  /** How many consecutive polls have read CONNECTED. */
  connectedPolls: number;
  /**
   * How many attempts this fault episode has made.
   *
   * ⚠️ A COUNT, not an index into REJOIN_BACKOFF_MINUTES, and the difference is a real
   * off-by-one: the wait owed after the FIRST attempt is the FIRST entry, so the index is
   * `attempts - 1`. Storing the index directly made the first attempt owe the second wait.
   */
  attempts: number;
  /** Monotonic instant of the last attempt, or null. */
  lastAttemptAt: number | null;
}

export function newFaultClock(): FaultClock {
  return { faultSince: null, connectedPolls: 0, attempts: 0, lastAttemptAt: null };
}

export interface PollReading {
  linkState: WifiLinkState | null;
  hotspotSeen: boolean;
  nowMs: number;
}

/**
 * Folds one poll into the fault clock.
 *
 * ⚠️ THE CLOCK AND THE BACKOFF ARE CLEARED BY DIFFERENT THINGS, and an earlier draft
 * used one rule for both. Three states have to be told apart:
 *
 *   • CONNECTED — the fault is over, so the clock clears immediately;
 *   • the fault shape (disconnected AND the hotspot in range) — the clock runs;
 *   • anything else (out of range, radio unavailable, mid-activation) — the clock is
 *     SUSPENDED, neither running nor cleared.
 *
 * That third case is the one that bites. A bike parked out of range would otherwise bank
 * fault time it never spent trying, and fire a ladder on the first poll the hotspot
 * reappeared — racing NetworkManager's own autoconnect, which recovers in seconds.
 * Our own `connection up` also lands here, as CONNECTING, so an attempt cannot reset the
 * clock that paces attempts.
 */
export function foldPoll(clock: FaultClock, reading: PollReading): FaultClock {
  if (reading.linkState === WIFI_LINK_STATE.CONNECTED) {
    const connectedPolls = clock.connectedPolls + 1;
    return {
      faultSince: null,
      connectedPolls,
      // Forgiven only once the link has held. See CONNECTED_POLLS_TO_FORGIVE.
      attempts: connectedPolls >= CONNECTED_POLLS_TO_FORGIVE ? 0 : clock.attempts,
      lastAttemptAt: connectedPolls >= CONNECTED_POLLS_TO_FORGIVE ? null : clock.lastAttemptAt,
    };
  }
  if (reading.linkState === WIFI_LINK_STATE.DISCONNECTED && reading.hotspotSeen) {
    return { ...clock, connectedPolls: 0, faultSince: clock.faultSince ?? reading.nowMs };
  }
  return { ...clock, connectedPolls: 0 };
}

/** How long the fault has held, or null if there is no fault running. */
export function faultHeldMs(clock: FaultClock, nowMs: number): number | null {
  return clock.faultSince === null ? null : nowMs - clock.faultSince;
}

/**
 * Whether the watchdog should run the ladder now.
 *
 * Two independent gates: the fault must have held past the threshold at all, and the
 * backoff since the last attempt must have elapsed.
 */
export function shouldRecoverNow(clock: FaultClock, nowMs: number, faultAfterMs: number): boolean {
  const held = faultHeldMs(clock, nowMs);
  if (held === null || held < faultAfterMs) {
    return false;
  }
  if (clock.lastAttemptAt === null) {
    return true;
  }
  return nowMs - clock.lastAttemptAt >= backoffMs(clock.attempts - 1);
}

/** The wait owed after the attempt at `step`. The last entry repeats. */
export function backoffMs(step: number): number {
  const index = Math.min(Math.max(step, 0), REJOIN_BACKOFF_MINUTES.length - 1);
  return REJOIN_BACKOFF_MINUTES[index] * 60_000;
}

/** Records that an attempt just ran, so the next one waits longer. */
export function afterAttempt(clock: FaultClock, nowMs: number): FaultClock {
  return { ...clock, lastAttemptAt: nowMs, attempts: clock.attempts + 1 };
}

export interface GestureDecision {
  /** Always true: a hold that writes nothing tells the rider nothing. */
  dump: true;
  /** Whether this hold also touches the radio. */
  rejoin: boolean;
  /** Whether it arms the confirm window for a second hold. */
  arm: boolean;
}

/**
 * How long a first hold's confirmation stays valid.
 *
 * A chosen number and not a measured one — long enough to make two deliberate holds
 * without hurrying, short enough that an arm cannot survive into a later stop.
 */
export const REJOIN_CONFIRM_WINDOW_MS = 60_000;

/**
 * What a hold does, given what the link is doing.
 *
 * ⚠️ THE RULE: a hold ALWAYS dumps. While the link is UP it does nothing else — the
 * first hold arms a window, and only a second hold inside that window touches the radio.
 * While the link is DOWN there is nothing to lose, so the first hold recovers.
 *
 * The window exists for exactly one case: a curious hold while the rider is watching a
 * working dashboard must not drop the link they are watching it on.
 */
export function decideGesture(linkState: WifiLinkState | null, msSinceArmed: number | null): GestureDecision {
  if (linkState === WIFI_LINK_STATE.CONNECTED) {
    const confirmed = msSinceArmed !== null && msSinceArmed < REJOIN_CONFIRM_WINDOW_MS;
    return { dump: true, rejoin: confirmed, arm: !confirmed };
  }
  return { dump: true, rejoin: true, arm: false };
}
