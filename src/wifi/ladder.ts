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
   * No saved profile carries the configured SSID, so nothing was attempted.
   *
   * ⚠️ This is the ONLY non-attempt. It used to also cover "the refreshed scan did not
   * show the hotspot", which quietly relabelled a real failed activation — one that DID
   * reach the auth path and DID spend `connection.auth-retries` — as a range problem.
   */
  NO_PROFILE: 4,
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
  /**
   * Fault time ACCUMULATED, not wall time since it began.
   *
   * 🚨 It was `faultSince` and a subtraction, and that silently banked every second the
   * clock was supposed to be suspending: a bike parked three hours out of range came back
   * holding 10 808 000 ms and fired a ladder on the first poll the hotspot reappeared —
   * racing NetworkManager's own autoconnect, which is precisely what the suspend arm
   * exists to prevent. Time can only be added between two CONSECUTIVE fault polls.
   */
  heldMs: number;
  /** Whether the most recent poll was in the fault shape. */
  inFault: boolean;
  /** Monotonic instant of the last fold, so a delta can be taken. */
  lastPollAt: number | null;
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
  return { heldMs: 0, inFault: false, lastPollAt: null, connectedPolls: 0, attempts: 0, lastAttemptAt: null };
}

export interface PollReading {
  linkState: WifiLinkState | null;
  hotspotSeen: boolean;
  nowMs: number;
}

/**
 * Folds one poll into the fault clock.
 *
 * Three states, told apart: CONNECTED ends the fault, the fault shape accrues time, and
 * everything else — out of range, radio unavailable, an activation of ours in flight —
 * SUSPENDS it: the total is kept, none is added. docs/wifi.md §4 has why each arm exists.
 */
export function foldPoll(clock: FaultClock, reading: PollReading): FaultClock {
  const base = { ...clock, lastPollAt: reading.nowMs };
  if (reading.linkState === WIFI_LINK_STATE.CONNECTED) {
    const connectedPolls = clock.connectedPolls + 1;
    const forgiven = connectedPolls >= CONNECTED_POLLS_TO_FORGIVE;
    return {
      ...base,
      heldMs: 0,
      inFault: false,
      connectedPolls,
      // Forgiven only once the link has held. See CONNECTED_POLLS_TO_FORGIVE.
      attempts: forgiven ? 0 : clock.attempts,
      lastAttemptAt: forgiven ? null : clock.lastAttemptAt,
    };
  }
  if (reading.linkState === WIFI_LINK_STATE.DISCONNECTED && reading.hotspotSeen) {
    // ⚠️ Only between two CONSECUTIVE fault polls. Adding the gap from a poll that was
    // NOT in fault would bank the suspension it is meant to skip.
    const elapsed = clock.inFault && clock.lastPollAt !== null ? reading.nowMs - clock.lastPollAt : 0;
    return { ...base, heldMs: clock.heldMs + elapsed, inFault: true, connectedPolls: 0 };
  }
  // Suspended: out of range, radio unavailable, or an activation of ours in flight. The
  // accumulated time is KEPT — the fault has not ended — but none is added.
  return { ...base, inFault: false, connectedPolls: 0 };
}

/**
 * Whether the watchdog should run the ladder now.
 *
 * Two independent gates: the fault must have held past the threshold at all, and the
 * backoff since the last attempt must have elapsed.
 */
export function shouldRecoverNow(clock: FaultClock, nowMs: number, faultAfterMs: number): boolean {
  // 🚨 THE CURRENT POLL MUST BE IN THE FAULT, not merely some earlier one. Without this a
  // bike that went out of range after a fault kept qualifying for ever: the accumulated
  // time never falls, so the backoff alone paced it and a 24-hour absence produced 98
  // ladder runs against a radio that had nothing to join.
  if (!clock.inFault || clock.heldMs < faultAfterMs) {
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
    return { rejoin: confirmed, arm: !confirmed };
  }
  return { rejoin: true, arm: false };
}

/** Everything one hold can do. */
export const HOLD_ACTION = {
  /** The bike is not proven stopped, so nothing happens at all. */
  REFUSED: "refused",
  /** Dump and arm the confirm window; the link is left alone. */
  DUMP_ONLY: "dump-only",
  /** Dump and run the ladder. */
  RECOVER: "recover",
} as const;

export type HoldAction = (typeof HOLD_ACTION)[keyof typeof HOLD_ACTION];

/**
 * The WHOLE of what a hold decides, in one pure function.
 *
 * 🚨 The speed gate lives HERE and not at the call site. It was inlined in the impure
 * hold, and a mutation replacing it with `if (false)` — a gesture that acts at any speed
 * — left every assertion green, because nothing could drive the branch. Extracting the
 * predicate alone was not enough: the CALL to it was still unreachable.
 */
export function decideHold(
  speedKmh: number | null,
  linkState: WifiLinkState | null,
  msSinceArmed: number | null,
  stopped: (speed: number | null) => boolean
): { action: HoldAction; arm: boolean } {
  if (!stopped(speedKmh)) {
    return { action: HOLD_ACTION.REFUSED, arm: false };
  }
  const decision = decideGesture(linkState, msSinceArmed);
  return {
    action: decision.rejoin ? HOLD_ACTION.RECOVER : HOLD_ACTION.DUMP_ONLY,
    arm: decision.arm,
  };
}
