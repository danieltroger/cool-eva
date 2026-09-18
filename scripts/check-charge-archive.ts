import { CLIFF_C, decideChargeCurrent, MIN_COMMAND_A, TARGET_C } from "../src/charge/auto-curve.ts";
import { RATE_MIN_SPAN_MS, type TemperatureSample } from "../src/charge/rate.ts";
import { ARCHIVE_SESSIONS } from "./charge-archive-sessions.ts";
import { parseSamples, PLANT_CORNERS, replayClosedLoop, replayOpenLoop } from "./charge-auto-archive.ts";

// The charge controller against EVERY DC session on record, rather than three hand-picked stops.
//
//   node --experimental-strip-types scripts/check-charge-archive.ts
//
// Run by `npm test` via scripts/run-checks.ts. Takes no arguments.
//
// ⚠️ WHAT EACH HALF CAN ANSWER. The open-loop replay drives the rule against the temperature the
// bike really produced, so it can say what the rule DECIDES and nothing about what would follow —
// the crossings are the ones the logged pack made, identical for every rule. The closed loop can
// answer crossings, trains and charge delivered, and pays for it with a model. Neither is the
// bike. docs/charge-auto.md § "Riding the setpoint".

const failures: string[] = [];

// ── §1 ⚠️ A RETURN FROM THE SETPOINT BAND IS NOT PERMISSION (#280) ─────────
//
// 31 of the 50 charging crossings in the archive come back 55 → 54 inside a minute with ~50 A
// still flowing. No conductance model calls that cooling: it is the hottest cell's saw-tooth, and
// read as "the pack has cooled, there is room" it hands the rule a raise straight back into the
// band. The cost is the TRAIN — 15 crossings in 48 minutes on 2026-09-07 — not the one excursion.
//
// The pair below is the whole fix: the same shape, one band apart. A raise waits through the first
// and is released by the second.
// ⚠️ BOTH RINGS FALL ON A FITTED SLOPE, which is the only state where this clause can be reached:
// with no fitted rate the confident-headroom gate in src/charge/step.ts holds the raise long
// before the wait is asked about. The pair differs in one thing — the band the reading fell OUT of.
const SAW_TOOTH: TemperatureSample[] = [
  { atMs: 0, celsius: 55 },
  { atMs: 150_000, celsius: 54 },
  { atMs: 300_000, celsius: 53 },
];
const COOLING: TemperatureSample[] = [
  { atMs: 0, celsius: 53 },
  { atMs: 150_000, celsius: 52 },
  { atMs: 300_000, celsius: 51 },
];
for (const probe of [
  { name: "a 54 → 53 return a minute after touching the setpoint", samples: SAW_TOOTH, hold: true },
  { name: "the same shape two degrees lower, which really is cooling", samples: COOLING, hold: false },
]) {
  // ⚠️ The command lands at 250 s and the fall at 300 s, so the fall is the one thing that could
  // release the wait — and the ring spans 420 s, past RATE_MIN_SPAN_MS, so the estimator has a
  // fitted slope rather than answering `unknown` and holding for a reason that is not this one.
  const decision = decideOnArchiveRing(probe.samples, 420_000, 250_000);
  if ((decision === "hold") !== probe.hold) {
    failures.push(
      `§1 ${probe.name}: the rule must ${
        probe.hold
          ? "wait — a fall out of the band is the saw-tooth, not room"
          : "be released, because a fall below the band is real cooling"
      }. Got ${decision}`
    );
  }
}

// ── §2 the same property over every session and every tick phase ──────────
//
// ⚠️ THE PROPERTY, not a golden series. 18 sessions × 60 phases is 1 080 command series and
// pinning them would pin the archive rather than the rule. What is pinned instead is that the rule
// never raises inside a measurement span of the reading coming back out of the setpoint band —
// and the count of replays where that opportunity ARISES, so the property cannot hold vacuously.
let sessionsWithABandReturn = 0;
let raisesAfterABandReturn = 0;
let replays = 0;
for (const session of ARCHIVE_SESSIONS) {
  // ⚠️ Once per SESSION, not once per phase: the returns are a property of the logged temperature
  // and recomputing them inside the phase loop counted the fixture sixty times over.
  const returns = bandReturns(parseSamples(session.temperature));
  if (returns.length > 0) {
    sessionsWithABandReturn += 1;
  }
  for (let phase = 0; phase < 60; phase += 1) {
    const run = replayOpenLoop(session, phase);
    replays += 1;
    // ⚠️ DISTINCT RAISES, not (return, raise) pairs: two returns inside one span counted the same
    // raise twice, and the message then said "raised N times" about a number that was not that.
    for (const command of run.commandsAt) {
      const soonAfterAReturn = returns.some(
        returnedAtMs => command.atMs > returnedAtMs && command.atMs - returnedAtMs < RATE_MIN_SPAN_MS
      );
      if (soonAfterAReturn && command.raised) {
        raisesAfterABandReturn += 1;
      }
    }
  }
}
/**
 * Measured over the archive. Pinned rather than asserted at zero, and the reason is worth stating:
 * the clause governs a fall SINCE THE LAST COMMAND, so a raise four minutes after a band return
 * with a command in between is not what #280 is about and is not forbidden.
 *
 * ⚠️ IT IS NOT A CLAUSE-SPECIFIC NUMBER, and the message must not pretend otherwise: it moves for
 * any change to the raise path at all — measured, `AMPS_PER_KELVIN` 2 → 3 gives 647 and
 * `REACTION_MIN` 12 → 10 gives 762 on the fixture this was first written against. What it is for
 * is the direction: deleting the clause makes it go UP, which is the mutation that matters, and
 * §1 above is the part that names the clause.
 */
