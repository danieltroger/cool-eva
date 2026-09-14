import {
  CHARGE_MANAGER_STATE_DC,
  CLIFF_C,
  decideChargeCurrent,
  type ChargeAutoReason,
} from "../src/charge/auto-curve.ts";
import type { TemperatureSample } from "../src/charge/rate.ts";
import type { SocSample } from "../src/charge/soc.ts";

// A simulated pack, so the controller can be driven through a whole DC stop in a check. Data and
// arithmetic only — nothing here talks to a bus.
//
// ⚠️ THE HONEST LIMIT, and it is not small. The plant is `dT/dt = a·I² − b·(T − ambient)` with the
// constants fitted to TWO anchors from ONE day (2026-09-07), and the controller is designed
// precisely NOT to depend on that model. So this shows the rule behaves sensibly across a 4× spread
// of cooling — which is the "works for one day's b" failure it exists to avoid — and it does NOT
// show the controller is right on the bike. Only a live charge does that.
//
// The SOC half is measured, not modelled: 0.53 min per SOC point at 72.6 A, and above the cliff the
// clamp releases and the bike saw-tooths at a measured duty-weighted 35.3 A / 1.30 min per point.

/** `a`, K/min per A². Fitted to DC3's climb and DC2's capped hold. */
const HEAT_PER_AMP_SQUARED = 1.413e-4;

/** `b`, per minute. The cooling term — a constant of the WEATHER, which is why the sweep exists. */
export const COOLING_NOMINAL = 0.0089;

/** Measured: minutes per SOC point at the 72.6 A the bike pulls when nothing is in the way. */
const MIN_PER_POINT_AT_FULL = 0.53;
export const FULL_CURRENT_A = 72.6;

/**
 * What the simulated pack will accept at each SOC — the taper, as the plant models it.
 *
 * ⚠️ NOT `taperEnvelopeAmpsAt`, and that is the whole point. The controller's table is its BELIEF
 * about the pack; if the plant tapered on the same numbers, "the veto saves time where the taper is
 * real" would be a statement about arithmetic — a prediction that defines its own subject must come
 * true. So the plant uses the STRICT row from docs/dc-taper.md instead: the same pack, measured
 * under the narrower "nothing else was binding" filter, which runs 1-5 A lower at 91-97 %. The
 * controller is then optimistic about this plant by a measured margin rather than exactly right.
 */
const PLANT_ACCEPTS_A: Readonly<Record<number, number>> = {
  88: 70,
  89: 65,
  90: 62,
  91: 56,
  92: 55,
  93: 51,
  94: 47,
  95: 43,
  96: 41,
  97: 36,
  98: 32,
  99: 29,
  100: 5,
};

/** What that pack accepts at this SOC, read as a step function. Full current below the knee. */
function plantAcceptsAt(socPercent: number): number {
  return socPercent < 88 ? FULL_CURRENT_A : (PLANT_ACCEPTS_A[Math.min(100, Math.ceil(socPercent))] ?? 0);
}

/** Measured: what the saw-tooth actually averages once the clamp releases at 55 °C. */
export const SAWTOOTH_MIN_PER_POINT = 1.3;
const SAWTOOTH_CURRENT_A = 35.3;

export interface PlantRun {
  peakC: number;
  minutes: number;
  /** How many ticks took each reason, so a check can assert no branch is dead. */
  reasons: Map<ChargeAutoReason, number>;
  /** Every current commanded, in order. Lets a check see step size and chatter, which peak and time cannot. */
  commands: number[];
}

export interface PlantOptions {
  arrivalC: number;
  ambientC: number;
  fromSoc: number;
  toSoc: number;
  cooling?: number;
  /** Off = the do-nothing baseline the controller must never be worse than. */
  control?: boolean;
  /** A deliberately broken controller, for the assertion that a stuck one fails. */
  stuckAt?: number;
  /**
   * Hides the SOC from the rule, which is exactly the shipped controller: src/charge/soc.ts answers
   * null without one, so the session-ahead veto can never fire. The reference trajectory for §18,
   * and it is the SAME function rather than a second copy of the law kept alive to diff against.
   */
  socBlind?: boolean;
  /**
   * Whether the pack's own high-SOC taper limits the current, as the real one does.
   *
   * ⚠️ OFF BY DEFAULT, and that is deliberate rather than lazy. Every number pinned in
   * check-charge-auto.ts §3, §4, §6 and §11 was measured on a plant with NO taper, and adding one
   * would move all of them at once — so the frozen grid keeps the plant it was frozen with, and
   * §18 runs the tapered one under its own name. An untapered plant is also the HARSHER test of
   * the session-ahead veto: it holds full current into a band the real bike never reaches at full
   * current, so a veto that adds no crossing there certainly adds none on the real taper.
   */
  taper?: boolean;
}

