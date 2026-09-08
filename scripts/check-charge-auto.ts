import {
  BLIND_DESCENT_FROM_C,
  CHARGE_AUTO_REASON,
  CLIFF_C,
  HARD_CEILING_C,
  HORIZON_MIN,
  MIN_COMMAND_A,
  decideChargeCurrent,
  type ChargeAutoInput,
} from "../src/charge/auto-curve.ts";
import { estimateHeatingRate, RATE_MIN_SPAN_MS, RATE_WINDOW_MS, type TemperatureSample } from "../src/charge/rate.ts";
import {
  COLD_PLANTS,
  PLANTS,
  RECOVERY_PLANT,
  REPLAY_SESSIONS,
  SAWTOOTH_MIN_PER_POINT,
  minutesPerPointAt,
  replayCharge,
} from "./charge-auto-plant.ts";
import { boundsFor } from "../public/lib/bounds.js";
import { REASON_TEXT } from "../public/views/charge-auto.js";
import { CHARGE_AUTO_REASON_TEXT } from "../src/http/charge-auto.ts";

// The automatic DC charge-current controller, driven through the three real stops of 2026-09-07 and
// a spread of weather it never saw. On a laptop, with no bike.
//
//   node --experimental-strip-types scripts/check-charge-auto.ts
//
// Run by `npm test` via scripts/run-checks.ts. Takes no arguments.
//
// ⚠️ WHAT THIS CAN AND CANNOT SHOW. The plant is the two-anchor thermal model the controller is
// designed NOT to depend on, so §3 proves the rule behaves across a 4× spread of cooling — the
// "works for one day's b" failure it exists to avoid — and proves nothing about the real bike. Only
// a live charge does that. §4 is the assertion a BROKEN controller fails, because §3's guarantees
// are comparison-principle theorems that a controller stuck at the ceiling would also satisfy.

const failures: string[] = [];

/** A live DC session with everything present, for the fail-safe cases to knock out one at a time. */
const HEALTHY: ChargeAutoInput = {
  enabled: true,
  packTemperatureC: 51,
  packTemperatureAgeMs: 100,
  packTemperaturePlausible: true,
  chargeManagerState: 0x23,
  chargeManagerStateAgeMs: 100,
  ceilingAmps: 75,
  commandedAmps: null,
  riderOverride: false,
  samples: climbing(48, 54),
  nowMs: 700_000,
};

// ── §1 every fail-safe holds, and none of them commands ────────────────────
//
// ⚠️ The whole safety posture: an unknown NEVER produces a current. The bike then charges exactly
// as it does today, so the controller can only improve on the status quo and never worsen it.
const FAIL_SAFE: { name: string; over: Partial<ChargeAutoInput>; reason: number }[] = [
  { name: "switched off", over: { enabled: false }, reason: CHARGE_AUTO_REASON.DISABLED },
  { name: "rider moved the dial", over: { riderOverride: true }, reason: CHARGE_AUTO_REASON.RIDER },
  { name: "AC session", over: { chargeManagerState: 0x02 }, reason: CHARGE_AUTO_REASON.NOT_DC },
  { name: "no session at all", over: { chargeManagerState: null }, reason: CHARGE_AUTO_REASON.NOT_DC },
  { name: "session state stale", over: { chargeManagerStateAgeMs: 9_000 }, reason: CHARGE_AUTO_REASON.NOT_DC },
  { name: "temperature stale", over: { packTemperatureAgeMs: 9_000 }, reason: CHARGE_AUTO_REASON.NO_TEMPERATURE },
  { name: "temperature missing", over: { packTemperatureC: null }, reason: CHARGE_AUTO_REASON.NO_TEMPERATURE },
  {
    name: "temperature implausible",
    over: { packTemperaturePlausible: false },
    reason: CHARGE_AUTO_REASON.NO_TEMPERATURE,
  },
  { name: "no DC ceiling", over: { ceilingAmps: null }, reason: CHARGE_AUTO_REASON.NO_CEILING },
];
for (const guard of FAIL_SAFE) {
  const decision = decideChargeCurrent({ ...HEALTHY, ...guard.over });
  if (decision.kind !== "hold" || decision.reason !== guard.reason) {
    failures.push(`§1 ${guard.name}: got ${JSON.stringify(decision)}, expected a hold with reason ${guard.reason}`);
  }
}

