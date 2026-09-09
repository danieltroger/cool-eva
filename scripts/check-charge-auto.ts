import {
  AMPS_PER_KELVIN,
  type ChargeAutoDecision,
  CHARGE_AUTO_REASON,
  CLIFF_C,
  MAX_STEP_A,
  MIN_COMMAND_A,
  MIN_STEP_A,
  QUANTISATION_K,
  REACTION_MIN,
  TARGET_C,
  decideChargeCurrent,
  type ChargeAutoInput,
} from "../src/charge/auto-curve.ts";
import {
  estimateHeatingRate,
  minutesSinceNewestSample,
  RATE_MIN_SPAN_MS,
  RATE_WINDOW_MS,
  type TemperatureSample,
} from "../src/charge/rate.ts";
import {
  COLD_PLANTS,
  CROSSING_GRID,
  FULL_CURRENT_A,
  PLANTS,
  RECOVERY_PLANT,
  REPLAY_SESSIONS,
  SAWTOOTH_MIN_PER_POINT,
  minutesPerPointAt,
  replayCharge,
} from "./charge-auto-plant.ts";
import { boundsFor } from "../public/lib/bounds.js";
import {
  COOLING_AT_53_MS,
  COOLING_EPISODE,
  DRIFTING_AT_53_MS,
  DRIFTING_EPISODE,
  SEPTEMBER_9_AT_45A_MS,
  SEPTEMBER_9_EPISODE,
  SEPTEMBER_9_RATCHET_MS,
} from "./charge-auto-episode.ts";
import { REASON_RIDER, toggleAction } from "../public/views/charge-auto.js";
import { CHARGE_AUTO_REASON_TEXT } from "../src/http/charge-auto.ts";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { CHARGE_MANAGER_STATE_DC } from "../src/fan/curve.ts";
import { defineSignals, record } from "../src/can/signals.ts";
import { SIGNALS } from "../src/can/registry.ts";
import { startChargeAutomatic } from "../src/charge/auto.ts";
import { createVcuWriteRunner } from "../src/vcu/write-runner.ts";

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
  // ⚠️ The ring ENDS on the reading. Both come from `batt_temp_hi`, so a base fixture whose ring
  // says 54 while it claims 51 is the shape `decideOnRing` below exists to forbid, one spread away.
  samples: climbing(45, 51),
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
// Two distinct degrees across five minutes bounds the rate at 0.4 K/min, which puts a pack 3 K
// from the cliff 7.5 minutes away — inside the horizon.
const boundedClosing = decideOnRing(
  [
    { atMs: 100_000, celsius: 51 },
    { atMs: 200_000, celsius: 52 },
  ],
  400_000,
  70
);
if (boundedClosing.kind !== "command" || boundedClosing.reason !== CHARGE_AUTO_REASON.CLOSING) {
  failures.push(
    `§2 a bounded rate that puts the cliff inside the horizon must still close: got ${JSON.stringify(boundedClosing)}`
  );
}
// ⚠️ The deadband, BOTH SIDES, and expressed in headroom rather than in amps — 0.5 K is 1 A at a
// gain of 2 and 4 A at a gain of 8, so an amps-shaped assertion would silently mean something
// different for every candidate in the sweep. One-sided passes with the deadband deleted, which is
// why just-outside is asserted too: without it every tick either steps up or down and the current
// oscillates for the whole charge while "never crosses the cliff" stays true.
for (const probe of [
  { name: "inside", headroomKelvin: QUANTISATION_K * 0.5, expectHold: true },
  { name: "just outside", headroomKelvin: QUANTISATION_K * 1.5, expectHold: false },
]) {
  // Pick the rate that puts the pack exactly `headroomKelvin` below the setpoint one reaction away.
  const temperature = 50;
  const perMinute = (TARGET_C - temperature - probe.headroomKelvin) / REACTION_MIN;
  const decision = decideOnRing(atRate(temperature, perMinute), RATE_WINDOW_MS, 60);
  const held = decision.kind === "hold";
  if (held !== probe.expectHold) {
    failures.push(
      `§2 ${probe.headroomKelvin.toFixed(2)} K of headroom is ${probe.name} the ${QUANTISATION_K} K deadband, so the ` +
        `rule must ${probe.expectHold ? "hold" : "act"}: got ${JSON.stringify(decision)}`
    );
  }
}

