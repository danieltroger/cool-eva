// Did the charge-current command take? Pure — samples in, a verdict out, no I/O and no clock read.
//
// ⚠️ WHY THIS IS NOT "did the current reach the number I asked for". On 2026-09-07 the pack was
// saw-toothing: the BMS clamp released every 1-3 minutes and the vehicle's request swept the whole
// range on the way down, so it passes through ANY value by accident. A first-crossing test scored
// two of the three commands that moved nothing that day as successes, at 8.664 s and 8.909 s. The
// test here is an ENVELOPE — the request must stop EXCEEDING the commanded value and stay stopped
// — which scores those two as not-acknowledged and the rider's own two down-dials as took.
//
// The signal is the vehicle's own REQUEST, never the delivered current: `pack_a` conflates "the
// VCU accepted my command" with "the station could deliver it", and those are the two answers this
// exists to tell apart. docs/can-0x121-charge-command.md § "Confirming a DC command took".

/** How a charge-current command turned out. Closed, so the page cannot invent a sixth state. */
export type ChargeAckVerdict =
  /** The window is still open. */
  | { kind: "waiting"; elapsedMs: number }
  /** It was binding and the request came down and stayed down. `latencyMs` is to the first sample at or under. */
  | { kind: "took"; fromAmps: number; toAmps: number; latencyMs: number }
  /** It was binding and the request never came down. THE failure signal — 2026-09-07 reads this. */
  | { kind: "not-acknowledged"; heldAmps: number }
  /** An increase the station or the pack would not follow. Not a failure. */
  | { kind: "station-limited"; askedAmps: number; gotAmps: number }
  /** Nothing observable could happen — the request was already at or below what was asked. */
  | { kind: "no-change-expected"; atAmps: number }
  /** A newer command replaced this one before its window closed. */
  | { kind: "superseded" }
  /** No reading of the acknowledgement signal at all, so nothing can be said. */
  | { kind: "no-evidence" };

/** One reading of the acknowledgement signal. */
export interface AckSample {
  /** Monotonic milliseconds — never a wall clock, which this Pi steps. */
  atMs: number;
  amps: number;
}

export interface ChargeAckInput {
  commandedAmps: number;
  /** Monotonic mark of the transmit. */
  sentAtMs: number;
  nowMs: number;
  /**
   * Every sample from `sentAtMs - BINDING_LOOKBACK_MS` onwards, oldest first. The caller keeps the
   * ring; this reads it.
   */
  samples: AckSample[];
  /** When a newer command went out, if one has. Truncates the window. */
  supersededAtMs: number | null;
  /**
   * Override for ACK_SETTLE_MS. Every caller on the Pi passes nothing; scripts/check-charge-ack.ts
   * §4 hands one in to show the grace is not load-bearing, which is the only way to tell a chosen
   * constant from a measured one.
   */
  settleMs?: number;
}

/**
 * How long to watch before calling it.
 *
 * ⚠️ It MUST stay below the automatic controller's update period, or a verdict for one command
 * lands after the next has gone out and the readout adjudicates the wrong thing. That is the
 * binding reason for the value. Beyond that: the dash's own commands were measured taking hold
 * within one 0x615 broadcast (~100 ms), so 10 s is ~100 broadcasts and a miss is a real miss.
 */
export const ACK_TIMEOUT_MS = 10_000;

/**
 * Grace before the envelope starts, so the VCU has time to apply the command and re-broadcast.
 *
 * 10× the observed take-up. Deliberately small: the three failed sends of 2026-09-07 held their
 * old value for the whole 10 s, so a longer grace would not rescue them and would only blunt the
 * test. scripts/check-charge-ack.ts asserts every verdict is unchanged with it at 0 and at 2 s.
 */
export const ACK_SETTLE_MS = 1_000;

/**
 * How far back a sample may be and still count as "what the request was when we commanded".
 *
 * ⚠️ Used to FIND that value, never to widen what counts as binding. An earlier version took the
 * 60 s ENVELOPE as the binding test, so a command sent in a saw-tooth trough — request sitting at
 * 20 A, envelope 71 A — counted as binding, and then any quiet window read as success. A command
 * that did nothing scored `took`. Whether a reduction can bind is a question about the request at
 * the moment of sending, and nothing else.
 */
export const SAMPLE_HISTORY_MS = 60_000;

/** The request is a whole-amp byte, so treat anything within 1 A as equal. */
const AMP_TOLERANCE = 1;

/**
 * Judges one command. Pure.
 *
 * Reads `samples` three times over: what the request was doing before (the envelope that decides
 * whether the command could bind at all), what it did after (the envelope that decides whether it
 * did), and the last value at the moment of the command (which is what "already there" means).
 */