// ── §2 the rate estimator, and the case that nearly shipped ────────────────
//
// ⚠️ "Too few readings to fit a slope" is NOT "no information": the sensor is whole degrees, so it
// bounds the rate. An earlier design read it as an absence and descended on a pack that was stable,
// BECAUSE it was stable.
const flat = estimateHeatingRate(steady(51, RATE_WINDOW_MS), RATE_WINDOW_MS);
if (flat.kind !== "bounded") {
  failures.push(`§2 a pack sitting still for the whole window reads ${flat.kind}, not a bounded rate`);
} else if (flat.perMinute > 0.11) {
  failures.push(`§2 a flat pack's bound is ${flat.perMinute.toFixed(3)} K/min — too loose to be worth having`);
}
// ⚠️ The bound's VALUE, two-sided. Only checking it is not too loose misses the dangerous direction:
// an optimistic bound understates how fast the pack may be moving, and the controller then thinks
// it has more time than it does.
if (flat.kind === "bounded") {
  const expected = (1 * 60_000) / RATE_WINDOW_MS;
  if (Math.abs(flat.perMinute - expected) > 1e-9) {
    failures.push(
      `§2 one distinct reading over ${RATE_WINDOW_MS / 60_000} min should bound the rate at ` +
        `${expected.toFixed(3)} K/min, got ${flat.perMinute.toFixed(3)} — an optimistic bound is the unsafe direction`
    );
  }
}
// ⚠️ And that a bound is USED. Treating it as "no rate" downstream would quietly undo the fix it
// exists to be: this pack is 1 °C from the cliff with a bound that says it arrives inside the horizon.
const boundedClosing = decideChargeCurrent({
  ...HEALTHY,
  packTemperatureC: 52,
  commandedAmps: 70,
  // Two distinct degrees across five minutes bounds the rate at 0.4 K/min, which puts a pack 3 K
  // from the cliff 7.5 minutes away — inside the horizon.
  samples: [
    { atMs: 100_000, celsius: 51 },
    { atMs: 200_000, celsius: 52 },
  ],
  nowMs: 400_000,
});
if (boundedClosing.kind !== "command" || boundedClosing.reason !== CHARGE_AUTO_REASON.CLOSING) {
  failures.push(
    `§2 a bounded rate that puts the cliff inside the horizon must still close: got ${JSON.stringify(boundedClosing)}`
  );
}
// ⚠️ The hysteresis band itself, which no replay can see: a pack whose time-to-cliff sits BETWEEN
// the horizon and the release threshold must HOLD. Without the band every tick either steps up or
// down, and the current oscillates around the threshold for the whole charge — a frame on the bus
// and a number moving on the rider's dash each time, while "never crosses the cliff" stays true.
const inBand = decideChargeCurrent({
  ...HEALTHY,
  packTemperatureC: 50,
  commandedAmps: 60,
  samples: climbing(45, 50),
  nowMs: 700_000,
});
if (inBand.kind !== "hold" || inBand.reason !== CHARGE_AUTO_REASON.SETTLED) {
  failures.push(
    `§2 a pack ${HORIZON_MIN}-${HORIZON_MIN * 1.5} min from the cliff is inside the hysteresis band and must hold: ` +
      `got ${JSON.stringify(inBand)}`
  );
}
const early = estimateHeatingRate(climbing(48, 50).slice(0, 3), 40_000);
if (early.kind !== "unknown") {
  failures.push(`§2 ${RATE_MIN_SPAN_MS / 1000} s of history should read unknown, got ${early.kind}`);
}
const climbingRate = estimateHeatingRate(climbing(45, 51), 600_000);
if (climbingRate.kind !== "rate" || Math.abs(climbingRate.perMinute - 0.6) > 0.15) {
  failures.push(`§2 a 6 K climb over 10 min should read ≈0.6 K/min, got ${JSON.stringify(climbingRate)}`);
}
// ⚠️ The saw-tooth must not drive the controller: it is a 1-3 min transient at the hottest cell, and
// a rate fitted to it over-predicts the bulk climb by 3.5×.
const sawtooth = estimateHeatingRate(sawtoothAround(54), 600_000);
if (sawtooth.kind === "rate" && Math.abs(sawtooth.perMinute) > 0.2) {
  failures.push(
    `§2 a saw-toothing pack with no bulk drift reads ${sawtooth.perMinute.toFixed(2)} K/min — the oscillation is ` +
      `driving the estimate, which is the trap this window exists to avoid`
  );
}

