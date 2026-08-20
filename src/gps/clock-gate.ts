// Whether a satellite time is trustworthy enough to step the system clock to.
//
// Pure: every clock it reasons about is passed in, so this decides without reading
// a clock, spawning `date`, or touching the filesystem. That is what lets
// scripts/check-gps-clock.ts replay real sequences out of rides.db through the very
// code the Pi runs. src/gps/clock.ts is the I/O half.
//
// It exists because one corrupt frame used to cost five minutes of corrupt
// timestamps: #decodeUtc accepted any two-digit year, so a field reading 60 decoded
// to 2060, the clock stepped 34 years forward, and MIN_SECONDS_BETWEEN_STEPS — there
// to stop thrashing — then blocked the correction that would have undone it. 49 772
// rows in rides.db are stamped 2060 because of four such frames.
//
// ⚠️ TWO FIXES THAT LOOK OBVIOUS AND ARE BOTH WRONG, so neither is here:
//   • A YEAR CEILING ("2024 to 2035", say) is a fix with an expiry date and the bike
//     will outlive it. Every rule below is either a FLOOR (GPS_UTC_FLOOR_EPOCH_S in
//     ./decode.ts, which only ever becomes more conservative) or a comparison against
//     a clock that advances on its own. A frame claiming 2060 is rejected because no
//     other frame agrees with it, not because 2060 is a year we decided to disbelieve.
//   • A MINIMUM SATELLITE COUNT does not discriminate: the four corrupt frames read
//     10, 9 and (no sample within 15 s) twice, against a population where 41 % of all
//     readings are BELOW 8. The corruption is a single mangled frame in an otherwise
//     healthy stream, not a weak fix. The floor of 4 in #decodeUtc stays, but as a
//     sanity check on the receiver. Corroboration is the defence.
//
// The measurements behind all of that: docs/diagnostics-and-checks.md §8.

import { GPS_UTC_FLOOR_EPOCH_S } from "./decode.ts";

/**
 * How far the system clock may be from satellite time before we step it. Unchanged
 * from the original module: below a minute the step is not worth the disruption a
 * jumping wall clock causes everything that stamps a row with it.
 */
export const DRIFT_THRESHOLD_SECONDS = 60;

/**
 * Anti-thrash: don't fight systemd-timesyncd for the clock once the network is back,
 * and don't restamp the DB every few seconds. Unchanged — but see
 * COOLDOWN_OVERRIDE_SECONDS, which is what stops it from also blocking recovery.
 */
export const MIN_SECONDS_BETWEEN_STEPS = 300;

/**
 * A disagreement this large is not thrashing, so the cooldown does not apply to it.
 *
 * This is the half of the fix that limits the damage when the other half is beaten.
 * The cooldown exists to stop a tug-of-war with timesyncd over fractions of a second;
 * timesyncd never leaves the clock an hour out, so an hour of disagreement can only
 * mean the clock itself is wrong — a bad step, or a cold boot with a stale date. In
 * that state, waiting out the cooldown is exactly the wrong thing: it is what turned
 * one corrupt frame into 299.9 s and 501.5 s of corrupt rows.
 *
 * An hour rather than something tighter because a legitimate, correctly corroborated
 * cold-boot step is routinely far larger than that (the log has 20 h 46 m and 20 h 38 m),
 * and those must not be made to wait either.
 */
export const COOLDOWN_OVERRIDE_SECONDS = 3600;

/**
 * How many readings must agree before we act on any of them.
 *
 * The corruption in the log is always a single frame: at each of the four, the frames
 * immediately either side carry sane time advancing at one second per second, and the
 * stream is back to normal within one frame (0.54 s and 0.55 s at the two where the
 * clock did not step and the following rows are still readable). Two consecutively
 * corrupt frames have never been seen, let alone five that agree with each other.
 *
 * 5 is cheap. gps_epoch_s rows arrive with a median gap of 1.097 s from one transport,
 * and both CAN 0x410 and BLE feed this gate, so five readings cost between 1.4 s and
 * 5 s of a cold boot. Set against a Pi that has just booted with a nonsense date, that
 * is nothing.
 */
export const REQUIRED_CONSISTENT_READINGS = 5;

