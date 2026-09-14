import {
  estimateSocRate,
  sessionAheadMinutes,
  SOC_MIN_DISTINCT,
  SOC_MIN_SPAN_MS,
  SOC_WINDOW_MS,
  type SocSample,
} from "../src/charge/soc.ts";
import {
  DIPPING_TRAJECTORY,
  FALLING_TRAJECTORY,
  RISING_TRAJECTORIES,
  SOC_FRAME_PERIOD_MS,
  sitsMidPlateau,
  socRingFrom,
  trueMeanRatePerMinute,
  type SocTrajectory,
} from "./soc-trajectory.ts";
import { defineSignals, latestValue, record } from "../src/can/signals.ts";
import { SIGNALS } from "../src/can/registry.ts";
import { startChargeAutomatic } from "../src/charge/auto.ts";

// The SOC rate's LOWER-BOUND invariant, against continuous trajectories rather than against
// instances. On a laptop, with no bike.
//
//   node --experimental-strip-types scripts/check-soc-rate.ts
//
// Run by `npm test` via scripts/run-checks.ts. Takes no arguments.
//
// ⚠️ WHAT THIS EXISTS TO CATCH, because check-charge-auto.ts §17 and §18 already cover the
// arithmetic. Measured by mutation, verdicts from the exit code: `advanced + 1`, a span measured
// from the newest sample, `SOC_MIN_DISTINCT → 2` and a rate multiplied by 1.02 all go red on §17 or
// §18 today. TWO do not, and they are why this file exists:
//   · the window filter losing its `<= nowMs` clause — every fixture in that suite ends on or
//     before its own `nowMs`, so a FUTURE sample cannot exist in one;
//   · the `advanced <= 0` guard deleted — §17's backwards probe passes it, because the estimator
//     answers −0.2 %/min and both of §17's tests are upper bounds. A negative rate comes back
//     through `minutesUntilTaperBites` as a NEGATIVE horizon, which fires the veto on a pack whose
//     SOC is falling.
// docs/charge-auto.md § "The SOC rate is a lower bound".

const failures: string[] = [];

/** How far a trajectory is played out, and how often the estimator is asked. */
const SWEEP_TO_MS = 45 * 60_000;
const PROBE_STEP_MS = 30_000;

/** What the vehicle asks for below the knee, so the horizon in §4 has something to be measured to. */
const PROBE_REQUEST_A = 73;

/** Floating-point slop. Every margin this file deals in is ≥ 1e-4, so nothing real hides under it. */
const EPSILON = 1e-9;

// ── §1 the property: the estimate never exceeds the trajectory's own mean rate ──
//
// ⚠️ `truth` comes from the trajectory, not from the samples. The only thing taken from the
// estimator is WHICH SPAN it claims — the oldest sample inside its window — and the property is
// about the quotient over that span, which is the part under test.
interface TrajectoryResult {
  answered: number;
  worstMargin: number;
}
const propertyResults = new Map<string, TrajectoryResult>();
for (const trajectory of RISING_TRAJECTORIES) {
  const ring = socRingFrom(trajectory, { fromMs: 0, toMs: SWEEP_TO_MS });
  const result: TrajectoryResult = { answered: 0, worstMargin: -Infinity };
  let reported = false;
  let slackReported = false;
  for (let nowMs = 0; nowMs <= SWEEP_TO_MS; nowMs += PROBE_STEP_MS) {
    const estimate = estimateSocRate(ring.samples, nowMs);
    if (estimate === null) {
      continue;
    }
    const oldest = oldestInWindow(ring.samples, nowMs);
    if (oldest === null) {
      failures.push(`§1 ${trajectory.name}: the estimator answered ${estimate} with no sample inside its own window`);
      continue;
    }
    const spanMinutes = (nowMs - oldest.atMs) / 60_000;
    const truth = trueMeanRatePerMinute(trajectory, oldest.atMs, nowMs);
    // The fixture's own discretisation, NOT a tolerance on the estimator: the ring's first sample is
    // emitted up to one sampler tick after the true crossing, so the reading it carries is that much
    // behind the trajectory. Self-policing below, so it can never grow to where it would swallow one
    // whole count of over-statement — which is the size of every mutation this file is about.
    const slack = (ring.maxRatePerMinute * (SOC_FRAME_PERIOD_MS / 60_000)) / spanMinutes;
    const oneCount = 1 / spanMinutes;
    if (slack >= oneCount / 100 && !slackReported) {
      slackReported = true;
      failures.push(
        `§1 ${trajectory.name}: the ${slack.toFixed(6)} %/min sampler slack is within 100× of one whole count ` +
          `over the span (${oneCount.toFixed(3)}) — a budget that size can hide the defect it is meant to tolerate`
      );
    }
    result.answered += 1;
    result.worstMargin = Math.max(result.worstMargin, estimate - truth);
    if (estimate > truth + slack + EPSILON && !reported) {
      reported = true;
      failures.push(
        `§1 ${trajectory.name} at ${(nowMs / 60_000).toFixed(1)} min: the estimator returned ` +
          `${estimate.toFixed(4)} %/min where the trajectory itself rose at ${truth.toFixed(4)} over the ` +
          `${spanMinutes.toFixed(1)} min it measured. It must never over-state — over-stating shortens the ` +
          `horizon and suppresses more steps down`
      );
    }
  }
  propertyResults.set(trajectory.name, result);
}