// ── §3 the replays, across four plants ─────────────────────────────────────
//
// A1: never peaks above the do-nothing baseline. A2: never causes a crossing the baseline did not
// have. Both hold for every session × plant, and the time cost is REPORTED rather than assumed away.
let worstPenalty = -Infinity;
let bestSaving = Infinity;
for (const session of REPLAY_SESSIONS) {
  for (const plant of PLANTS) {
    const setup = {
      arrivalC: session.arrivalC,
      ambientC: session.ambientC + plant.ambientOffset,
      fromSoc: session.fromSoc,
      toSoc: session.toSoc,
      cooling: plant.cooling,
    };
    const baseline = replayCharge({ ...setup, control: false });
    const controlled = replayCharge(setup);
    if (controlled.peakC > baseline.peakC + 1e-9) {
      failures.push(
        `§3 ${session.name}/${plant.name}: controller peaks ${controlled.peakC.toFixed(2)} °C against a baseline ` +
          `${baseline.peakC.toFixed(2)} °C — it must never make the pack hotter`
      );
    }
    if (controlled.peakC >= CLIFF_C && baseline.peakC < CLIFF_C) {
      failures.push(`§3 ${session.name}/${plant.name}: controller crosses ${CLIFF_C} °C where doing nothing did not`);
    }
    worstPenalty = Math.max(worstPenalty, controlled.minutes - baseline.minutes);
    bestSaving = Math.min(bestSaving, controlled.minutes - baseline.minutes);
  }
}
// Bounded, not zero: buying "never crosses the cliff" costs time on the stops that would have got
// away with it. The bound is what stops that cost growing unnoticed.
if (worstPenalty > 6) {
  failures.push(`§3 worst time cost is ${worstPenalty.toFixed(1)} min, over the 6 min bound`);
}

// ── §4 ⚠️ THE ASSERTION A BROKEN CONTROLLER FAILS ──────────────────────────
//
// §3's two properties are comparison-principle theorems: a controller stuck at the ceiling satisfies
// both, trivially, by being the baseline. This kills that one — the DC2 speedup needs the cliff
// avoided, which the baseline cannot do.
//
// ⚠️ It is NOT sufficient on its own, and the comment here used to claim it was. A controller stuck
// at a flat 38-41 A also passes; a flat 40 A even saves MORE on DC2 than the real one. What kills a
// constant is §4b (it would throttle a cold pack that needed nothing), §3's time bound and §6's
// coverage. Read the four together.
const dc2 = REPLAY_SESSIONS[1];
const dc2Setup = { arrivalC: dc2.arrivalC, ambientC: dc2.ambientC, fromSoc: dc2.fromSoc, toSoc: dc2.toSoc };
const dc2Baseline = replayCharge({ ...dc2Setup, control: false });
const dc2Real = replayCharge(dc2Setup);
const saved = dc2Baseline.minutes - dc2Real.minutes;
if (saved < 5) {
  failures.push(`§4 DC2 saves only ${saved.toFixed(1)} min against the baseline; a working controller saves ≥5`);
}
if (dc2Real.peakC >= CLIFF_C) {
  failures.push(`§4 DC2 still reaches ${dc2Real.peakC.toFixed(2)} °C — the controller did not hold it under the cliff`);
}
for (const stuck of [72.6, MIN_COMMAND_A]) {
  const broken = replayCharge({ ...dc2Setup, stuckAt: stuck });
  if (dc2Baseline.minutes - broken.minutes >= 5 && broken.peakC < CLIFF_C) {
    failures.push(
      `§4 a controller stuck at ${stuck} A also passes — §4 is not discriminating and the check proves nothing`
    );
  }
}

// ── §4b ⚠️ THE CASE WHERE DOING NOTHING IS THE RIGHT ANSWER ────────────────
//
// On a cold day full current never reaches the cliff, so a correct controller LEAVES IT ALONE.
// Without this the check cannot see over-throttling at all: under the fitted constants every stop
// in REPLAY_SESSIONS is doomed to cross 55 °C whatever happens, so a controller that throttles a
// charge it should not have is unrepresentable — six mutations survived until this was added, and
// the approved plan (#142 §3.7 item 7) asked for it and it was dropped.
for (const cold of COLD_PLANTS) {
  const setup = { arrivalC: cold.arrivalC, ambientC: cold.ambientC, fromSoc: 20, toSoc: 80, cooling: cold.cooling };
  const baseline = replayCharge({ ...setup, control: false });
  const controlled = replayCharge(setup);
  if (baseline.peakC >= CLIFF_C) {
    failures.push(
      `§4b "${cold.name}" is not actually a cold plant — full current peaks at ${baseline.peakC.toFixed(1)} °C`
    );
  }
  const capped = [...controlled.reasons.entries()]
    .filter(([reason]) => reason !== CHARGE_AUTO_REASON.NO_HISTORY && reason !== CHARGE_AUTO_REASON.SETTLED)
    .reduce((total, [, count]) => total + count, 0);
  if (capped > 0) {
    failures.push(
      `§4b "${cold.name}": the controller acted ${capped} time(s) on a charge that never approaches the cliff — ` +
        `it must leave a cold pack alone`
    );
  }
  if (controlled.minutes > baseline.minutes + 0.1) {
    failures.push(
      `§4b "${cold.name}": ${(controlled.minutes - baseline.minutes).toFixed(1)} min slower than doing nothing, ` +
        `on a charge where doing nothing was right`
    );
  }
}

