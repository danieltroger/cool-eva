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
  STEADY_TRAJECTORY,
  sitsMidPlateau,
  socRingFrom,
  trueMeanRatePerMinute,
  type SocTrajectory,
  type TrajectoryRing,
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
// arithmetic. Two mutations of `estimateSocRate` survive that whole suite and go red here: the
// window filter losing its `<= nowMs` clause, and the `advanced <= 0` guard deleted — the second
// answering a NEGATIVE horizon, which fires the veto on a pack that is not charging. Why neither is
// visible over there, and the rest of the matrix: docs/charge-auto.md § "The SOC rate is a lower
// bound".

const failures: string[] = [];

/** How far a trajectory is played out, and how often the estimator is asked. */
const SWEEP_TO_MS = 45 * 60_000;
const PROBE_STEP_MS = 30_000;

/** What the vehicle asks for below the knee, so the horizon in §4 has something to be measured to. */
const PROBE_REQUEST_A = 73;

/** Floating-point slop only. The real margins here start around 1e-5, four orders above it. */
const EPSILON = 1e-9;

// ── §1 the property: the estimate never exceeds the trajectory's own mean rate ──
//
// ⚠️ NOTHING here is taken from the estimator. `truth` comes from the trajectory, and the span it is
// measured over comes from `oldestInWindow` below, which re-derives the window rule independently.
// That independence is exactly why this catches a widened window: if the span came from the
// estimator, a filter that reached past `nowMs` would move `truth` with it and the probe would pass.
interface TrajectoryResult {
  answered: number;
  worstMargin: number;
}
const propertyResults = new Map<string, TrajectoryResult>();
// One ring per trajectory, built once and read by §1 and §4 alike: two construction calls are two
// things to edit, and the sections would then be judging different rings while claiming otherwise.
const rings = new Map<SocTrajectory, TrajectoryRing>(
  [...RISING_TRAJECTORIES, FALLING_TRAJECTORY, DIPPING_TRAJECTORY].map(trajectory => [
    trajectory,
    socRingFrom(trajectory, { fromMs: 0, toMs: SWEEP_TO_MS }),
  ])
);
for (const trajectory of RISING_TRAJECTORIES) {
  const ring = rings.get(trajectory)!;
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
const MIN_ANSWERED_PROBES = 30;
for (const [name, result] of propertyResults) {
  if (result.answered < MIN_ANSWERED_PROBES) {
    failures.push(
      `§2 ${name}: the estimator answered only ${result.answered} of the probes, under the ` +
        `${MIN_ANSWERED_PROBES} this trajectory has to carry — §1 holds vacuously for it`
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
const MID_PLATEAU_FROM_MS = 50_000;
if (!sitsMidPlateau(STEADY_TRAJECTORY, MID_PLATEAU_FROM_MS)) {
  failures.push(
    `§3 ${MID_PLATEAU_FROM_MS} ms is not mid-plateau on "${STEADY_TRAJECTORY.name}" — the reading changed ` +
      `there, so the ring leads with a crossing after all and this section is testing the ordinary case twice`
  );
}
const midPlateauRing = socRingFrom(STEADY_TRAJECTORY, {
  fromMs: MID_PLATEAU_FROM_MS,
  toMs: SWEEP_TO_MS,
  keepFirstReading: true,
});
const dippingRing = rings.get(DIPPING_TRAJECTORY)!;
const BOUNDED_CASES = [
  { name: "a first reading kept mid-plateau", trajectory: STEADY_TRAJECTORY, ring: midPlateauRing },
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
  if (answered < MIN_ANSWERED_PROBES) {
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
  const ring = rings.get(probe)!;
  let answered = 0;
  let reported = false;
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
    answered += 1;
    // Counted before the report and never broken out of, so a mutation that turns several probes
    // negative cannot also trip the vacuity floor below and point away from itself.
    if (ahead < 0 && !reported) {
      reported = true;
      failures.push(
        `§4 ${probe.name} at ${(nowMs / 60_000).toFixed(1)} min: the session-ahead estimate is ` +
          `${ahead.toFixed(1)} minutes. A negative horizon makes the predicted headroom LARGER, which suppresses ` +
          `a step down on a pack that is not charging`
      );
    }
  }
  horizonsAnswered += answered;
  // ⚠️ PER PROBE, not pooled, and the dipping one is why: the rising shapes answer hundreds between
  // them, so a pooled floor would clear by an order of magnitude while the one OTHER shape that can
  // produce a negative horizon had quietly stopped reaching the assertion at all. The falling probe
  // is exempt because answering nothing is what it asserts, and the block below pins that separately.
  if (probe !== FALLING_TRAJECTORY && answered < MIN_ANSWERED_PROBES) {
    failures.push(
      `§4 ${probe.name} answered only ${answered} horizons, under the ${MIN_ANSWERED_PROBES} it has to carry — ` +
        `the sign assertion is vacuous for the one shape it is supposed to cover`
    );
  }
}

// ⚠️ THE FALLING PROBE'S OWN PRECONDITIONS, and they are what make it arm. At −0.50 %/min the
// window holds enough distinct readings over enough span that the SIGN guard is the only thing left
// to decline it. At −0.20 the same fixture yields two distinct readings, the DISTINCT guard
// declines first, and a deleted sign guard would pass in silence.
const FALLING_PROBE_NOW_MS = SOC_WINDOW_MS;
const fallingRing = rings.get(FALLING_TRAJECTORY)!;
const fallingWindow = fallingRing.samples.filter(sample => isInWindow(sample, FALLING_PROBE_NOW_MS));
const fallingDistinct = new Set(fallingWindow.map(sample => sample.percent)).size;
const fallingOldest = oldestInWindow(fallingRing.samples, FALLING_PROBE_NOW_MS);
// ⚠️ No default span. An empty window is the WORST state this probe can be in, and defaulting its
// start to 0 would read as the longest span there is and pass the very clause that exists to catch it.
const fallingSpanMs = fallingOldest === null ? 0 : FALLING_PROBE_NOW_MS - fallingOldest.atMs;
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
// always recorded one before the controller subscribes, by a margin measured on every logged boot —
// the serial per-file `loadStaticFiles` read between the two. Nothing enforces that, so the
// controller says so when it does keep such a sample. docs/dc-taper.md.
//
// ⚠️ ORDER IS LOAD-BEARING HERE: `liveState` is never cleared, so "no soc recorded" is a one-way
// door inside one process, and the `0xFF` case below leaves a value behind that the last case needs
// to be plausible. The precondition is asserted rather than assumed, and the three run in the only
// order that can work.
defineSignals(SIGNALS);
if (latestValue("soc") !== null) {
  failures.push("§5 a SOC was already recorded before this section ran, so its first case cannot be constructed");
}
const inertSink = {
  commandChargeCurrent: async () => ({ succeeded: false, message: "check-soc-rate.ts never commands a current" }),
};
const warnedOnFirstEver = await warningsWhile(async () => {
  await withController(async () => {
    record("soc", 55);
    await settle();
    record("soc", 56);
    await settle();
  });
});
if (warnedOnFirstEver.length !== 1) {
  failures.push(
    `§5 a controller that subscribed before any SOC had arrived kept a sample with no crossing behind it and ` +
      `said so ${warnedOnFirstEver.length} time(s), expected exactly 1: ${JSON.stringify(warnedOnFirstEver)}`
  );
}
// ⚠️ AND A GARBLED BYTE COUNTS AS NOTHING RECORDED. `soc` is the raw `data[1]` of `0x200` and
// `record()` has no plausibility gate, so a `255` sitting in `liveState` at subscribe would answer
// "a SOC is known" while the next reading is a change against the garbage rather than a crossing.
// A null test here passed this case in silence — no warn at all, since `rememberSoc`'s own
// implausible-SOC line needs the 255 to arrive AFTER the controller subscribed.
const warnedAfterAGarbledByte = await warningsWhile(async () => {
  record("soc", 255);
  await settle();
  await withController(async () => {
    record("soc", 60);
    await settle();
    record("soc", 61);
    await settle();
  });
});
if (warnedAfterAGarbledByte.length !== 1) {
  failures.push(
    `§5 a controller that subscribed with only an implausible SOC on record is in the same position as one that ` +
      `subscribed with none, and must say so once: got ${JSON.stringify(warnedAfterAGarbledByte)}`
  );
}
const warnedWhenSocWasKnown = await warningsWhile(async () => {
  await withController(async () => {
    record("soc", 57);
    await settle();
  });
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

/**
 * The oldest sample the estimator could have measured from.
 *
 * ⚠️ Re-derived from the window rule rather than read back out of the estimator, which is what makes
 * §1 an assertion instead of an identity: a filter that reached past `nowMs` would otherwise move
 * this with it.
 */
function oldestInWindow(samples: SocSample[], nowMs: number): SocSample | null {
  return samples.find(sample => isInWindow(sample, nowMs)) ?? null;
}

/** The window rule itself, written once: the `<= nowMs` half is what a widened filter deletes. */
function isInWindow(sample: SocSample, nowMs: number): boolean {
  return sample.atMs >= nowMs - SOC_WINDOW_MS && sample.atMs <= nowMs;
}

/**
 * Runs `body` with a real controller subscribed, and stops it however that ends.
 *
 * ⚠️ The `finally` is not decoration: a throw with the controller still up leaks a live `onChange`
 * listener and a 60 s interval into every later case, which would then be deciding on this one's
 * readings. Same argument `warningsWhile` makes for the logger.
 */
async function withController(body: () => Promise<void>): Promise<void> {
  const controller = startChargeAutomatic(inertSink, { enabled: true });
  try {
    await body();
  } finally {
    controller.stop();
  }
}

/**
 * Lets the change batch that `record()` queued as a microtask reach the controller's listener.
 *
 * Not charge-auto-live-harness.ts's identical `settle`: importing it runs that module's top level,
 * which replaces `globalThis.fetch` and pulls in three `public/` modules this check has no use for.
 */
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
