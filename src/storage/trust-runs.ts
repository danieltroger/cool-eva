import type { ClockTrust } from "../gps/clock.ts";

// Splitting a segment's readings by the clock they were stamped under.
//
// Pure, and its own file, so scripts/check-ride-log-clock.ts can drive it without a key, a
// clock or a filesystem — the same reason can/decode.ts and ble/protocol.ts are pure.
//
// ⚠️ Why the trust is carried PER READING rather than sampled when the segment is sealed:
// over rides.db's 130 boots the median gap between boot and the clock step is 15.9 s, and the
// segment timer is 30 s. So for the median boot every wrongly-stamped reading sits in a
// segment sealed AFTER the step, and a seal-time sample would mark all of them trusted —
// wrong in exactly the place the field exists for. docs/ride-log-clock.md.

/**
 * How much each state argues the clock is wrong, least first.
 *
 * ⚠️ `contested` outranks `never-synced` deliberately: "nothing has told us the time" is
 * weaker evidence of a bad clock than "something told us and it disagreed with what we
 * believed". Only the order matters, never the numbers.
 */
const PESSIMISM: Record<ClockTrust, number> = {
  "satellite-backed": 0,
  "never-synced": 1,
  contested: 2,
};

/**
 * How many runs one seal may produce before they are collapsed into a single segment.
 *
 * A boot crosses the boundary once, so two is the shape of every real seal. More than that
 * means the trust is FLAPPING — `clockContested` is set on every `disagrees-with-known-good`
 * verdict and cleared on the next `in-agreement` (../gps/clock.ts), driven at GPS frame rate
 * from two transports, so an offset sitting near DRIFT_THRESHOLD_SECONDS can toggle it
 * repeatedly. Each run costs an X25519 keygen, an ECDH, a gzip, an AES-GCM pass and an
 * fdatasync on the event loop that also serves the WebSocket and the CAN RX handler, so the
 * count has to be bounded by something other than the bike's mood.
 */
export const MAX_RUNS_PER_SEAL = 2;

/** One contiguous stretch of readings that share a clock-trust state. */
export interface TrustRun<Reading> {
  trust: ClockTrust;
  readings: Reading[];
}

/**
 * Groups `readings` into runs of equal trust, in order, at most MAX_RUNS_PER_SEAL of them.
 *
 * Past the cap every reading is collapsed into ONE run carrying the most pessimistic trust
 * present, which keeps the label honest — it can only over-state doubt, never under-state it
 * — while capping the work. Order is preserved in both branches, because `seq` is what orders
 * the log and a reordered re-queue would be a silent injury to the only copy of the data.
 */
export function splitByTrust<Reading>(
  readings: readonly Reading[],
  trustOf: (reading: Reading) => ClockTrust
): TrustRun<Reading>[] {
  const runs: TrustRun<Reading>[] = [];
  for (const reading of readings) {
    const trust = trustOf(reading);
    const current = runs[runs.length - 1];
    if (current && current.trust === trust) {
      current.readings.push(reading);
      continue;
    }
    runs.push({ trust, readings: [reading] });
  }
  if (runs.length <= MAX_RUNS_PER_SEAL) {
    return runs;
  }
  return [{ trust: mostPessimistic(runs.map(run => run.trust)), readings: readings.slice() }];
}

/** The state among `states` that argues hardest that the clock is wrong. */
export function mostPessimistic(states: readonly ClockTrust[]): ClockTrust {
  let worst: ClockTrust = "satellite-backed";
  for (const state of states) {
    if (PESSIMISM[state] > PESSIMISM[worst]) {
      worst = state;
    }
  }
  return worst;
}