/**
 * Replays one DC stop. The controller sees exactly what the Pi would: a whole-degree sensor, a
 * sample only when that integer changes, and one decision per tick.
 */
export function replayCharge(options: PlantOptions): PlantRun {
  const cooling = options.cooling ?? COOLING_NOMINAL;
  const tickSeconds = 60;
  const stepSeconds = 1;
  let temperature = options.arrivalC;
  let soc = options.fromSoc;
  let elapsed = 0;
  let commanded: number | null = null;
  let peakC = options.arrivalC;
  let lastTick = -Infinity;
  let lastWholeDegree: number | null = null;
  const samples: TemperatureSample[] = [];
  const socSamples: SocSample[] = [];
  const reasons = new Map<ChargeAutoReason, number>();
  const commands: number[] = [];
  let lastWholeSoc: number | null = null;

  while (soc < options.toSoc && elapsed < 200 * 60) {
    // The sensor: whole degrees, and a sample only when that integer moves — which is what makes
    // the estimator's "too few distinct readings" case the normal one on a stable charge.
    const whole = Math.floor(temperature);
    if (whole !== lastWholeDegree) {
      lastWholeDegree = whole;
      samples.push({ atMs: elapsed * 1000, celsius: whole });
    }
    // SOC arrives the same way, and is not trimmed for the same reason the temperature ring is not:
    // `estimateSocRate` windows its own input.
    const wholeSoc = Math.floor(soc);
    if (wholeSoc !== lastWholeSoc) {
      lastWholeSoc = wholeSoc;
      socSamples.push({ atMs: elapsed * 1000, percent: wholeSoc });
    }
    // The most the pack itself will take at this SOC. One lookup per step, read twice below.
    const accepts = options.taper ? plantAcceptsAt(wholeSoc) : FULL_CURRENT_A;
    if (options.control !== false && elapsed - lastTick >= tickSeconds) {
      lastTick = elapsed;
      // What the vehicle would be asking for: the ceiling, or the taper once it binds. Built here
      // rather than every step, because only the tick reads it.
      const requestedAmps = Math.min(FULL_CURRENT_A, accepts, commanded ?? FULL_CURRENT_A);
      const decision = decideChargeCurrent({
        enabled: true,
        packTemperatureC: whole,
        packTemperatureAgeMs: 100,
        packTemperaturePlausible: true,
        chargeManagerState: CHARGE_MANAGER_STATE_DC,
        chargeManagerStateAgeMs: 100,
        ceilingAmps: FULL_CURRENT_A,
        commandedAmps: commanded,
        riderOverride: false,
        samples,
        socPercent: options.socBlind ? null : wholeSoc,
        socAgeMs: 100,
        socSamples,
        requestedAmps,
        nowMs: elapsed * 1000,
      });
      reasons.set(decision.reason, (reasons.get(decision.reason) ?? 0) + 1);
      if (decision.kind === "command") {
        commanded = decision.amps;
        commands.push(decision.amps);
      }
    }
    const cap = options.stuckAt ?? commanded ?? FULL_CURRENT_A;
    // Above the cliff the BMS clamp releases and the bike saw-tooths, whatever anyone commanded.
    // Below it the pack takes the smallest of what was commanded, what the bike can take, and —
    // when the taper is on — what the pack itself will accept at this SOC.
    const flowing = temperature >= CLIFF_C ? SAWTOOTH_CURRENT_A : Math.min(cap, FULL_CURRENT_A, accepts);
    const minutesPerPoint =
      temperature >= CLIFF_C ? SAWTOOTH_MIN_PER_POINT : (MIN_PER_POINT_AT_FULL * FULL_CURRENT_A) / flowing;
    soc += stepSeconds / 60 / minutesPerPoint;
    temperature +=
      ((HEAT_PER_AMP_SQUARED * flowing * flowing - cooling * (temperature - options.ambientC)) * stepSeconds) / 60;
    peakC = Math.max(peakC, temperature);
    elapsed += stepSeconds;
  }
  const minutes = elapsed / 60;
  return { peakC, minutes, reasons, commands };
}

/** The three real DC stops of 2026-09-07: arrival temperature, ambient and SOC band, all measured. */
export const REPLAY_SESSIONS = [
  { name: "DC1", arrivalC: 51, ambientC: 39.2, fromSoc: 32, toSoc: 85 },
  { name: "DC2", arrivalC: 50, ambientC: 35.4, fromSoc: 22, toSoc: 91 },
  { name: "DC3", arrivalC: 42, ambientC: 29.4, fromSoc: 27, toSoc: 66 },
];