/**
 * How far two readings may disagree about how much time passed between them.
 *
 * 3 s, because the worst observed transport jitter is 2.1 s (CAN and BLE deliver the
 * same fix milliseconds apart and their seconds field can differ by one) and the
 * corrupt frames disagree with their neighbours by around 1.06e9 s. There is no value
 * between "transport jitter" and "34 years" to be careful about.
 *
 * ⚠️ READ THE MARGIN CAREFULLY: the percentiles behind that 2.1 s are PER PAIR, but
 * the rule is the worst of the whole window against its newest reading — one reading
 * over the line kills the window, so the real headroom is 0.9 s, not the 2.5 s the
 * median and p90 suggest. If the transports ever drift further apart this is the
 * constant that gives, and it gives by refusing to sync at all, which is why
 * `inconsistent-readings` is warned about. Distributions: the doc's §8.4.
 */
export const CONSISTENCY_TOLERANCE_SECONDS = 3;

/**
 * Readings older than this are dropped from the window, so corroboration cannot be
 * assembled out of five readings taken minutes apart. At the observed rate a full
 * window spans 1.4–5 s, so this is ~6× the room it needs.
 */
export const READING_WINDOW_MAX_AGE_MS = 30_000;

/**
 * How long a known-good satellite time stays authoritative without being reconfirmed.
 *
 * It has to expire, or a session that once had a good time could never re-establish
 * one and would be locked out of correcting itself forever. Ten minutes of GPS
 * silence (a garage, a tunnel, a hub that stopped talking) is long enough that we
 * would rather re-derive the time from scratch than keep projecting a stale anchor.
 *
 * ⚠️ DELIBERATELY NOT EQUAL TO MIN_SECONDS_BETWEEN_STEPS. They were both 300 by
 * accident, which meant the anchor's life and the anti-thrash cooldown expired in
 * lockstep and the cooldown damped nothing at exactly the period the expiry can
 * generate. Keeping this at least twice the cooldown means a flip always costs a full
 * cooldown as well as a full anchor life.
 */
export const KNOWN_GOOD_MAX_AGE_MS = 600_000;

/**
 * How many consecutive agreeing readings it takes to displace an anchor that expired
 * while being CONTRADICTED, rather than while starved of readings.
 *
 * ⚠️ The two are not the same event and must not cost the same. An anchor that went
 * stale because something spent ten minutes disagreeing with it is a fight between
 * two sources, and letting whichever one happens to be present at the moment of
 * expiry win by default makes the clock an oscillator: adopt A, refuse B for an
 * anchor life, adopt B, refuse A for an anchor life, forever. So the contradicting
 * time has to work harder, not less hard. 30 readings is 8–30 s of unbroken agreement
 * at the measured rates — nothing to a genuinely new correct time, and out of reach
 * of the sporadic single-frame corruption this bike produces.
 */
export const READINGS_TO_DISPLACE_CONTESTED_ANCHOR = 30;

/**
 * Once we hold a fresh known-good time, how far a new candidate may sit from that
 * anchor projected forward by monotonic elapsed time.
 *
 * Within one process the satellite clock cannot legitimately jump: it advances with
 * monotonic time whether the bike is riding or parked. So this bound is generous at 10
 * s — it covers the 1 s transport jitter, the second-level quantisation of the field
 * and any crystal drift over KNOWN_GOOD_MAX_AGE_MS — while still being eight orders of
 * magnitude short of the 34-year jump it exists to refuse.
 *
 * Note this constrains the CANDIDATE against satellite time, never against the system
 * clock. A wall clock that some other process has just wrecked still gets corrected.
 */
export const KNOWN_GOOD_TOLERANCE_SECONDS = 10;

/** Why the gate did or did not ask for a step. Logged verbatim, so keep them readable. */
export type ClockStepVerdict =
  | { step: true; epochSeconds: number; offsetSeconds: number; reason: "cold-boot" | "drift" | "clock-implausible" }
  | {
      step: false;
      reason:
        | "not-a-time"
        | "before-floor"
        | "awaiting-corroboration"
        | "inconsistent-readings"
        | "disagrees-with-known-good"
        | "in-agreement"
        | "cooling-down";
      detail: string;
    };

interface TimeReading {
  epochSeconds: number;
  monotonicMs: number;
}

/**
 * Decides whether a satellite time may be stepped to. One instance per process: it
 * carries the corroboration window and the known-good anchor across frames, the same
 * way GpsMessageDecoder carries a half-assembled fix across sub-frames.
 *
 * Both transports feed the same instance on purpose. A frame that CAN and BLE both
 * delivered is two readings that agree, which is exactly what corroboration wants.
 */
