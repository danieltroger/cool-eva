import type { SocSample } from "../src/charge/soc.ts";

// A continuous SOC trajectory, and the ring the Pi would have kept from it. Data and arithmetic
// only — nothing here talks to a bus, and nothing here reads the estimator it exists to judge.
//
// ⚠️ WHY THIS IS NOT A FIXTURE ARRAY. check-charge-auto.ts §17 tests `estimateSocRate` against
// hand-written instances whose `truth` is computed from the same two endpoints the estimator reads,
// so the assertion is close to a restatement of the implementation (#235). Here `truth` is a
// continuous function of time and the ring is DERIVED from it the way the bus derives one: sample
// at 20 Hz, quantise to a whole percent, emit on change.
//
// ⚠️ AND NOT `replayCharge` EITHER, though it already quantises a SOC on change. Its trajectory is
// a CLOSED LOOP around the rule under test — the veto suppresses a step, the current stays up, the
// SOC rate changes — so a truth interpolated out of it is not independent of the thing it judges,
// which is the whole complaint in #235. Worse for diagnosis: when such a fixture goes red the
// trajectory has usually moved too, and the message cannot say which of the two broke. These
// trajectories are analytic functions of time and move only when someone edits them.
//
// ⚠️ `Math.floor` and no second quantiser. A `Math.round` ring is the `Math.floor` ring of the same
// trajectory shifted half a point, and `truth` moves with it, so the pass is the same pass — the
// estimator never sees the quantiser, only `(atMs, percent)` pairs.

/** A continuous SOC in percent, on the monotonic clock. Whatever the pack is really doing. */
export interface SocTrajectory {
  name: string;
  percentAt: (atMs: number) => number;
}

export interface SocRingOptions {
  fromMs: number;
  toMs: number;
  /**
   * Keeps the reading taken at `fromMs` whether or not it is a crossing — the ring a process would
   * hold if it kept its first-ever reading rather than its first CHANGE.
   *
   * ⚠️ NOT what the Pi does, measured: docs/dc-taper.md § "The first SOC sample, and why it is a
   * crossing". The probe exists because the lower bound rests on that and nothing enforces it.
   */
  keepFirstReading?: boolean;
}

export interface TrajectoryRing {
  samples: SocSample[];
  /**
   * The largest advance between two sampler ticks, as a rate. MEASURED while building rather than
   * declared, so check-soc-rate.ts's slack cannot be inflated by editing a number.
   */
  maxRatePerMinute: number;
}

/**
 * `soc` rides 20 Hz `0x200`, so a crossing is seen within 50 ms of happening and the sample the
 * ring keeps is that late. That is a real property of the bus, not a fixture convenience: it is
 * why the estimate may exceed the trajectory's own mean rate by a sampler tick's worth of advance.
 */
export const SOC_FRAME_PERIOD_MS = 50;

/**
 * The ring the Pi would have kept while this trajectory played out.
 *
 * Emits on change, so every sample is the instant the reading BECAME that value — which is what
 * `record()` delivers to `onChange` (it notifies only when the value moved) and therefore what
 * `rememberSoc` keeps. The ring is not trimmed: `estimateSocRate` windows its own input, the same
 * reason charge-auto-plant.ts gives.
 */
export function socRingFrom(trajectory: SocTrajectory, options: SocRingOptions): TrajectoryRing {
  const samples: SocSample[] = [];
  let lastTruePercent = trajectory.percentAt(options.fromMs);
  let lastReading = Math.floor(lastTruePercent);
  let largestAdvance = 0;
  if (options.keepFirstReading) {
    samples.push({ atMs: options.fromMs, percent: lastReading });
  }
  for (let atMs = options.fromMs + SOC_FRAME_PERIOD_MS; atMs <= options.toMs; atMs += SOC_FRAME_PERIOD_MS) {
    const truePercent = trajectory.percentAt(atMs);
    largestAdvance = Math.max(largestAdvance, Math.abs(truePercent - lastTruePercent));
    lastTruePercent = truePercent;
    const reading = Math.floor(truePercent);
    if (reading !== lastReading) {
      lastReading = reading;
      samples.push({ atMs, percent: reading });
    }
  }
  return { samples, maxRatePerMinute: largestAdvance / (SOC_FRAME_PERIOD_MS / 60_000) };
}

/** What the trajectory itself did over a span, in percent per minute. The independent truth. */
export function trueMeanRatePerMinute(trajectory: SocTrajectory, fromMs: number, toMs: number): number {
  return (trajectory.percentAt(toMs) - trajectory.percentAt(fromMs)) / ((toMs - fromMs) / 60_000);
}

