import { RATE_MIN_DISTINCT, RATE_MIN_SPAN_MS, RATE_WINDOW_MS } from "./rate.ts";

// How much of a DC charge is still ahead — in minutes, from the SOC ring. Pure: samples in, an
// answer out, no I/O and no clock read. ./auto-curve.ts uses it for one thing only, and the shape
// of that use is the whole safety argument: it may SUPPRESS a step down, never size one and never
// raise. docs/dc-taper.md has the measurements, docs/charge-auto.md the rule.
//
// ⚠️ THE REACTION HORIZON ASSUMES THE PRESENT CURRENT KEEPS FLOWING for REACTION_MIN minutes, and
// the pack's own taper takes it away first. That is measured rather than modelled: an envelope of
// what the vehicle has actually asked for at each SOC, over every DC tick in the 2026-09-07…13 log.
//
// ⚠️ A RIDER'S "charge to __ %" is the OTHER clock that runs out, and it is deliberately not here.
// It relaxes the controller on a promise the charge can break — and #201's own first report is a
// rider breaking it ("we only wanted to charge to 80 %… But we ended up charging full anyway").
// Measured on an untapered grid, a target of 80 that the charge then overruns puts 5 of 100 plants
// over the cliff. See docs/charge-auto.md § "The charge target, and why it is not here yet".

/** One SOC reading. Monotonic milliseconds, never a wall clock: this Pi steps its own. */
export interface SocSample {
  atMs: number;
  percent: number;
}

export interface SessionAheadInput {
  /** `soc`, and its age. From `0x200` b1 at 20 Hz, so a stale one means the BMS went quiet. */
  socPercent: number | null;
  socAgeMs: number | null;
  socSamples: SocSample[];
  /** `fast_dc_target_a` — what the vehicle is asking the station for. Never a fabricated number. */
  requestedAmps: number | null;
  nowMs: number;
}

/**
 * How old `soc` may be. The same 5 s `batt_temp_hi` and `charge_manager_state` get in
 * ./auto-curve.ts, and for the same reason: it rides a 20 Hz frame, so this means the BMS is quiet.
 */
export const SOC_MAX_AGE_MS = 5_000;

/**
 * The window a SOC rate is measured over, the least span that may carry one, and the distinct
 * readings it needs.
 *
 * All three are the heating rate's own numbers, taken FROM it rather than re-typed — but named
 * here, because the arguments behind them are thermal (the window is three periods of
 * `batt_temp_hi`'s 1-3 min saw-tooth) and say nothing about SOC. They suit SOC for a different
 * reason: even at the 35 A floor the pack moves about a point a minute, so ten minutes still
 * carries the three distinct readings this needs. ⚠️ If a thermal argument ever shortens
 * RATE_WINDOW_MS, these do not have to follow — that is what the indirection is for.
 */
export const SOC_WINDOW_MS = RATE_WINDOW_MS;
export const SOC_MIN_SPAN_MS = RATE_MIN_SPAN_MS;
export const SOC_MIN_DISTINCT = RATE_MIN_DISTINCT;

/**
 * The current the vehicle asks for below the knee. ⚠️ 73 is what it asks for in almost every frame,
 * but this log has it holding **75** twice — 6.4 min on 2026-09-12 and 4.8 min on 2026-09-13, both
 * at a station advertising 80 A. `docs/charge-manager.md`'s "never once read 74 or 75 across
 * 941 765 frames" is superseded by that, so nothing here treats 73 as a law; 75 is the conservative
 * pad, and padding UP is safe because it makes the taper look further away.
 */
const FULL_REQUEST_A = 75;

/**
 * Where the envelope stops being flat. Below it the vehicle asks for everything it can get, so
 * "how long until the taper arrives" has an answer; at or above it the taper has already arrived.
 *
 * ⚠️ It is also the DECELERATION GUARD, which is the more important half. The SOC rate is a
 * TRAILING measurement, and above the knee SOC slows as the current falls — so an estimate from the
 * last ten minutes over-states the next ten, which shortens the horizon, which suppresses more
 * steps down. Measured 2026-09-11 at 11:35: the window supports 0.3 %/min where 99 → 100 actually
 * took 7.0 minutes against a predicted 2.5. A least-squares fit is trailing too and does not fix
 * it. So neither term below runs at or above the knee, and there the controller is unchanged.
 */
export const TAPER_KNEE_SOC = 88;

/**
 * The SOC below which a trailing rate estimate may be trusted.
 *
 * ⚠️ The same number as the knee by MEASUREMENT rather than by identity, and the two were measured
 * in different places: the knee is where `fast_dc_target_a` starts falling, across 8 sessions; this
 * is where SOC stops being predictable from its own past, seen at 99 → 100 on 2026-09-11. Separated
 * because the safe directions differ — widening this band (a lower number) is always safe, narrowing
 * it is not, and an envelope measured on a pack that tapers LATER would move the knee up and
 * silently narrow this if they were one constant.
 */
export const SOC_RATE_TRUSTED_BELOW = 88;

/**
 * The largest current the vehicle has ever asked for at each SOC, over every DC tick in the
 * 2026-09-07…13 log with the pack under 55 °C, made monotone from the top.
 *
 * ⚠️ A MAXIMUM, which is why the filter is loose. A tick where the station or this controller was
 * holding the current down can only pull a value DOWN, never up — so screening for "nothing was
 * binding" throws evidence away in the unsafe direction, and understating the envelope makes the
 * taper look as if it bites earlier than it does. Provenance, per-SOC sample counts and the two
 * filters compared: docs/dc-taper.md.
 */