export class GpsClockGate {
  #window: TimeReading[] = [];
  #knownGood: TimeReading | undefined;
  #lastStepAtMonotonicMs: number | undefined;
  /** Consecutive readings that have agreed, uncapped — the window is capped, this is not. */
  #consecutiveConsistent = 0;
  /**
   * Whether the anchor we are currently without went stale while something was actively
   * contradicting it, as opposed to while nothing was arriving at all. Latched when a
   * contradiction is refused and cleared when a time is finally adopted, so it survives
   * the expiry it exists to qualify.
   */
  #anchorWasContested = false;

  /**
   * Offers one satellite time to the gate.
   *
   * @param epochSeconds satellite UTC from this frame, as decoded
   * @param systemEpochSeconds what the system clock says right now (`Date.now() / 1000`)
   * @param monotonicMs when this reading arrived, from `monotonicNow()` — NOT the wall
   *   clock, which is the thing being corrected and jumps under us mid-sequence
   */
  offer(epochSeconds: number, systemEpochSeconds: number, monotonicMs: number): ClockStepVerdict {
    // NaN fails every comparison below, including `disagreement > tolerance`, so it
    // would sail through corroboration rather than be caught by it. ./decode.ts cannot
    // currently produce one — Date.UTC only returns NaN past year 275760 and the field
    // is 7 bits — but this is a public entry point and the failure mode is silent
    // acceptance, which is the one thing this module must never do.
    if (!Number.isFinite(epochSeconds)) {
      return { step: false, reason: "not-a-time", detail: `${epochSeconds} is not a satellite time` };
    }

    // Below the floor there is nothing to corroborate: a fix from before this code
    // existed is not a fix. Keeping it out of the window also stops a receiver stuck
    // in a week-rollover 1999 from corroborating itself.
    if (epochSeconds < GPS_UTC_FLOOR_EPOCH_S) {
      return {
        step: false,
        reason: "before-floor",
        detail: `${new Date(epochSeconds * 1000).toISOString()} predates this software`,
      };
    }

    this.#window.push({ epochSeconds, monotonicMs });
    this.#window = this.#window.filter(reading => monotonicMs - reading.monotonicMs <= READING_WINDOW_MAX_AGE_MS);
    if (this.#window.length > REQUIRED_CONSISTENT_READINGS) {
      this.#window = this.#window.slice(-REQUIRED_CONSISTENT_READINGS);
    }

    // "Still filling" and "full but contradicting itself" are different events and used
    // to share a reason, which put the exact thing this module exists to catch — a
    // window holding a reading 34 years out — at the same log level as ordinary
    // start-up. Split, so ./clock.ts can warn about one and not the other.
    const needed = this.#anchorWasContested ? READINGS_TO_DISPLACE_CONTESTED_ANCHOR : REQUIRED_CONSISTENT_READINGS;
    const disagreement = worstDisagreementSeconds(this.#window, epochSeconds, monotonicMs);
    if (disagreement > CONSISTENCY_TOLERANCE_SECONDS) {
      this.#consecutiveConsistent = 1;
      return {
        step: false,
        reason: "inconsistent-readings",
        detail:
          `${this.#window.length} readings in the window disagree by up to ${disagreement.toFixed(3)} s ` +
          `(limit ${CONSISTENCY_TOLERANCE_SECONDS} s) — one of them is not a real time`,
      };
    }
    this.#consecutiveConsistent += 1;
    if (this.#window.length < REQUIRED_CONSISTENT_READINGS || this.#consecutiveConsistent < needed) {
      return {
        step: false,
        reason: "awaiting-corroboration",
        detail: `${Math.min(this.#consecutiveConsistent, needed)}/${needed} consistent readings`,
      };
    }

    // Cold boot vs. established. An anchor older than KNOWN_GOOD_MAX_AGE_MS is treated
    // as absent, so a session that loses GPS for long enough re-derives its time from
    // scratch rather than being held to a stale reference it can no longer confirm.
    const anchor =
      this.#knownGood !== undefined && monotonicMs - this.#knownGood.monotonicMs <= KNOWN_GOOD_MAX_AGE_MS
        ? this.#knownGood
        : undefined;
    if (anchor !== undefined) {
      const projected = anchor.epochSeconds + (monotonicMs - anchor.monotonicMs) / 1000;
      const driftFromAnchor = Math.abs(epochSeconds - projected);
      if (driftFromAnchor > KNOWN_GOOD_TOLERANCE_SECONDS) {
        // Five mutually-consistent readings that all disagree with a time we already
        // trusted. Loud, because it is either a corruption mode we have not seen or
        // the anchor was wrong, and both are worth knowing about on a bike we cannot
        // attach a debugger to.
        //
        // Remembered, too: if this goes on long enough for the anchor to expire, the
        // time that displaces it has to earn it (READINGS_TO_DISPLACE_CONTESTED_ANCHOR)
        // rather than simply be the one that happened to be talking at the time.
        this.#anchorWasContested = true;
        return {
          step: false,
          reason: "disagrees-with-known-good",
          detail:
            `corroborated ${new Date(epochSeconds * 1000).toISOString()} is ${driftFromAnchor.toFixed(1)} s from ` +
            `the known-good time carried forward (limit ${KNOWN_GOOD_TOLERANCE_SECONDS} s)`,
        };
      }
    }

    // Corroborated and consistent with whatever we already knew: this is now the
    // reference, whether or not we go on to step the wall clock to it.
    const wasColdBoot = anchor === undefined;
    this.#knownGood = { epochSeconds, monotonicMs };
    this.#anchorWasContested = false;

    const offsetSeconds = epochSeconds - systemEpochSeconds;
    if (Math.abs(offsetSeconds) <= DRIFT_THRESHOLD_SECONDS) {
      return { step: false, reason: "in-agreement", detail: `${offsetSeconds.toFixed(1)} s off GPS` };
    }

    // The system clock is implausible when it is somewhere no working clock could be:
    // before the floor, or — now that several readings agree on the real time — further
    // from that than any drift could explain. The 2060 case is the second one, since a
    // clock stepped 34 years FORWARD is nowhere near the floor.
    //
    // This is the whole recovery path. The cooldown exists to stop a tug-of-war with
    // systemd-timesyncd over fractions of a second, and timesyncd never leaves the
    // clock an hour out — so an hour of disagreement is not thrashing, it is a broken
    // clock, and waiting the cooldown out is exactly what turned one corrupt frame into
    // 299.9 s and 501.5 s of corrupt rows.
    const sinceLastStepMs =
      this.#lastStepAtMonotonicMs === undefined ? Infinity : monotonicMs - this.#lastStepAtMonotonicMs;
    const clockIsImplausible =
      systemEpochSeconds < GPS_UTC_FLOOR_EPOCH_S || Math.abs(offsetSeconds) >= COOLDOWN_OVERRIDE_SECONDS;
    if (sinceLastStepMs < MIN_SECONDS_BETWEEN_STEPS * 1000 && !clockIsImplausible) {
      return {
        step: false,
        reason: "cooling-down",
        detail: `${offsetSeconds.toFixed(1)} s off GPS but stepped ${(sinceLastStepMs / 1000).toFixed(0)} s ago`,
      };
    }

    this.#lastStepAtMonotonicMs = monotonicMs;
    // Cold boot first, because it explains the step best and is checked for the
    // absence of an anchor rather than the size of the jump: a genuine cold-boot step
    // is routinely bigger than an hour (20 h 46 m and 20 h 38 m in the log) and would
    // otherwise be reported as a broken clock. "clock-implausible" is the other one —
    // we HAD a good time and the wall clock is a long way from it anyway, which is
    // recovery from a bad step rather than a first sync.
    return {
      step: true,
      epochSeconds,
      offsetSeconds,
      reason: wasColdBoot ? "cold-boot" : clockIsImplausible ? "clock-implausible" : "drift",
    };
  }
}

/**
 * How badly the worst reading in the window disagrees with `epochSeconds` about what
 * time it is now, after carrying each reading forward by the monotonic time since it
 * was taken.
 *
 * Monotonic, not wall clock, on purpose: this runs in a process that steps its own
 * wall clock, so a Date.now() difference here would be corrupted by the very event the
 * gate exists to police.
 *
 * The newest reading is in the window too and trivially agrees with itself, so a full
 * window of five is four independent comparisons. That is also why the caller checks
 * the window length separately: a window of one returns 0 here, and a single reading
 * agreeing with itself is not corroboration.
 */
function worstDisagreementSeconds(window: TimeReading[], epochSeconds: number, monotonicMs: number): number {
  let worst = 0;
  for (const reading of window) {
    const projected = reading.epochSeconds + (monotonicMs - reading.monotonicMs) / 1000;
    worst = Math.max(worst, Math.abs(projected - epochSeconds));
  }
  return worst;
}