export function judgeChargeCommand(input: ChargeAckInput): ChargeAckVerdict {
  const { commandedAmps, sentAtMs, nowMs, samples, supersededAtMs, settleMs = ACK_SETTLE_MS } = input;
  const before = samples.filter(sample => sample.atMs <= sentAtMs && sample.atMs >= sentAtMs - SAMPLE_HISTORY_MS);
  const lastBefore = before.at(-1) ?? null;
  if (lastBefore === null) {
    return { kind: "no-evidence" };
  }
  const supersededEarly = supersededAtMs !== null && supersededAtMs <= sentAtMs + ACK_TIMEOUT_MS;
  const windowEnds = Math.min(sentAtMs + ACK_TIMEOUT_MS, supersededAtMs ?? Number.POSITIVE_INFINITY);
  const after = samples.filter(sample => sample.atMs > sentAtMs && sample.atMs <= windowEnds);

  if (lastBefore.amps > commandedAmps + AMP_TOLERANCE) {
    // A binding reduction: the request is above what we asked for, so the bike must visibly move.
    const settled = after.filter(sample => sample.atMs >= sentAtMs + settleMs);
    if (settled.length > 0) {
      const heldAmps = Math.max(...settled.map(sample => sample.amps));
      if (heldAmps <= commandedAmps + AMP_TOLERANCE) {
        const firstAtOrUnder = after.find(sample => sample.amps <= commandedAmps + AMP_TOLERANCE);
        return {
          kind: "took",
          fromAmps: lastBefore.amps,
          toAmps: heldAmps,
          latencyMs: firstAtOrUnder ? firstAtOrUnder.atMs - sentAtMs : 0,
        };
      }
      if (nowMs < windowEnds) {
        return { kind: "waiting", elapsedMs: nowMs - sentAtMs };
      }
      return supersededEarly ? { kind: "superseded" } : { kind: "not-acknowledged", heldAmps };
    }
    if (nowMs < windowEnds) {
      return { kind: "waiting", elapsedMs: nowMs - sentAtMs };
    }
    // ⚠️ No post-settle sample, and the signal is logged on change — so the request is still
    // whatever it was, which for a binding reduction is still too high. This is the ONE direction
    // silence is evidence in; the opposite reading is what produced a false `took`.
    return supersededEarly ? { kind: "superseded" } : { kind: "not-acknowledged", heldAmps: lastBefore.amps };
  }

  if (commandedAmps > lastBefore.amps + AMP_TOLERANCE) {
    // An increase. The VCU honours these, but only as far as the station and the pack allow, so
    // failing to reach the number is the charger's answer and not ours. Never a failure.
    //
    // ⚠️ Reaching the value is not enough: during a saw-tooth the request sweeps UP through every
    // value on its way to the ceiling, so a first-crossing test would score the sweep as a take.
    // It must reach the commanded value AND not overshoot it — that is what settling at a new cap
    // looks like, and what a sweep past it does not.
    const settledAtCap =
      after.some(sample => sample.amps >= commandedAmps - AMP_TOLERANCE) &&
      after.every(sample => sample.amps <= commandedAmps + AMP_TOLERANCE);
    if (settledAtCap) {
      const reached = after.find(sample => sample.amps >= commandedAmps - AMP_TOLERANCE);
      return {
        kind: "took",
        fromAmps: lastBefore.amps,
        toAmps: reached ? reached.amps : commandedAmps,
        latencyMs: reached ? reached.atMs - sentAtMs : 0,
      };
    }
    if (nowMs < windowEnds) {
      return { kind: "waiting", elapsedMs: nowMs - sentAtMs };
    }
    if (supersededEarly) {
      return { kind: "superseded" };
    }
    // ⚠️ Only samples from inside the window, never the pre-command reading: reporting "the charger
    // is giving 20 A" off a minute-old value states a measurement that was never taken.
    const best = after.length > 0 ? Math.max(...after.map(sample => sample.amps)) : lastBefore.amps;
    return { kind: "station-limited", askedAmps: commandedAmps, gotAmps: best };
  }

  // Asked for what is already flowing. ⚠️ Reported as unfalsifiable rather than as a success: this
  // is the case that would let a silently broken transmit path look healthy for ever.
  return { kind: "no-change-expected", atAmps: lastBefore.amps };
}

/** The verdict as the integer the ride log carries, so a decrypted log answers "did it work". */
export const CHARGE_ACK_CODE: Record<ChargeAckVerdict["kind"], number> = {
  waiting: 0,
  took: 1,
  "not-acknowledged": 2,
  "station-limited": 3,
  "no-change-expected": 4,
  superseded: 5,
  "no-evidence": 6,
};

/** One sentence for the charge tab, already phrased. */
export function describeChargeAck(verdict: ChargeAckVerdict, commandedAmps: number): string {
  switch (verdict.kind) {
    case "waiting":
      return `Sent ${commandedAmps} A — waiting for the bike to answer (${Math.round(verdict.elapsedMs / 1000)} s).`;
    case "took":
      return `Command took: request ${verdict.fromAmps} → ${verdict.toAmps} A in ${(verdict.latencyMs / 1000).toFixed(1)} s.`;
    case "not-acknowledged":
      return `Command NOT acknowledged after ${ACK_TIMEOUT_MS / 1000} s — the request is still ${verdict.heldAmps} A.`;
    case "station-limited":
      return `Station-limited: asked ${verdict.askedAmps} A, the charger is giving ${verdict.gotAmps} A. Not a fault — only a reduction proves a command took.`;
    case "no-change-expected":
      return `Sent ${commandedAmps} A — nothing to observe, the request was already ${verdict.atAmps} A.`;
    case "superseded":
      return "A newer command replaced this one before the bike answered.";
    case "no-evidence":
      return "No reading of the charge request yet, so whether it took cannot be said.";
  }
}