// ── §5 the floor is above the point where acting is worse than not ─────────
//
// m11: this is the single knob. Break-even against the saw-tooth's measured duty-weighted mean.
const breakEven = minutesPerPointAt(1) / SAWTOOTH_MIN_PER_POINT;
if (minutesPerPointAt(MIN_COMMAND_A) >= SAWTOOTH_MIN_PER_POINT) {
  failures.push(
    `§5 MIN_COMMAND_A = ${MIN_COMMAND_A} A takes ${minutesPerPointAt(MIN_COMMAND_A).toFixed(3)} min/SOC-point, ` +
      `no better than the ${SAWTOOTH_MIN_PER_POINT} the cliff itself averages — capping there is worse than doing nothing`
  );
}
if (MIN_COMMAND_A < breakEven) {
  failures.push(`§5 MIN_COMMAND_A = ${MIN_COMMAND_A} A is under the ${breakEven.toFixed(1)} A break-even`);
}

// ── §6 no branch is dead, and the constants stay coupled ───────────────────
const exercised = new Set<number>();
for (const session of REPLAY_SESSIONS) {
  for (const reason of replayCharge({ ...session }).reasons.keys()) {
    exercised.add(reason);
  }
}
// ⚠️ CLEAR lives only here: the 2026-09-07 stops all stay hot once throttled, so nothing in them
// ever earns current back. A controller that only ratchets down would otherwise pass everything.
const recovery = replayCharge({ ...RECOVERY_PLANT, fromSoc: 20, toSoc: 80 });
for (const reason of recovery.reasons.keys()) {
  exercised.add(reason);
}
// ⚠️ Step size and chatter, which peak temperature and total time cannot see. A coarse step turns
// the controller into a bang-bang switch between the ceiling and the floor, and no hysteresis makes
// it oscillate — both of which "never crosses the cliff" is perfectly happy with.
const distinctCommands = new Set(recovery.commands).size;
if (distinctCommands < 3) {
  failures.push(
    `§6 the recovery plant only ever commanded ${distinctCommands} distinct current(s) — with STEP_A this coarse ` +
      `the controller is a switch between the ceiling and the floor, not a controller`
  );
}
let reversals = 0;
for (let at = 2; at < recovery.commands.length; at += 1) {
  const before = Math.sign(recovery.commands[at - 1] - recovery.commands[at - 2]);
  const after = Math.sign(recovery.commands[at] - recovery.commands[at - 1]);
  if (before !== 0 && after !== 0 && before !== after) {
    reversals += 1;
  }
}
if (reversals > 2) {
  failures.push(
    `§6 the commanded current changed direction ${reversals} times on one charge — the hysteresis is not ` +
      `holding it, and every reversal is a frame on the bus and a number moving on the rider's dash`
  );
}
if ((recovery.reasons.get(CHARGE_AUTO_REASON.CLEAR) ?? 0) === 0) {
  failures.push(
    `§6 the recovery plant never gives current back — the CLEAR half of the rule is untested, and a ` +
      `controller that only ever steps down would pass this check`
  );
}
for (const name of ["BLIND_DESCENT", "HARD_CEILING", "CLOSING", "CLEAR"] as const) {
  if (!exercised.has(CHARGE_AUTO_REASON[name])) {
    failures.push(`§6 no replay ever reaches ${name} — either it is dead or the replays stopped covering it`);
  }
}
if (HORIZON_MIN * 60_000 < RATE_WINDOW_MS / 2) {
  failures.push(
    `§6 HORIZON_MIN (${HORIZON_MIN} min) no longer covers half the rate window (${RATE_WINDOW_MS / 60_000} min), ` +
      `which is the estimator's own lag — the horizon was sized against it`
  );
}
if (HARD_CEILING_C >= CLIFF_C) {
  failures.push(`§6 HARD_CEILING_C (${HARD_CEILING_C}) must sit below the cliff (${CLIFF_C})`);
}
// ⚠️ Asserted rather than left to luck. The hard ceiling is evaluated on temperature ALONE and
// before the rate branch, but if the blind-descent threshold ever rose above it there would be a
// band where a pack too hot to see is neither descended nor ceilinged — which is the "54.16 °C and
// the controller never acted" scenario the plan review caught in an earlier draft.
if (BLIND_DESCENT_FROM_C > HARD_CEILING_C) {
  failures.push(
    `§6 BLIND_DESCENT_FROM_C (${BLIND_DESCENT_FROM_C}) is above HARD_CEILING_C (${HARD_CEILING_C}), leaving a band ` +
      `where a pack with no usable rate is neither descended nor held down`
  );
}