export const TAPER_ENVELOPE_A: Readonly<Record<number, number>> = {
  88: 70,
  89: 65,
  90: 62,
  91: 60,
  92: 58,
  93: 53,
  94: 49,
  95: 45,
  96: 41,
  97: 37,
  98: 32,
  99: 29,
  100: 5,
};

/**
 * How many minutes of charge are ahead at the present current, or null when nothing can be said.
 *
 * ⚠️ Every unknown returns null, and a null leaves ./auto-curve.ts with today's reaction horizon.
 * A missing or stale SOC, too little ring, a pack already past the knee, a current at or below the
 * floor, an envelope that never falls below it: all of them mean "no truncation", which is the
 * shipped rule unchanged.
 */
export function sessionAheadMinutes(input: SessionAheadInput): number | null {
  if (!isSocPlausible(input.socPercent) || input.socAgeMs === null || input.socAgeMs > SOC_MAX_AGE_MS) {
    return null;
  }
  // ⚠️ See TAPER_KNEE_SOC: a trailing rate over-states a decelerating one, so past the knee this
  // declines to answer at all rather than answering with a number it cannot stand behind.
  if (input.socPercent >= SOC_RATE_TRUSTED_BELOW) {
    return null;
  }
  const percentPerMinute = estimateSocRate(input.socSamples, input.nowMs);
  if (percentPerMinute === null) {
    return null;
  }
  if (input.requestedAmps === null) {
    return null;
  }
  return minutesUntilTaperBites(input.socPercent, input.requestedAmps, percentPerMinute);
}

/** Whether a SOC reading is inside the only range a percentage can occupy. */
export function isSocPlausible(percent: number | null): percent is number {
  return percent !== null && Number.isFinite(percent) && percent >= 0 && percent <= 100;
}

/**
 * How fast SOC is rising, in percent per minute — a LOWER bound, deliberately, and an exact one.
 *
 * ⚠️ The direction matters more than the number. Under-stating the rate over-states the time left,
 * which lengthens the horizon, which suppresses FEWER steps down. `soc` is whole percent logged on
 * change, so a sample exists at the instant the reading became that value: between the oldest
 * in-window sample and now the pack advanced at least `newest − oldest` points and at most one
 * more. The smaller end is what this returns.
 *
 * ⚠️ NO ANCHOR, unlike ./rate.ts. That file keeps one sample from before the window because a still
 * pack emits nothing; SOC on a live DC charge moves every 30 s or so, and an anchor older than the
 * window would stretch the span past what the samples justify and turn the bound into a guess.
 */
export function estimateSocRate(samples: SocSample[], nowMs: number): number | null {
  const from = nowMs - SOC_WINDOW_MS;
  const window = samples.filter(sample => sample.atMs >= from && sample.atMs <= nowMs);
  if (window.length < 2) {
    return null;
  }
  const spanMs = nowMs - window[0].atMs;
  if (spanMs < SOC_MIN_SPAN_MS) {
    return null;
  }
  if (new Set(window.map(sample => sample.percent)).size < SOC_MIN_DISTINCT) {
    return null;
  }
  const advanced = window.at(-1)!.percent - window[0].percent;
  if (advanced <= 0) {
    return null;
  }
  return advanced / (spanMs / 60_000);
}

/**
 * What the vehicle can ask for at this SOC — the envelope, read as a step function.
 *
 * Called only by `socWhereTaperFallsBelow` below, which walks whole percents from the knee to 100,
 * so nothing here has to coerce a fraction or clamp an out-of-range SOC.
 */
function taperEnvelopeAmpsAt(socPercent: number): number {
  if (socPercent < TAPER_KNEE_SOC) {
    return FULL_REQUEST_A;
  }
  // ⚠️ A missing row answers FULL_REQUEST_A, not 0, and the direction is the point. Understating
  // the envelope makes the taper look as if it bites earlier, which shortens the horizon and
  // suppresses MORE steps down — the unsafe direction this file names twice above. Answering the
  // full request instead means "no taper known here", so socWhereTaperFallsBelow walks past it.
  // Unreachable while the table covers 88-100, which is exactly why it must not be the one unknown
  // in this subsystem that fails unsafe.
  return TAPER_ENVELOPE_A[socPercent] ?? FULL_REQUEST_A;
}

/** The first SOC at which the envelope sits below `amps`, or null if it never does before full. */
function socWhereTaperFallsBelow(amps: number): number | null {
  for (let soc = TAPER_KNEE_SOC; soc <= 100; soc += 1) {
    if (taperEnvelopeAmpsAt(soc) < amps) {
      return soc;
    }
  }
  return null;
}

/** Minutes until the pack's own taper takes the current below what is flowing now. */
function minutesUntilTaperBites(socPercent: number, requestedAmps: number, percentPerMinute: number): number | null {
  const bitesAt = socWhereTaperFallsBelow(requestedAmps);
  if (bitesAt === null || bitesAt <= socPercent) {
    return null;
  }
  return (bitesAt - socPercent) / percentPerMinute;
}