/** Whether the reading at `atMs` had already been standing — i.e. this instant is not a crossing. */
export function sitsMidPlateau(trajectory: SocTrajectory, atMs: number): boolean {
  return Math.floor(trajectory.percentAt(atMs)) === Math.floor(trajectory.percentAt(atMs - SOC_FRAME_PERIOD_MS));
}

/**
 * The shapes a DC charge takes, swept by check-soc-rate.ts. All four end under 100 %, because a
 * reading above that is one `rememberSoc` drops rather than one it rings.
 *
 * ⚠️ ONE constant rate, not the three measured quantiles. A constant trajectory's crossings land on
 * sampler ticks, so its first sample is exact and the slack term — the subtlest arithmetic here — is
 * never exercised by one; measured, the median and p90 fired on nothing the p10 did not. The three
 * shapes that earn their place do it for named reasons: the ramp-up is the only one that exercises
 * `slack` at all hard, and the taper and the stall are the only two whose newest in-window sample
 * sits well before `nowMs`, which is what catches a span measured between samples instead of to now.
 */
export const STEADY_TRAJECTORY = constantRate("a steady 0.60 %/min, the p10 of 304 measured crossings", 60, 0.6);

export const RISING_TRAJECTORIES: SocTrajectory[] = [
  STEADY_TRAJECTORY,
  linearRateChange("a charge ramping up, 0.60 → 2.20 %/min", 25, 0.6, 2.2, 45),
  linearRateChange("the taper coming on, 2.20 → 0.30 %/min", 30, 2.2, 0.3, 45),
  stalledClimb("1.50 %/min with a 6.8 min stall, the longest gap in the log", 20, 1.5, 10, 6.8),
];

/**
 * A pack losing 0.50 %/min. `estimateSocRate` must decline it at the sign guard — and ⚠️ the
 * CONSTANT is what makes that probe arm: at −0.50 the window holds 5 distinct readings over its
 * full span, so the sign guard is the only thing that can decline it. At −0.20 the same fixture
 * yields 2 distinct readings and the DISTINCT guard declines first, which would let a deleted sign
 * guard through in silence. check-soc-rate.ts §4 pins both preconditions rather than the constant.
 */
export const FALLING_TRAJECTORY = constantRate("a pack losing 0.50 %/min", 80, -0.5);

/**
 * A dip and then a climb — the second way a leading sample can fail to be an upward crossing.
 *
 * Falling through a whole percent puts the sample at `p + 1` rather than at `p`, so a ring that
 * starts in the dip over-states by up to one whole count once the climb resumes. Never observed on
 * this bus, measured over every DC crossing in the log: docs/dc-taper.md.
 */
export const DIPPING_TRAJECTORY = dipThenClimb("SOC dipping 3 points and then climbing", 30, 0.5, 6, 1.5);

function constantRate(name: string, fromPercent: number, perMinute: number): SocTrajectory {
  return { name, percentAt: atMs => fromPercent + (perMinute * atMs) / 60_000 };
}

/** A rate moving linearly from `fromPerMinute` to `toPerMinute` over `overMinutes` — either way. */
function linearRateChange(
  name: string,
  fromPercent: number,
  fromPerMinute: number,
  toPerMinute: number,
  overMinutes: number
): SocTrajectory {
  const acceleration = (toPerMinute - fromPerMinute) / overMinutes;
  return {
    name,
    percentAt: atMs => {
      const minutes = atMs / 60_000;
      return fromPercent + fromPerMinute * minutes + (acceleration * minutes * minutes) / 2;
    },
  };
}

/** A climb that stands still for a while — a station holding the current down, and then letting go. */
function stalledClimb(
  name: string,
  fromPercent: number,
  perMinute: number,
  stallFromMinutes: number,
  stallMinutes: number
): SocTrajectory {
  return {
    name,
    percentAt: atMs => {
      const minutes = atMs / 60_000;
      const climbing = Math.min(minutes, stallFromMinutes) + Math.max(0, minutes - stallFromMinutes - stallMinutes);
      return fromPercent + perMinute * climbing;
    },
  };
}

function dipThenClimb(
  name: string,
  fromPercent: number,
  dipPerMinute: number,
  dipMinutes: number,
  perMinute: number
): SocTrajectory {
  const lowestPercent = fromPercent - dipPerMinute * dipMinutes;
  return {
    name,
    percentAt: atMs => {
      const minutes = atMs / 60_000;
      return minutes <= dipMinutes
        ? fromPercent - dipPerMinute * minutes
        : lowestPercent + perMinute * (minutes - dipMinutes);
    },
  };
}