// ── §2b ⚠️ THE SILENCE CAP — the defect behind 45 A at a reading of 51 °C ──
//
// A least-squares slope is fitted to the SAMPLES, and a whole-degree sensor emits none while it
// sits still — so a pack that climbs fast and then flattens keeps reporting the steep slope. The
// silence is itself a bound: unmoved for `t` minutes means under `1/t` K/min.
const staleSlope = estimateHeatingRate(SEPTEMBER_9_EPISODE, SEPTEMBER_9_RATCHET_MS);
const silence = minutesSinceNewestSample(SEPTEMBER_9_EPISODE, SEPTEMBER_9_RATCHET_MS);
if (silence === null || Math.abs(silence - 7.683) > 0.01) {
  failures.push(`§2b the 2026-09-09 fixture should be silent for 7.68 min at the ratchet tick, got ${silence}`);
}
if (staleSlope.kind !== "rate" || silence === null || staleSlope.perMinute > 1 / silence + 1e-9) {
  failures.push(
    `§2b the fitted slope was not capped by the silence: got ${JSON.stringify(staleSlope)} with the reading ` +
      `unmoved for ${silence?.toFixed(2)} min, which alone bounds the rate at ${silence ? (1 / silence).toFixed(3) : "?"}`
  );
}
// ⚠️ BOTH SIDES OF THE BOUND. A reading that has not moved cannot have moved DOWN a degree either,
// so a stale COOLING slope is exactly as expired as a stale heating one — and capping only the
// heating side lets it through as free headroom and RAISES the current. Measured before the fix:
// a −1 K/min slope survived 7 min of silence (where the bound is 0.143) and jumped 50 → 65 A, a
// full MAX_STEP_A, at a reading of 53 where the rule it replaces holds.
const staleCooling = [
  { atMs: 0, celsius: 56 },
  { atMs: 60_000, celsius: 55 },
  { atMs: 120_000, celsius: 54 },
  { atMs: 180_000, celsius: 53 },
];
const coolingSilence = minutesSinceNewestSample(staleCooling, 600_000);
const cappedCooling = estimateHeatingRate(staleCooling, 600_000);
if (cappedCooling.kind !== "rate" || coolingSilence === null || cappedCooling.perMinute < -1 / coolingSilence - 1e-9) {
  failures.push(
    `§2b a stale COOLING slope was not capped by the silence: got ${JSON.stringify(cappedCooling)} with the reading ` +
      `unmoved for ${coolingSilence?.toFixed(2)} min, which bounds the rate at ±${coolingSilence ? (1 / coolingSilence).toFixed(3) : "?"}. ` +
      `An uncapped negative slope reads as free headroom and raises the current.`
  );
}
// And that the DECISION follows: the step must be sized by the bound, not by the expired slope.
const onStaleCooling = decideOnRing(staleCooling, 600_000, 50);
if (onStaleCooling.kind === "command" && onStaleCooling.amps - 50 >= MAX_STEP_A) {
  failures.push(
    `§2b a pack whose reading has not moved for ${coolingSilence?.toFixed(1)} min was raised by ` +
      `${onStaleCooling.amps - 50} A on the strength of a slope the silence has expired`
  );
}