const EXPECTED_RAISES_AFTER_A_BAND_RETURN = 432;
if (raisesAfterABandReturn !== EXPECTED_RAISES_AFTER_A_BAND_RETURN) {
  failures.push(
    `§2 ${raisesAfterABandReturn} raises landed within ${RATE_MIN_SPAN_MS / 60_000} min of the reading coming back ` +
      `out of the ${TARGET_C} °C band, across ${replays} session/phase replays, against the pinned ` +
      `${EXPECTED_RAISES_AFTER_A_BAND_RETURN}. UPWARD means the saw-tooth is being read as permission again; any ` +
      `change to the raise path moves it, so re-derive it and say which`
  );
}
/** Measured: how many of the 18 sessions even contain a return out of the band. */
const EXPECTED_SESSIONS_WITH_A_BAND_RETURN = 7;
if (sessionsWithABandReturn !== EXPECTED_SESSIONS_WITH_A_BAND_RETURN) {
  failures.push(
    `§2 ${sessionsWithABandReturn} of ${ARCHIVE_SESSIONS.length} sessions contain a return out of the band, not ` +
      `the pinned ${EXPECTED_SESSIONS_WITH_A_BAND_RETURN}. Zero would make the count above vacuous`
  );
}

// ── §3 ⚠️ THE CLOSED LOOP, ON A PLANT MEASURED FROM THIS ARCHIVE ───────────
//
// The model is the two-node balance from the post-55 recovery analysis over 56 crossings, driven
// by each session's own logged `coolant_in`. It is run at both ends of the fitted k and C, and the
// do-nothing baseline is computed in the same run so every comparison is against the same plant.
//
// ⚠️ It cannot produce the hottest cell's saw-tooth — one node, τ = C/k ≈ 25-35 min — so it
// UNDER-states what #280 is about and the crossing numbers below are a floor on the benefit, not
// a measure of it. What it can do is catch a rule that makes the pack hotter or the charge slower.
let controlledCrossings = 0;
let baselineCrossings = 0;
let controlledAmpHours = 0;
let baselineAmpHours = 0;
let minutes = 0;
let worstTrain = 0;
let baselineWorstTrain = 0;
for (const session of ARCHIVE_SESSIONS) {
  for (const corner of PLANT_CORNERS) {
    const controlled = replayClosedLoop(session, 18, corner);
    const baseline = replayClosedLoop(session, 18, corner, false);
    controlledCrossings += controlled.crossings;
    baselineCrossings += baseline.crossings;
    controlledAmpHours += controlled.ampHours;
    baselineAmpHours += baseline.ampHours;
    minutes += controlled.minutes;
    worstTrain = Math.max(worstTrain, controlled.longestTrain);
    baselineWorstTrain = Math.max(baselineWorstTrain, baseline.longestTrain);
    if (controlled.crossings > baseline.crossings) {
      failures.push(
        `§3 ${session.name} at ${corner.name}: the controller crosses ${CLIFF_C} °C ${controlled.crossings} time(s) ` +
          `against the do-nothing baseline's ${baseline.crossings} — it must never make the pack hotter`
      );
    }
  }
}
/** Measured over the archive at both plant corners. Pinned the way §11's crossing set is. */
const EXPECTED_CROSSINGS = 0;
const EXPECTED_WORST_TRAIN = 0;
if (controlledCrossings !== EXPECTED_CROSSINGS || worstTrain !== EXPECTED_WORST_TRAIN) {
  failures.push(
    `§3 the controller crosses ${controlledCrossings} time(s) with a longest train of ${worstTrain}, not the pinned ` +
      `${EXPECTED_CROSSINGS} and ${EXPECTED_WORST_TRAIN} (the baseline crosses ${baselineCrossings} with a train of ` +
      `${baselineWorstTrain}). A train is what ` +
      `#280 is about, so a change here is a change to the thing this rule exists to prevent`
  );
}
// ⚠️ AND WHAT IT COSTS IS BOUNDED RATHER THAN ASSUMED AWAY. An earlier version of this section
// asserted the controller delivers MORE charge than doing nothing. On the honest fixture that is
// false and the data says so plainly: it delivers 3.7 % LESS, and buys the 117 crossings and the
// 21-crossing train the baseline runs into. Whether that trade is good depends on what a crossing
// really costs — the field says 42 minutes over two stops, this model says about a minute each —
// so the bound is what stops the cost growing unnoticed, the way §3 of check-charge-auto.ts does.
const chargeCost = 1 - controlledAmpHours / baselineAmpHours;
if (chargeCost > 0.06) {
  failures.push(
    `§3 the controller delivered ${(chargeCost * 100).toFixed(1)} % less charge than doing nothing ` +
      `(${controlledAmpHours.toFixed(0)} Ah against ${baselineAmpHours.toFixed(0)} over ${minutes.toFixed(0)} ` +
      `minutes), over the 6 % bound. It buys crossings with that, and the price is supposed to stay small`
  );
}