// ── §2 the sweep is not vacuous ────────────────────────────────────────────
//
// ⚠️ A sweep where the estimator answers `null` everywhere satisfies §1 perfectly and proves
// nothing. Each trajectory has to reach the property on its own, or it is decoration.
const MIN_PROBES_PER_TRAJECTORY = 30;
/** The same floor for §4, which sweeps every trajectory into one count rather than one per shape. */
const MIN_ANSWERED_HORIZONS = 30;
for (const [name, result] of propertyResults) {
  if (result.answered < MIN_PROBES_PER_TRAJECTORY) {
    failures.push(
      `§2 ${name}: the estimator answered only ${result.answered} of the probes, under the ` +
        `${MIN_PROBES_PER_TRAJECTORY} this trajectory has to carry — §1 holds vacuously for it`
    );
  }
}

// ── §3 a leading sample that is not an upward crossing, and what it costs ───
//
// ⚠️ THE PRECONDITION, made visible. The lower bound holds because every sample is the instant the
// reading BECAME that value, so the pack had advanced at least `newest − oldest` points. Break that
// and the estimate over-states — by at most one whole count over the claimed span, which is what
// bounds the blast radius. Neither case is reachable on this bike and both are measured rather than
// assumed: docs/dc-taper.md § "The first SOC sample, and why it is a crossing".
const MID_PLATEAU_TRAJECTORY = RISING_TRAJECTORIES[0];
const MID_PLATEAU_FROM_MS = 50_000;
if (!sitsMidPlateau(MID_PLATEAU_TRAJECTORY, MID_PLATEAU_FROM_MS)) {
  failures.push(
    `§3 ${MID_PLATEAU_FROM_MS} ms is not mid-plateau on "${MID_PLATEAU_TRAJECTORY.name}" — the reading changed ` +
      `there, so the ring leads with a crossing after all and this section is testing the ordinary case twice`
  );
}
const midPlateauRing = socRingFrom(MID_PLATEAU_TRAJECTORY, {
  fromMs: MID_PLATEAU_FROM_MS,
  toMs: SWEEP_TO_MS,
  keepFirstReading: true,
});
const dippingRing = socRingFrom(DIPPING_TRAJECTORY, { fromMs: 0, toMs: SWEEP_TO_MS });
const BOUNDED_CASES = [
  { name: "a first reading kept mid-plateau", trajectory: MID_PLATEAU_TRAJECTORY, ring: midPlateauRing },
  { name: "a ring that leads with a downward crossing", trajectory: DIPPING_TRAJECTORY, ring: dippingRing },
];
for (const probe of BOUNDED_CASES) {
  let overStated = 0;
  let answered = 0;
  let reported = false;
  for (let nowMs = 0; nowMs <= SWEEP_TO_MS; nowMs += PROBE_STEP_MS) {
    const estimate = estimateSocRate(probe.ring.samples, nowMs);
    const oldest = oldestInWindow(probe.ring.samples, nowMs);
    if (estimate === null || oldest === null) {
      continue;
    }
    answered += 1;
    const spanMinutes = (nowMs - oldest.atMs) / 60_000;
    const truth = trueMeanRatePerMinute(probe.trajectory, oldest.atMs, nowMs);
    if (estimate > truth + EPSILON) {
      overStated += 1;
    }
    if (estimate > truth + 1 / spanMinutes + EPSILON && !reported) {
      reported = true;
      failures.push(
        `§3 ${probe.name} at ${(nowMs / 60_000).toFixed(1)} min: ${estimate.toFixed(4)} %/min against a true ` +
          `${truth.toFixed(4)} over ${spanMinutes.toFixed(1)} min — past the one whole count that bounds it. ` +
          `A whole-percent reading cannot be more than a point ahead of the value it carries`
      );
    }
  }
  if (answered < MIN_PROBES_PER_TRAJECTORY) {
    failures.push(`§3 ${probe.name}: only ${answered} answered probes, so its bound holds vacuously`);
  }
  // ⚠️ And it has to actually over-state, or the probe has stopped constructing the case it is
  // named after and §3 is asserting a bound on the ordinary ring.
  if (overStated === 0) {
    failures.push(
      `§3 ${probe.name} never over-stated across ${answered} probes — the ring is no longer breaking the ` +
        `crossing-instant precondition, so nothing here is testing what it says it is`
    );
  }
}