// ── §7 the reason codes survive the dashboard's plausibility gate ──────────
const reasonBounds = boundsFor("charge_auto_reason", "", "charge");
for (const [name, code] of Object.entries(CHARGE_AUTO_REASON)) {
  if (!reasonBounds || code < reasonBounds[0] || code > reasonBounds[1]) {
    failures.push(
      `§7 CHARGE_AUTO_REASON.${name} = ${code} falls outside bounds.js's rule — the page would reject it as a dead ` +
        `sensor and keep showing the previous reason`
    );
  }
}

// ── §8 the dashboard's copy of the reason codes has not drifted ───────────
//
// ⚠️ The page cannot import the enum — no build step — so public/views/charge-auto.js keeps a
// hand-written mirror, exactly as public/lib/fan-display.js does for FAN_REASON. A code added here
// and not there renders as nothing at all, which is how a rider ends up watching a blank line while
// the controller does something.
for (const [name, code] of Object.entries(CHARGE_AUTO_REASON)) {
  if (REASON_TEXT[code] === undefined) {
    failures.push(`§8 public/views/charge-auto.js has no wording for CHARGE_AUTO_REASON.${name} (${code})`);
  }
  if (CHARGE_AUTO_REASON_TEXT[code] === undefined) {
    failures.push(`§8 src/http/charge-auto.ts has no wording for CHARGE_AUTO_REASON.${name} (${code})`);
  }
}
for (const code of Object.keys(REASON_TEXT)) {
  if (!Object.values(CHARGE_AUTO_REASON).includes(Number(code) as never)) {
    failures.push(`§8 the page has wording for reason ${code}, which CHARGE_AUTO_REASON no longer defines`);
  }
}

if (failures.length > 0) {
  console.error(`✗ ${failures.length} charge-auto failure(s):`);
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  process.exit(1);
}
console.log(
  `✓ all ${FAIL_SAFE.length} fail-safe branches hold and none commands a current; the estimator bounds a flat pack ` +
    `rather than calling it unknown, reads unknown on too little history, recovers a known slope, and is not driven ` +
    `by the saw-tooth; across ${REPLAY_SESSIONS.length}×${PLANTS.length} replays the controller never peaks above ` +
    `the do-nothing baseline and never causes a crossing, costing at worst ${worstPenalty.toFixed(1)} min and saving ` +
    `at best ${(-bestSaving).toFixed(1)}; DC2 finishes ${saved.toFixed(1)} min sooner and under the cliff, which ` +
    `neither a controller stuck at the ceiling nor one stuck at the floor can do; the floor stays above the ` +
    `${breakEven.toFixed(1)} A break-even; every branch is exercised, every reason code is inside bounds.js, ` +
    `and the dashboard's copy of the reason wording has not drifted`
);

/** A whole-degree ramp over ten minutes, sampled when the integer changes, as the bike delivers it. */
function climbing(fromC: number, toC: number): TemperatureSample[] {
  const samples: TemperatureSample[] = [];
  for (let step = 0; step <= 10; step += 1) {
    samples.push({ atMs: 100_000 + step * 60_000, celsius: Math.floor(fromC + ((toC - fromC) * step) / 10) });
  }
  return samples;
}

/** A pack sitting still: the reading never moves, which is what bounds rather than blinds the rate. */
function steady(celsius: number, spanMs: number): TemperatureSample[] {
  return [
    { atMs: 0, celsius },
    { atMs: spanMs / 2, celsius },
    { atMs: spanMs, celsius },
  ];
}

/** The hottest cell oscillating on a ~2 min period with no bulk drift under it. */
function sawtoothAround(celsius: number): TemperatureSample[] {
  // Three distinct values, so this reaches the SLOPE path rather than being bounded away — the
  // assertion is about the slope not tracking the oscillation, so it has to get there.
  const swing = [0, 1, 2, 1];
  const samples: TemperatureSample[] = [];
  for (let step = 0; step <= 12; step += 1) {
    samples.push({ atMs: step * 50_000, celsius: celsius + swing[step % swing.length] });
  }
  return samples;
}