// ── §4 the controller does nothing to a session that never gets hot ───────
//
// Half the archive never approaches the setpoint, and there the rule must leave the station's own
// current alone — the same claim check-charge-auto.ts §4b makes on two synthetic cold plants, here
// against every real session that stayed cold.
for (const session of ARCHIVE_SESSIONS) {
  const run = replayOpenLoop(session, 18);
  const peak = run.peakC;
  if (peak >= TARGET_C - 4) {
    continue;
  }
  const acted = run.commands.filter(amps => amps < Math.floor(session.ceilingAmps) - 1);
  if (acted.length > 0) {
    failures.push(
      `§4 ${session.name} peaked at a reading of ${peak} °C and the rule still commanded ${acted.join(", ")} A — ` +
        `a pack that never approaches the setpoint must be left alone`
    );
  }
}

if (failures.length > 0) {
  console.error(`✗ ${failures.length} charge-archive failure(s):`);
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  process.exit(1);
}
console.log(
  `✓ across ${ARCHIVE_SESSIONS.length} DC sessions on record and ${replays} session/phase replays, the rule never ` +
    `reads a return out of the ${TARGET_C} °C band as permission to raise (${sessionsWithABandReturn} sessions contain ` +
    `one); on a two-node plant measured from the same archive and run at both corners it crosses ${CLIFF_C} °C ` +
    `${controlledCrossings} times against the do-nothing baseline's ${baselineCrossings}, never more than the ` +
    `baseline on any session, with a longest train of ${worstTrain}, and delivers ` +
    `${controlledAmpHours.toFixed(0)} Ah against ${baselineAmpHours.toFixed(0)} over the same ${minutes.toFixed(0)} ` +
    `minutes; and every session that stayed more than four degrees below the setpoint was left alone`
);

/** Where the reading came back down out of the setpoint band — the saw-tooth's own signature. */
function bandReturns(samples: TemperatureSample[]): number[] {
  const returns: number[] = [];
  for (let index = 1; index < samples.length; index += 1) {
    if (samples[index - 1].celsius >= TARGET_C && samples[index].celsius < samples[index - 1].celsius) {
      returns.push(samples[index].atMs);
    }
  }
  return returns;
}

/**
 * Whether the rule raises on this ring, or waits.
 *
 * ⚠️ The reading is taken FROM the ring rather than passed, which is the hazard
 * `check-charge-auto.ts`'s `decideOnRing` exists to close: a fixture whose reading disagrees with
 * its newest sample is an input `decide()` cannot construct, and one such fixture was asserted for
 * a whole release. The command lands before the fall so the fall is the only possible release.
 */
function decideOnArchiveRing(samples: TemperatureSample[], nowMs: number, lastCommandAtMs: number): "hold" | "raise" {
  const newest = samples.findLast(sample => sample.atMs <= nowMs);
  if (newest === undefined) {
    throw new Error("decideOnArchiveRing needs a sample at or before nowMs");
  }
  const from = MIN_COMMAND_A + 5;
  const decision = decideChargeCurrent({
    enabled: true,
    packTemperatureC: newest.celsius,
    packTemperatureAgeMs: 100,
    packTemperaturePlausible: true,
    chargeManagerState: 0x23,
    chargeManagerStateAgeMs: 100,
    ceilingAmps: 75,
    commandedAmps: from,
    riderOverride: false,
    samples,
    socPercent: null,
    socAgeMs: null,
    socSamples: [],
    requestedAmps: null,
    lastCommandAtMs,
    nowMs,
  });
  return decision.kind === "command" && decision.amps > from ? "raise" : "hold";
}