// ── §4 ⚠️ THE HORIZON IS NEVER NEGATIVE ────────────────────────────────────
//
// A rate for a pack that is LOSING charge is not merely wrong, it inverts the veto: a negative rate
// makes `minutesUntilTaperBites` negative, which makes the predicted headroom larger, which
// suppresses a step down on a pack whose SOC is going the other way. Nothing else in the suite
// catches the `advanced <= 0` guard being deleted.
let horizonsAnswered = 0;
for (const probe of [...RISING_TRAJECTORIES, FALLING_TRAJECTORY, DIPPING_TRAJECTORY]) {
  const ring = socRingFrom(probe, { fromMs: 0, toMs: SWEEP_TO_MS });
  for (let nowMs = 0; nowMs <= SWEEP_TO_MS; nowMs += PROBE_STEP_MS) {
    const ahead = sessionAheadMinutes({
      socPercent: Math.floor(probe.percentAt(nowMs)),
      socAgeMs: 100,
      socSamples: ring.samples,
      requestedAmps: PROBE_REQUEST_A,
      nowMs,
    });
    if (ahead === null) {
      continue;
    }
    horizonsAnswered += 1;
    if (ahead < 0) {
      failures.push(
        `§4 ${probe.name} at ${(nowMs / 60_000).toFixed(1)} min: the session-ahead estimate is ` +
          `${ahead.toFixed(1)} minutes. A negative horizon makes the predicted headroom LARGER, which suppresses ` +
          `a step down on a pack that is not charging`
      );
      break;
    }
  }
}
if (horizonsAnswered < MIN_ANSWERED_HORIZONS) {
  failures.push(`§4 only ${horizonsAnswered} horizons were answered at all, so the sign assertion is vacuous`);
}

// ⚠️ THE FALLING PROBE'S OWN PRECONDITIONS, and they are what make it arm. At −0.50 %/min the
// window holds enough distinct readings over enough span that the SIGN guard is the only thing left
// to decline it. At −0.20 the same fixture yields two distinct readings, the DISTINCT guard
// declines first, and a deleted sign guard would pass in silence.
const FALLING_PROBE_NOW_MS = SOC_WINDOW_MS;
const fallingRing = socRingFrom(FALLING_TRAJECTORY, { fromMs: 0, toMs: SWEEP_TO_MS });
const fallingWindow = fallingRing.samples.filter(
  sample => sample.atMs >= FALLING_PROBE_NOW_MS - SOC_WINDOW_MS && sample.atMs <= FALLING_PROBE_NOW_MS
);
const fallingDistinct = new Set(fallingWindow.map(sample => sample.percent)).size;
const fallingSpanMs = FALLING_PROBE_NOW_MS - (oldestInWindow(fallingRing.samples, FALLING_PROBE_NOW_MS)?.atMs ?? 0);
if (fallingDistinct < SOC_MIN_DISTINCT || fallingSpanMs < SOC_MIN_SPAN_MS) {
  failures.push(
    `§4 the falling probe reaches only ${fallingDistinct} distinct readings over ${(fallingSpanMs / 60_000).toFixed(1)} ` +
      `min, so an earlier guard declines it and the sign guard is never reached — it would miss its own mutation`
  );
}
if (estimateSocRate(fallingRing.samples, FALLING_PROBE_NOW_MS) !== null) {
  failures.push("§4 a pack whose SOC is falling must get no rate at all, not a negative one");
}