/** The cooling spread: as fitted, half as good, twice as good, and ten degrees hotter out. */
export const PLANTS = [
  { name: "nominal", cooling: COOLING_NOMINAL, ambientOffset: 0 },
  { name: "b/2", cooling: COOLING_NOMINAL / 2, ambientOffset: 0 },
  { name: "b*2", cooling: COOLING_NOMINAL * 2, ambientOffset: 0 },
  { name: "amb+10", cooling: COOLING_NOMINAL, ambientOffset: 10 },
];

/**
 * Cold days on which full current NEVER reaches the cliff, so the right answer is to do nothing.
 *
 * ⚠️ These exist because without them the check cannot see over-throttling AT ALL. Under the fitted
 * constants, equilibrium at full current is `ambient + 83.7 K`, so every stop in REPLAY_SESSIONS is
 * doomed to cross 55 °C whatever the controller does — and a controller that throttles a charge it
 * should have left alone is then unrepresentable. Six mutations survived the check until these were
 * added. The approved plan asked for this case (#142 §3.7 item 7, "zero cap events and mean
 * commanded current = the ceiling") and it was dropped; this is it.
 *
 * The cooling needed is real, not contrived: holding 75 A under 55 °C wants `b > a·75²/(55 − amb)`,
 * which is 1.8× the fitted value at 5 °C ambient and 2.2× at 15 °C — plausible for a Swedish
 * autumn, and absent at the 30-40 °C the constants were fitted at.
 */
export const COLD_PLANTS = [
  { name: "amb 5 °C, 2× cooling", arrivalC: 20, ambientC: 5, cooling: COOLING_NOMINAL * 2 },
  { name: "amb 15 °C, 2.5× cooling", arrivalC: 25, ambientC: 15, cooling: COOLING_NOMINAL * 2.5 },
];

/**
 * Arrives hot enough to be throttled, then cools fast enough to earn the current back.
 *
 * ⚠️ Nothing else exercises the CLEAR branch, so without this the "give it back" half of the rule
 * would ship untested and a controller that only ever ratchets DOWN would pass every other
 * assertion in the check. Kept apart from COLD_PLANTS because this one is supposed to act.
 */
export const RECOVERY_PLANT = {
  name: "hot arrival on a cold day",
  arrivalC: 54,
  ambientC: 10,
  cooling: COOLING_NOMINAL * 2,
};

/**
 * A FIXED grid of plants, for the crossing count in scripts/check-charge-auto.ts §11.
 *
 * ⚠️ Named and frozen on purpose. The property that matters — "this rule crosses the cliff no more
 * often than the one it replaced" — cannot be asserted without keeping the old rule alive to compare
 * against, so it is pinned as a golden count over a grid that does not move. Change the grid and the
 * number means nothing; that is why the grid is here rather than generated.
 */
export const CROSSING_GRID = {
  arrivals: [40, 44, 48, 51, 54],
  ambients: [10, 18, 25, 30, 35, 39],
  coolings: [0.5, 1.0, 1.5, 2.0, 3.0].map(multiple => COOLING_NOMINAL * multiple),
  fromSoc: 25,
  toSoc: 85,
};

/**
 * A grid for the session-ahead veto, run to FULL rather than to 85 %.
 *
 * ⚠️ UNTAPERED on purpose, and that is what makes it able to go red. The veto exists because the
 * real pack's taper takes the current away; a plant that models the taper would hand it the answer.
 * This one holds full current all the way to 100 %, so the veto suppresses steps down in a band
 * where the heat really does keep coming — the harshest arrangement there is. The arrivals and
 * ambients are chosen so the pack passes 80 % SOC at a reading of 50-53 °C, which is the exact
 * state the reviewer of #201 pointed out the 2026-09-07…13 corpus never visits unthrottled.
 *
 * ⚠️ Its numbers are its own. CROSSING_GRID keeps the plant it was frozen with; nothing here may be
 * quoted against §11's golden set.
 */
export const TAPER_GRID = {
  arrivals: [44, 47, 50, 53],
  ambients: [18, 25, 30, 35, 39],
  coolings: [0.5, 1.0, 1.5, 2.0, 3.0].map(multiple => COOLING_NOMINAL * multiple),
  fromSoc: 60,
  toSoc: 100,
};

/** Minutes per SOC point at a steady cap — the measured relation, for the floor sweep. */
export function minutesPerPointAt(amps: number): number {
  return (MIN_PER_POINT_AT_FULL * FULL_CURRENT_A) / amps;
}