// ⚠️ And that the cap only ever LOWERS: §2's `climbingRate` above recovers 0.6 K/min from a pack
// whose reading is still ticking, which is the same assertion — the bound there is large and must
// leave the fitted slope untouched, or this would flatten a genuinely climbing pack.
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
// ⚠️ PROPORTIONALITY, not a distinct-command count. Counting distinct currents on one plant said
// more about the plant than the rule — the recovery plant needs only two moves and gets them right.
// What separates a proportional law from a fixed ratchet is the SIZE of its steps varying with the
// error, so that is what is asserted, over every replay. A 5 A ratchet emits one or two distinct
// step sizes in a whole charge; this must do better on at least one.
// ⚠️ INTERIOR steps only — ones that neither land on the floor nor on the ceiling. A clamped step
// is any size at all: a 5 A ratchet stepping down from 38 A lands on the 35 A floor and looks like
// a 3 A step, which made an earlier version of this assertion pass under the very mutation it was
// written to catch.
const stepSizes = new Set<number>();
for (const run of everyReplay()) {
  for (let at = 1; at < run.commands.length; at += 1) {
    const landedOn = run.commands[at];
    if (landedOn <= MIN_COMMAND_A || landedOn >= Math.floor(FULL_CURRENT_A)) {
      continue;
    }
    stepSizes.add(Math.abs(Math.round(landedOn - run.commands[at - 1])));
  }
}
if (stepSizes.size < 3) {
  failures.push(
    `§6 the commanded step took only ${stepSizes.size} distinct size(s) across every replay — a proportional law ` +
      `whose step does not vary with the error is a fixed ratchet wearing a gain`
  );
}
// ⚠️ #186 defect 2, asserted as a property rather than against the constant: the bike accepts 1 A
// and the dash's own dial moves in 5 A. A controller that never commands a step finer than the dial
// has not used the resolution, whatever MIN_STEP_A happens to say.
const finestStep = Math.min(...[...stepSizes].filter(size => size > 0));
if (!(finestStep < 5)) {
  failures.push(
    `§6 the finest unclamped step across every replay was ${finestStep} A — no finer than the dash's own dial, ` +
      `so the 1 A resolution the bike accepts is going unused`
  );
}
// ⚠️ CHATTER, scored against the rule this replaces rather than against a number someone liked.
// The shipped 5 A ratchet reverses 14 times on DC2/b*2 — a fact no assertion in this file used to
// look at, because the old reversal check scored the recovery plant alone, where it reverses once.
const SHIPPED_WORST_REVERSALS = 14;
let worstReversals = 0;
let worstReversalsOn = "";
for (const run of everyReplay()) {
  let reversals = 0;
  for (let at = 2; at < run.commands.length; at += 1) {
    const before = Math.sign(run.commands[at - 1] - run.commands[at - 2]);
    const after = Math.sign(run.commands[at] - run.commands[at - 1]);
    if (before !== 0 && after !== 0 && before !== after) {
      reversals += 1;
    }
  }
  if (reversals > worstReversals) {
    worstReversals = reversals;
    worstReversalsOn = run.name;
  }
}
if (worstReversals > SHIPPED_WORST_REVERSALS) {
  failures.push(
    `§6 the commanded current changed direction ${worstReversals} times on ${worstReversalsOn}, worse than the ` +
      `${SHIPPED_WORST_REVERSALS} the 5 A ratchet this replaces manages on DC2/b*2 — every reversal is a frame on ` +
      `the bus and a number moving on the rider's dash`
  );
}
// ⚠️ Pinned WITH the constants it was measured at, like CROSSING_GRID: change the gain and this
// number means something else. At gain 2 / max step 15 / reaction 12 the worst is 3.
const EXPECTED_WORST_REVERSALS = 3;
if (AMPS_PER_KELVIN === 2 && MAX_STEP_A === 15 && REACTION_MIN === 12 && worstReversals !== EXPECTED_WORST_REVERSALS) {
  failures.push(
    `§6 the worst reversal count is ${worstReversals}, not the ${EXPECTED_WORST_REVERSALS} pinned for these ` +
      `constants — re-derive it and say why in the commit rather than letting it drift`
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
if (REACTION_MIN * 60_000 < RATE_WINDOW_MS / 2) {
  failures.push(
    `§6 REACTION_MIN (${REACTION_MIN} min) no longer covers half the rate window (${RATE_WINDOW_MS / 60_000} min), ` +
      `which is the estimator's own lag — the reaction time was sized against it`
  );
}
if (TARGET_C >= CLIFF_C) {
  failures.push(`§6 the setpoint (${TARGET_C}) must sit below the cliff (${CLIFF_C})`);
}
if (MIN_STEP_A < 1 || MIN_STEP_A > MAX_STEP_A) {
  failures.push(`§6 the step bounds must read 1 <= MIN_STEP_A (${MIN_STEP_A}) <= MAX_STEP_A (${MAX_STEP_A})`);
}
// ⚠️ Replaces the old BLIND_DESCENT_FROM_C ordering assertion rather than dropping it. That one
// existed to stop a band opening where a pack too hot to see is neither descended nor held down —
// the "54.16 °C and the controller never acted" scenario. The blind branch now keys on the setpoint
// itself, so the band cannot open by construction; this asserts the branch still fires there.
const blindAtTarget = decideOnRing([{ atMs: 100_000, celsius: TARGET_C }], 200_000, 70);
if (blindAtTarget.kind !== "command" || blindAtTarget.reason !== CHARGE_AUTO_REASON.BLIND_DESCENT) {
  failures.push(
    `§6 a pack at the setpoint with no usable rate must descend blind, or there is a band where it is ` +
      `neither descended nor held down: got ${JSON.stringify(blindAtTarget)}`
  );
}
const blindBelowTarget = decideOnRing([{ atMs: 100_000, celsius: TARGET_C - 1 }], 200_000, 70);
if (blindBelowTarget.kind !== "hold" || blindBelowTarget.reason !== CHARGE_AUTO_REASON.NO_HISTORY) {
  failures.push(
    `§6 below the setpoint with no rate the answer is the fail-safe one — hold and change nothing: ` +
      `got ${JSON.stringify(blindBelowTarget)}`
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
// The sentence travels on the wire, so there is one copy of it. This asserts every code has one and
// that none is left over: a code added to the enum and not to the table renders as a blank line
// while the controller is doing something.
for (const [name, code] of Object.entries(CHARGE_AUTO_REASON)) {
  if (!CHARGE_AUTO_REASON_TEXT[code]) {
    failures.push(`§8 src/http/charge-auto.ts has no wording for CHARGE_AUTO_REASON.${name} (${code})`);
  }
}
for (const code of Object.keys(CHARGE_AUTO_REASON_TEXT)) {
  if (!Object.values(CHARGE_AUTO_REASON).includes(Number(code) as never)) {
    failures.push(`§8 there is wording for reason ${code}, which CHARGE_AUTO_REASON no longer defines`);
  }
}

// ── §9 taking the controller back is ONE tap ───────────────────────────────
//
// ⚠️ While stood down the effective mode is still `automatic`, so a plain on/off toggle reads
// "Switch off for this charge" — the opposite of what the rider wants — and taking it back means
// tapping off and then on, two taps through a label that says the wrong thing. All three states are
// asserted, because the middle one is the whole point and the other two are what it must not break.
/** Any floor; the sentence is what is under test, not the number in it. */
const FLOOR_FOR_TEXT = 35;

const RETAKE_CASES = [
  { name: "stood down by the rider", mode: "automatic" as const, reason: CHARGE_AUTO_REASON.RIDER, posts: "automatic" },
  { name: "running normally", mode: "automatic" as const, reason: CHARGE_AUTO_REASON.CLOSING, posts: "off" },
  { name: "switched off", mode: "off" as const, reason: CHARGE_AUTO_REASON.DISABLED, posts: "automatic" },
];
// ⚠️ FIRST: the page cannot import the enum (no build step), so it keeps a hand-copied `4`. Feeding
// that same constant in as the input would assert it against itself — set it to 12 and every other
// assertion here stays green while the feature is silently dead on the bike.
if (REASON_RIDER !== CHARGE_AUTO_REASON.RIDER) {
  failures.push(
    `§9 public/views/charge-auto.js's REASON_RIDER is ${REASON_RIDER}, but CHARGE_AUTO_REASON.RIDER is ` +
      `${CHARGE_AUTO_REASON.RIDER} — the page would never offer to take the controller back`
  );
}
const labels = new Set<string>();
for (const retake of RETAKE_CASES) {
  const action = toggleAction(retake.mode, retake.reason, FLOOR_FOR_TEXT);
  labels.add(action.label);
  if (action.mode !== retake.posts) {
    failures.push(`§9 ${retake.name}: the button POSTs mode=${action.mode}, expected ${retake.posts}`);
  }
  if (action.note.length === 0) {
    failures.push(`§9 ${retake.name}: no sentence under the button saying what it will do`);
  }
}
if (labels.size !== RETAKE_CASES.length) {
  failures.push(
    `§9 the three states share ${RETAKE_CASES.length - labels.size + 1} label(s) — a rider stood down would be ` +
      `offered the same words as one running normally, which is the two-tap trap this replaced`
  );
}
// ⚠️ And that the stood-down case is not merely the off-state's wording reused: it must say the
// controller stopped BECAUSE the rider set a current, or the button is honest and the note is not.
const stoodDown = toggleAction("automatic", CHARGE_AUTO_REASON.RIDER, FLOOR_FOR_TEXT);
if (!/you set the current/i.test(stoodDown.note)) {
  failures.push(`§9 the stood-down note does not say why the Pi stopped: "${stoodDown.note}"`);
}

// ── §10 the setpoint, against REAL thermal episodes ───────────────────────
//
// ⚠️ The simulated plant barely reaches the state this section is for. Measured on the rule this
// REPLACES, over the frozen 150-plant grid: 2 380 ticks at a reading of 53 or 54 and not one with a
// fitted slope at or below zero. Under this rule it is 2 072 and 13 — better, because the pack now
// sits at the setpoint instead of being ratcheted past it, but still 0.6 %. Its packs are otherwise
// always rising or pinned at the floor; the bike gets there by oscillating across the boundary. So
// the arbiter for "hold at 54, raise at 53" is logged `batt_temp_hi` and the synthetic rings below,
// never §11.
//
// ⚠️ THREE ASSERTIONS #181 SHIPPED ARE DELIBERATELY REVERSED HERE — 53 while falling and 53
// drifting up now RAISE, 54 while cooling now HOLDS. Why the margin #181 bought is being spent,
// and what guards the cliff instead: docs/charge-auto.md § "Superseded: the two tiers".
const exercisedByEpisode: number[] = [];

const coolingAt53 = decideOnRing(COOLING_EPISODE, COOLING_AT_53_MS, 60);
exercisedByEpisode.push(coolingAt53.reason);
if (coolingAt53.kind !== "command" || coolingAt53.amps <= 60) {
  failures.push(
    `§10 the pack read 53 °C while FALLING (13:51 on 2026-08-08, on its way to 50) — a degree below the ` +
      `setpoint and cooling, so the current must go UP. The old single ceiling throttled this four ticks ` +
      `running and #181 held it; both are superseded. Got ${JSON.stringify(coolingAt53)}`
  );
}

// ⚠️ THE HOLD AT THE SETPOINT — Daniel's headline ask, and the one that was unreachable. `bounded` is
// strictly positive by construction, so feeding it into a headroom already clamped to ≤ 0 stepped a
// perfectly still pack down every tick: NEAR_CEILING fired 0 times in 6 770 grid ticks before the
// fix and 417 after. All three states are asserted, because the middle one is what "hold 54 in both
// directions" means and the other two are what it must not break.
const AT_54 = [
  // ⚠️ 8.5 minutes past the newest sample, so the estimator is in the `bounded` branch — which is
  // the whole point: a bound is what a still pack produces, and it is not evidence of heating. The
  // three entries share one ring builder; what separates them is the tick they are read at.
  {
    name: "sitting still at 54 (the reading has not moved — a bound, not evidence of heating)",
    samples: rampTo(53, 54),
    atMs: 660_000,
    hold: true,
  },
  // ⚠️ The MAJORITY case, and the one a fixture was missing: 387 of the 417 grid holds are on a
  // pack that is genuinely still rising. Read early, so the bound is LARGE (0.4 K/min) — the point
  // is that no bound, however big, lowers at the setpoint, because a bound is not a measurement.
  { name: "still rising onto 54, on a large bound", samples: rampTo(53, 54), atMs: 300_000, hold: true },
  { name: "falling onto 54", samples: rampTo(57, 54), atMs: 480_000, hold: true },
  { name: "rising onto 54", samples: rampTo(51, 54), atMs: 480_000, hold: false },
];
for (const state of AT_54) {
  const decision = decideOnRing(state.samples, state.atMs, 60);
  exercisedByEpisode.push(decision.reason);
  const held = decision.kind === "hold";
  if (held !== state.hold) {
    failures.push(
      `§10 a pack ${state.name} must ${state.hold ? "HOLD — that is the setpoint doing its job" : "be REDUCED"}: ` +
        `got ${JSON.stringify(decision)}`
    );
  }
  if (!state.hold && decision.kind === "command" && decision.amps >= 60) {
    failures.push(`§10 a pack ${state.name} must be reduced, not raised: got ${JSON.stringify(decision)}`);
  }
}
// ⚠️ And on the REAL episode, at a tick where the ring's newest reading really is 54: the window
// still remembers the climb to 55, so the fitted slope is positive and the rule reduces. There is
// no tick in any logged episode we hold where the reading is 54 AND the fitted slope is ≤ 0 — that
// state is asserted synthetically above and the honest statement is that the bike has not shown it.
const realAt54 = decideOnRing(COOLING_EPISODE, 900_000, 60);
if (realAt54.kind !== "command" || realAt54.amps >= 60) {
  failures.push(
    `§10 on 2026-08-08 at a reading of 54 with the window still holding the climb to 55, the fitted slope is ` +
      `positive and the current must come down: got ${JSON.stringify(realAt54)}`
  );
}
// ⚠️ The pack a degree below the setpoint, drifting slowly UP (+0.037 K/min on real logged data).
// #181 forbade raising here on the grounds that 53 can be a true 53.99; the setpoint rule raises,
// because 53.99 is still below 54 and the cliff is a further degree away. This is the fixture that
// would go red if the no-raise tier were quietly reinstated.
const driftingAt53 = decideOnRing(DRIFTING_EPISODE, DRIFTING_AT_53_MS, 60);
exercisedByEpisode.push(driftingAt53.reason);
if (driftingAt53.kind !== "command" || driftingAt53.amps <= 60) {
  failures.push(
    `§10 a pack reading 53 °C and drifting slowly UP (2026-09-07 15:26, +0.037 K/min) is a degree below the ` +
      `setpoint and must be given current, not held. Got ${JSON.stringify(driftingAt53)}`
  );
}

// The setpoint rule must not become a raise-only rule: a pack at 53 climbing fast still steps down,
// because at that rate it is past 54 well inside one reaction time.
const risingAt53 = decideOnRing(climbing(48, 53), 700_000, 60);
if (risingAt53.kind !== "command" || risingAt53.amps >= 60) {
  failures.push(`§10 a pack at 53 °C climbing fast must still be reduced, got ${JSON.stringify(risingAt53)}`);
}

// ⚠️ NEAR_CEILING is produced only by the real-episode fixtures — the plant never reaches it — so
// it is asserted here rather than in §6, which runs before them. A reason nothing emits is a reason
// nobody will ever see on the dash.
if (!exercisedByEpisode.includes(CHARGE_AUTO_REASON.NEAR_CEILING)) {
  failures.push("§10 no fixture ever produces NEAR_CEILING — the hold at the setpoint is not being reached");
}

// ── §11 the crossing set over a frozen grid ────────────────────────────────
//
// ⚠️ THE ONE ASSERTION THAT NOTICES A RULE GETTING LESS SAFE WITHOUT GETTING WRONG. Every other
// section judges the controller against the do-nothing baseline or a fixture; none can see "still
// never crosses where the baseline does, but now crosses where the PREVIOUS rule did not".
//
// A golden count over a FROZEN grid, because the alternative is keeping the old rule alive in the
// tree forever to diff against. If the grid moves the number is meaningless — see CROSSING_GRID.
// ⚠️ The SET, not just the count: naming which plants cross says whether a change added new ones
// or merely moved the boundary, which are different findings and only one of them is a regression.
//
// ⚠️ RE-DERIVED for #186, 24 → 16, a STRICT SUBSET — eight stopped crossing, none started. Two
// changes moved it in OPPOSITE directions and reading 16 as "the estimator cap was free" is the
// wrong conclusion: docs/charge-auto.md § "The silence is a bound too" carries both tables.
const EXPECTED_CROSSINGS = [
  "44/35/0.0044",
  "44/39/0.0044",
  "48/30/0.0044",
  "48/35/0.0044",
  "48/39/0.0044",
  "51/25/0.0044",
  "51/30/0.0044",
  "51/35/0.0044",
  "51/39/0.0044",
  "51/39/0.0089",
  "54/18/0.0044",
  "54/25/0.0044",
  "54/30/0.0044",
  "54/35/0.0044",
  "54/39/0.0044",
  "54/39/0.0089",
];
const crossed: string[] = [];
for (const arrivalC of CROSSING_GRID.arrivals) {
  for (const ambientC of CROSSING_GRID.ambients) {
    for (const cooling of CROSSING_GRID.coolings) {
      const run = replayCharge({
        arrivalC,
        ambientC,
        cooling,
        fromSoc: CROSSING_GRID.fromSoc,
        toSoc: CROSSING_GRID.toSoc,
      });
      if (run.peakC >= CLIFF_C) {
        crossed.push(`${arrivalC}/${ambientC}/${cooling.toFixed(4)}`);
      }
    }
  }
}
const added = crossed.filter(plant => !EXPECTED_CROSSINGS.includes(plant));
const removed = EXPECTED_CROSSINGS.filter(plant => !crossed.includes(plant));
if (added.length > 0) {
  failures.push(
    `§11 the rule now crosses ${CLIFF_C} °C on ${added.length} plant(s) it did not before ` +
      `(arrival/ambient/cooling: ${added.join(", ")}) — LESS safe than what it replaced`
  );
}
if (removed.length > 0 && added.length === 0) {
  failures.push(
    `§11 ${removed.length} plant(s) no longer cross (${removed.join(", ")}). That may be an improvement — ` +
      `re-derive the frozen set and say why in the commit, rather than letting it drift silently`
  );
}
const crossings = crossed.length;

// ── §12 ⚠️ THE ECHO, AND THE ORDERING THAT MADE IT BITE ────────────────────
//
// The bike answers our own `0x120` commit with a `0x121` carrying the amps we just asked for. Two
// things have to hold: only a DIFFERENT setpoint is the rider, and the value we sent is recorded
// BEFORE the frames go out — `sendChargeCommand` awaits twice and the echo lands inside that
// window. docs/can-0x121-charge-command.md has the capture.
//
// ⚠️ Driven through the REAL write runner with a stub channel, not a fake sink: a fake sink
// replaces the very function whose internal ordering is the bug and passes with it unfixed.
{
  defineSignals(SIGNALS);
  record("charge_manager_state", CHARGE_MANAGER_STATE_DC);
  record("fast_dc_limit_max_a", 75);
  record("dc_charge_limit_selected_a", 70);
  // The write runner appends an audit record per command, so it needs somewhere to put them.
  // Removed at the end of the section rather than left behind once per run.
  const auditDirectory = await mkdtemp(join(tmpdir(), "charge-auto-check-"));
  const automatic = startChargeAutomatic({ commandChargeCurrent: async () => ({ succeeded: true, message: "" }) });
  const runner = createVcuWriteRunner({
    enabled: true,
    busIsActive: true,
    directory: auditDirectory,
    gate: () => ({ safe: true, blockers: [], checks: [], chargingEvidence: null }) as never,
    latestSweep: async () => null,
    onChargeCurrentOutgoing: (amps, origin) => automatic.noteChargeCurrentOutgoing(amps, origin),
    // The bus, as far as this test is concerned: a 0x121 carrying our own amps, delivered while
    // the send is still awaiting — which is what the capture measured at 3-10 ms.
    channel: () =>
      ({
        send: (frame: { id: number; data: Buffer }) => {
          if (frame.id === 0x121 && frame.data[0] === 0x18) {
            record("dc_charge_limit_selected_a", frame.data[2]);
          }
        },
      }) as never,
  });
  const answer = await runner.perform({ kind: "charge-current", amps: 45, origin: "automatic" });
  // The microtask that delivers the change batch has to run before the state is read.
  await new Promise(resolve => setTimeout(resolve, 0));
  if (!answer.ok) {
    failures.push(`§12 the stubbed charge-current command did not reach the bus: ${answer.reason}`);
  }
  if (automatic.state().reason === CHARGE_AUTO_REASON.RIDER) {
    failures.push(
      "§12 the controller stood itself down on the echo of its OWN command — this is #186 defect 1, and it is " +
        "what happens whenever the sent value is recorded after `sendChargeCommand` rather than before it"
    );
  }
  // ⚠️ And the half the narrowing must NOT take away: a current the rider set BY HAND, from the
  // phone, still stands the controller down unconditionally. Deleting that path left all 45 checks
  // green before this assertion existed, which made "the rider always wins" a claim with no test.
  const byHand = await runner.perform({ kind: "charge-current", amps: 52, origin: "manual" });
  await new Promise(resolve => setTimeout(resolve, 0));
  if (!byHand.ok) {
    failures.push(`§12 the stubbed hand-set command did not reach the bus: ${byHand.reason}`);
  }
  if (automatic.state().reason !== CHARGE_AUTO_REASON.RIDER) {
    failures.push(
      `§12 a charge current set BY HAND must stand the controller down whatever the echo says — that path is ` +
        `unambiguous and the narrowing is only about the bus. Got reason ${automatic.state().reason}`
    );
  }
  // Taking it back is one tap, and it must clear what the hand-set command latched.
  automatic.setMode("automatic");
  if (automatic.state().reason === CHARGE_AUTO_REASON.RIDER) {
    failures.push("§12 switching back to automatic did not clear the hand-set stand-down");
  }

  // And the other half: a setpoint that is NOT ours is still the rider, or the feature is gone.
  record("dc_charge_limit_selected_a", 62);
  await new Promise(resolve => setTimeout(resolve, 0));
  if (automatic.state().reason !== CHARGE_AUTO_REASON.RIDER) {
    failures.push(
      `§12 a setpoint of 62 A after we commanded 45 A is the rider turning the dial and must stand the ` +
        `controller down, got reason ${automatic.state().reason}`
    );
  }
  automatic.stop();
  await rm(auditDirectory, { recursive: true, force: true });
}

// ── §13 today's episode, open-loop: the two things Daniel asked for ────────
//
// ⚠️ OPEN-LOOP. These show what the rule DECIDES seeing the logged history, never what would have
// happened — a different current changes the pack's trajectory and the log cannot say how. §3 and
// §11 are the closed-loop half. The readings are `batt_temp_hi` exactly as logged on 2026-09-09.
const atTheRatchet = decideOnRing(SEPTEMBER_9_EPISODE, SEPTEMBER_9_RATCHET_MS, 70);
if (atTheRatchet.kind === "command" && atTheRatchet.amps < 70) {
  failures.push(
    `§13 at 16:03:08 on 2026-09-09 the pack read 50 °C and had not moved a whole degree for 7.7 minutes, and the ` +
      `rule reduced the current to ${atTheRatchet.amps} A — that is the ratchet #186 is about, six ticks of which ` +
      `took 70 A to 40 A while the pack sat at 50-51`
  );
}
const atFortyFive = decideOnRing(SEPTEMBER_9_EPISODE, SEPTEMBER_9_AT_45A_MS, 45);
if (atFortyFive.kind !== "command" || atFortyFive.amps <= 45) {
  failures.push(
    `§13 Daniel found the pack at 51 °C with 45 A commanded and the controller declining to climb back. Three ` +
      `degrees below the setpoint it must give current back: got ${JSON.stringify(atFortyFive)}`
  );
}

// ── §14 the blind descent, where the frozen grid cannot see it ─────────────
//
// ⚠️ §11 CANNOT arbitrate this branch: it only runs while the span is under RATE_MIN_SPAN_MS, and
// the silence cannot exceed the span, so on the grid the deficit always saturates and a fixed
// maximum step is byte-identical. The evidence for sizing it from the silence is therefore this
// fixture and the argument, never the crossing count.
// Four minutes since the reading moved bounds the rate at 0.25 K/min, so the deficit is
// REACTION_MIN / 4 kelvin and the step is well inside MAX_STEP_A.
const blindLongSilence = decideOnRing([{ atMs: 0, celsius: TARGET_C }], 240_000, 70);
const expectedBlindStep = Math.min(MAX_STEP_A, Math.max(MIN_STEP_A, Math.round((AMPS_PER_KELVIN * REACTION_MIN) / 4)));
if (blindLongSilence.kind !== "command" || 70 - blindLongSilence.amps !== expectedBlindStep) {
  failures.push(
    `§14 with the reading unmoved for 4 min the blind descent should step ${expectedBlindStep} A — the silence ` +
      `bounds the rate at 0.25 K/min and that is ${REACTION_MIN / 4} K of deficit. Got ${JSON.stringify(blindLongSilence)}`
  );
}
if (expectedBlindStep >= MAX_STEP_A) {
  failures.push(
    `§14 the fixture is saturated (${expectedBlindStep} A = the cap), so it cannot tell the derivation from a ` +
      `fixed maximum step — which is the whole reason this section exists`
  );
}
// ⚠️ No samples at all is the one case with no bound to read. A pack at the setpoint with no history
// whatsoever is the least safe thing this branch sees, so it takes the largest step allowed.
const blindNoSamples = decideChargeCurrent({
  ...HEALTHY,
  packTemperatureC: TARGET_C,
  commandedAmps: 70,
  samples: [],
  nowMs: 240_000,
});
if (blindNoSamples.kind !== "command" || 70 - blindNoSamples.amps !== MAX_STEP_A) {
  failures.push(
    `§14 with no samples at all there is no silence to bound the rate with, so the blind descent takes the ` +
      `full ${MAX_STEP_A} A: got ${JSON.stringify(blindNoSamples)}`
  );
}

if (failures.length > 0) {
  console.error(`✗ ${failures.length} charge-auto failure(s):`);
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  process.exit(1);
}
console.log(
  `✓ all ${FAIL_SAFE.length} fail-safe branches hold and none commands a current; the estimator bounds a flat ` +
    `pack rather than calling it unknown, caps a fitted slope by the silence that outlived it, reads unknown on ` +
    `too little history and is not driven by the saw-tooth; across ${REPLAY_SESSIONS.length}×${PLANTS.length} ` +
    `replays the controller never peaks above the do-nothing baseline and never causes a crossing, costing at ` +
    `worst ${worstPenalty.toFixed(1)} min and saving at best ${(-bestSaving).toFixed(1)}; DC2 finishes ` +
    `${saved.toFixed(1)} min sooner and under the cliff, which neither a controller stuck at the ceiling nor one ` +
    `stuck at the floor can do; the floor stays above the ${breakEven.toFixed(1)} A break-even; the step varies ` +
    `with the error down to ${finestStep} A unclamped and reverses at worst ${worstReversals} times against the ` +
    `5 A ratchet's ${SHIPPED_WORST_REVERSALS}; every branch is exercised, every reason code is inside bounds.js ` +
    `and has wording, and taking the controller back is one tap; against real logged episodes a pack at 54 °C ` +
    `holds when it is not heating and is reduced when it is, and one at 53 °C is given current back; the ` +
    `controller does not stand down on the echo of its own command through the real write runner, and does on a ` +
    `setpoint that is not ours; on 2026-09-09's own readings it neither throttles at 50-51 °C nor refuses to ` +
    `climb from 45 A; and ${crossings} of ` +
    `${CROSSING_GRID.arrivals.length * CROSSING_GRID.ambients.length * CROSSING_GRID.coolings.length} frozen-grid ` +
    `plants cross the cliff, a strict subset of the 24 the rule this replaces crossed`
);

/** A whole-degree ramp over ten minutes, sampled when the integer changes, as the bike delivers it. */
function climbing(fromC: number, toC: number): TemperatureSample[] {
  const samples: TemperatureSample[] = [];
  for (let step = 0; step <= 10; step += 1) {
    samples.push({ atMs: 100_000 + step * 60_000, celsius: Math.floor(fromC + ((toC - fromC) * step) / 10) });
  }
  return samples;
}

/**
 * Decides on a ring, taking the reading FROM the ring's newest sample.
 *
 * ⚠️ Both come from `batt_temp_hi`, so a fixture whose `packTemperatureC` disagrees with its newest
 * sample is an input `decide()` cannot construct — and one such fixture is how "a pack reading 54
 * while cooling" was asserted for a whole release against a ring whose newest reading was 53. The
 * reading is derived here rather than passed, so that class of fixture cannot be written again.
 */
function decideOnRing(samples: TemperatureSample[], nowMs: number, commandedAmps: number): ChargeAutoDecision {
  const newest = samples.filter(sample => sample.atMs <= nowMs).at(-1);
  if (newest === undefined) {
    throw new Error("decideOnRing needs at least one sample at or before nowMs");
  }
  return decideChargeCurrent({ ...HEALTHY, packTemperatureC: newest.celsius, commandedAmps, samples, nowMs });
}

/**
 * Every replay the chatter and proportionality assertions are scored over, named.
 *
 * ⚠️ The set A7 names, not a convenient subset. The old reversal check scored `RECOVERY_PLANT`
 * alone — the one plant where the shipped 5 A ratchet reverses once — and so never noticed it
 * reversing fourteen times on DC2/b*2.
 */
function everyReplay(): { name: string; commands: number[] }[] {
  const runs: { name: string; commands: number[] }[] = [];
  for (const session of REPLAY_SESSIONS) {
    for (const plant of PLANTS) {
      runs.push({
        name: `${session.name}/${plant.name}`,
        commands: replayCharge({
          arrivalC: session.arrivalC,
          ambientC: session.ambientC + plant.ambientOffset,
          fromSoc: session.fromSoc,
          toSoc: session.toSoc,
          cooling: plant.cooling,
        }).commands,
      });
    }
  }
  for (const cold of COLD_PLANTS) {
    runs.push({
      name: cold.name,
      commands: replayCharge({
        arrivalC: cold.arrivalC,
        ambientC: cold.ambientC,
        fromSoc: 20,
        toSoc: 80,
        cooling: cold.cooling,
      }).commands,
    });
  }
  runs.push({
    name: RECOVERY_PLANT.name,
    commands: replayCharge({ ...RECOVERY_PLANT, fromSoc: 20, toSoc: 80 }).commands,
  });
  return runs;
}

/**
 * Whole-degree crossings at exactly `perMinute`, the newest landing on `RATE_WINDOW_MS`.
 *
 * Three points, so the estimator fits a slope rather than bounding one, and zero silence at the
 * end, so the silence cap cannot bind and the rate under test is the rate asked for.
 */
function atRate(celsius: number, perMinute: number): TemperatureSample[] {
  const stepMs = 60_000 / Math.abs(perMinute);
  const direction = Math.sign(perMinute);
  const samples: TemperatureSample[] = [];
  for (let back = 2; back >= 0; back -= 1) {
    samples.push({ atMs: RATE_WINDOW_MS - back * stepMs, celsius: celsius - back * direction });
  }
  return samples;
}

/** A whole-degree ramp ending exactly on `toC`, so the ring's newest sample is the reading. */
function rampTo(fromC: number, toC: number): TemperatureSample[] {
  const direction = Math.sign(toC - fromC);
  const samples: TemperatureSample[] = [];
  for (let step = 0; step <= Math.abs(toC - fromC); step += 1) {
    samples.push({ atMs: step * 150_000, celsius: fromC + step * direction });
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