// ── §5 the ring's first sample, and the start-up ordering that makes it a crossing ──
//
// ⚠️ `record()` notifies when `prev === undefined`, so a process's FIRST-EVER reading is delivered
// as a change even though it is not a crossing. What saves the ring is that the CAN channel has
// always recorded one long before the controller subscribes — 530-1282 ms across 77 boots, and the
// margin is the serial static-file read at src/index.ts:434. Nothing enforces that, so the
// controller says so when it does keep such a sample. docs/dc-taper.md.
//
// ⚠️ ORDER IS LOAD-BEARING HERE: `liveState` is never cleared, so "no soc recorded" is a one-way
// door inside one process. The precondition is asserted rather than assumed.
defineSignals(SIGNALS);
if (latestValue("soc") !== null) {
  failures.push("§5 a SOC was already recorded before this section ran, so its first case cannot be constructed");
}
const inertSink = {
  commandChargeCurrent: async () => ({ succeeded: false, message: "check-soc-rate.ts never commands a current" }),
};
const warnedOnFirstEver = await warningsWhile(async () => {
  const controller = startChargeAutomatic(inertSink, { enabled: true });
  record("soc", 55);
  await settle();
  record("soc", 56);
  await settle();
  controller.stop();
});
if (warnedOnFirstEver.length !== 1) {
  failures.push(
    `§5 a controller that subscribed before any SOC had arrived kept a sample with no crossing behind it and ` +
      `said so ${warnedOnFirstEver.length} time(s), expected exactly 1: ${JSON.stringify(warnedOnFirstEver)}`
  );
}
const warnedWhenSocWasKnown = await warningsWhile(async () => {
  const controller = startChargeAutomatic(inertSink, { enabled: true });
  record("soc", 57);
  await settle();
  controller.stop();
});
if (warnedWhenSocWasKnown.length !== 0) {
  failures.push(
    `§5 a controller that subscribed when SOC was already known keeps only crossings, so it must say nothing: ` +
      `got ${JSON.stringify(warnedWhenSocWasKnown)}`
  );
}

if (failures.length > 0) {
  console.error(`✗ ${failures.length} SOC-rate failure(s):`);
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  process.exit(1);
}
const answeredProbes = [...propertyResults.values()].reduce((total, result) => total + result.answered, 0);
const worstMargin = Math.max(...[...propertyResults.values()].map(result => result.worstMargin));
console.log(
  `✓ across ${RISING_TRAJECTORIES.length} continuous trajectories the SOC rate never exceeds the trajectory's own ` +
    `mean rate over the span it measures — ${answeredProbes} answered probes, worst margin ` +
    `${worstMargin.toExponential(1)} %/min against a ${(1 / (SOC_MIN_SPAN_MS / 60_000)).toFixed(2)} %/min whole ` +
    `count; a ring that leads with a mid-plateau reading or a downward crossing does over-state and is bounded by ` +
    `one count; ${horizonsAnswered} session-ahead horizons are answered and none is negative, a pack losing ` +
    `0.50 %/min getting no rate at all with ${fallingDistinct} distinct readings over ` +
    `${(fallingSpanMs / 60_000).toFixed(1)} min of span, so the sign guard is what declines it; and the controller ` +
    `says so exactly once when it keeps a first sample with no crossing behind it, and nothing when it does not`
);

/** The oldest sample the estimator could have measured from — its window, and nothing else of it. */
function oldestInWindow(samples: SocSample[], nowMs: number): SocSample | null {
  return samples.find(sample => sample.atMs >= nowMs - SOC_WINDOW_MS && sample.atMs <= nowMs) ?? null;
}

/** Lets the change batch that `record()` queued as a microtask reach the controller's listener. */
function settle(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

/**
 * Every `console.warn` the body produced.
 *
 * ⚠️ Restored in a `finally`: a throw here with the logger still replaced would take the rest of
 * the check's own failure reporting with it, which is the one thing a check may never lose.
 */
async function warningsWhile(body: () => Promise<void>): Promise<string[]> {
  const captured: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    captured.push(args.map(argument => String(argument)).join(" "));
  };
  try {
    await body();
  } finally {
    console.warn = realWarn;
  }
  return captured;
}
