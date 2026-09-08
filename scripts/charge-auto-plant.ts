import { decideChargeCurrent, MIN_COMMAND_A, type ChargeAutoReason } from "../src/charge/auto-curve.ts";
import type { TemperatureSample } from "../src/charge/rate.ts";

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
const FULL_CURRENT_A = 72.6;

/** Measured: what the saw-tooth actually averages once the clamp releases at 55 °C. */
export const SAWTOOTH_MIN_PER_POINT = 1.3;
const SAWTOOTH_CURRENT_A = 35.3;

const CLIFF_C = 55;

export interface PlantRun {
  peakC: number;
  minutes: number;
  /** How many ticks took each reason, so a check can assert no branch is dead. */
  reasons: Map<ChargeAutoReason, number>;
  minutesPerPoint: number;
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
  tickSeconds?: number;
}

/**
 * Replays one DC stop. The controller sees exactly what the Pi would: a whole-degree sensor, a
 * sample only when that integer changes, and one decision per tick.
 */
export function replayCharge(options: PlantOptions): PlantRun {
  const cooling = options.cooling ?? COOLING_NOMINAL;
  const tickSeconds = options.tickSeconds ?? 60;
  const stepSeconds = 1;
  let temperature = options.arrivalC;
  let soc = options.fromSoc;
  let elapsed = 0;
  let commanded: number | null = null;
  let peakC = options.arrivalC;
  let lastTick = -Infinity;
  let lastWholeDegree: number | null = null;
  const samples: TemperatureSample[] = [];
  const reasons = new Map<ChargeAutoReason, number>();

  while (soc < options.toSoc && elapsed < 200 * 60) {
    // The sensor: whole degrees, and a sample only when that integer moves — which is what makes
    // the estimator's "too few distinct readings" case the normal one on a stable charge.
    const whole = Math.floor(temperature);
    if (whole !== lastWholeDegree) {
      lastWholeDegree = whole;
      samples.push({ atMs: elapsed * 1000, celsius: whole });
    }
    if (options.control !== false && elapsed - lastTick >= tickSeconds) {
      lastTick = elapsed;
      const decision = decideChargeCurrent({
        enabled: true,
        packTemperatureC: whole,
        packTemperatureAgeMs: 100,
        packTemperaturePlausible: true,
        chargeManagerState: 0x23,
        chargeManagerStateAgeMs: 100,
        ceilingAmps: FULL_CURRENT_A,
        commandedAmps: commanded,
        riderOverride: false,
        samples,
        nowMs: elapsed * 1000,
      });
      reasons.set(decision.reason, (reasons.get(decision.reason) ?? 0) + 1);
      if (decision.kind === "command") {
        commanded = decision.amps;
      }
    }
    const cap = options.stuckAt ?? commanded ?? FULL_CURRENT_A;
    // Above the cliff the BMS clamp releases and the bike saw-tooths, whatever anyone commanded.
    const flowing = temperature >= CLIFF_C ? SAWTOOTH_CURRENT_A : Math.min(cap, FULL_CURRENT_A);
    const minutesPerPoint =
      temperature >= CLIFF_C ? SAWTOOTH_MIN_PER_POINT : (MIN_PER_POINT_AT_FULL * FULL_CURRENT_A) / flowing;
    soc += stepSeconds / 60 / minutesPerPoint;
    temperature +=
      ((HEAT_PER_AMP_SQUARED * flowing * flowing - cooling * (temperature - options.ambientC)) * stepSeconds) / 60;
    peakC = Math.max(peakC, temperature);
    elapsed += stepSeconds;
  }
  const minutes = elapsed / 60;
  return { peakC, minutes, reasons, minutesPerPoint: minutes / (options.toSoc - options.fromSoc) };
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

/** Minutes per SOC point at a steady cap — the measured relation, for the floor sweep. */
export function minutesPerPointAt(amps: number): number {
  return (MIN_PER_POINT_AT_FULL * FULL_CURRENT_A) / amps;
}

/** The floor the controller ships with, re-exported so the check reads one number. */
export const FLOOR_A = MIN_COMMAND_A;
