// How fast the pack is heating, from a whole-degree sensor. Pure — samples in, an answer out.
//
// ⚠️ THE TRAP THIS EXISTS TO AVOID. `batt_temp_hi` saw-tooths on a 1-3 minute period at the
// HOTTEST CELL when the BMS clamp releases, and that is a fast local transient, not bulk heating:
// fitting to it over-predicts the pack's real climb by 3.5× (the analysis behind #142 says so in
// as many words). So the window is long enough to average it out, and nothing here reacts to a
// single reading.
//
// ⚠️ AND THE ONE THAT NEARLY SHIPPED. "Too few readings to fit a slope" is NOT "no information".
// The sensor is whole degrees, so fewer than three distinct values across the window means the
// pack moved less than that many degrees in that time — an upper BOUND on the rate. An earlier
// design read it as an absence and descended anyway, which ratchets a perfectly stable charge to
// the floor because it is stable. docs/charge-auto.md.

/** What the samples support saying about the heating rate. Closed, so no caller can invent a case. */
export type HeatingRate =
  /** A least-squares slope over the window, K/min. Can be negative — the pack may be cooling. */
  | { kind: "rate"; perMinute: number }
  /**
   * Not enough distinct readings to fit a slope, but enough time to bound one: the pack moved at
   * most `perMinute` K/min, or the window would have crossed another whole degree.
   */
  | { kind: "bounded"; perMinute: number }
  /** Too little history to say anything — early in a session, or after a restart. */
  | { kind: "unknown" };

/** One temperature reading. Monotonic milliseconds, never a wall clock: this Pi steps its own. */
export interface TemperatureSample {
  atMs: number;
  celsius: number;
}

/**
 * How much history the window needs before it says anything at all.
 *
 * Below this the answer is `unknown` and the controller treats it as "cannot see", which is the
 * only state that justifies acting blind. Five minutes is half the window: enough for the slope to
 * mean something, short enough that a pack which arrived hot is not unattended for long.
 */
export const RATE_MIN_SPAN_MS = 300_000;

/** Distinct whole-degree readings needed to fit a slope rather than bound one. */
export const RATE_MIN_DISTINCT = 3;

/**
 * The window a rate is measured over.
 *
 * Three or more periods of the longest (1-3 min) saw-tooth, so a least-squares slope across it is
 * dominated by the bulk drift rather than by the oscillation. See the ⚠️ at the top.
 */
export const RATE_WINDOW_MS = 600_000;

/**
 * The heating rate the samples support. Pure.
 *
 * `samples` may hold anything; only those inside the window ending at `nowMs` are read, so the
 * caller's ring does not have to be trimmed exactly.
 */
export function estimateHeatingRate(samples: TemperatureSample[], nowMs: number): HeatingRate {
  const window = samples.filter(sample => sample.atMs >= nowMs - RATE_WINDOW_MS && sample.atMs <= nowMs);
  if (window.length === 0) {
    return { kind: "unknown" };
  }
  // ⚠️ Measured to NOW, not to the newest sample. These arrive only when the whole degree changes,
  // so a pack sitting still produces none at all — and taking the span between samples would make
  // the stillest pack look like the one we know least about, which is backwards.
  const spanMs = nowMs - window[0].atMs;
  if (spanMs < RATE_MIN_SPAN_MS) {
    return { kind: "unknown" };
  }
  const distinct = new Set(window.map(sample => sample.celsius)).size;
  if (distinct < RATE_MIN_DISTINCT) {
    // A BOUND, not an absence. Only `distinct` whole-degree values were seen, so the temperature
    // stayed inside a band `distinct` degrees wide for the whole span — it cannot have moved faster
    // than that, or it would have crossed into another one.
    return { kind: "bounded", perMinute: (distinct * 60_000) / spanMs };
  }
  return { kind: "rate", perMinute: leastSquaresSlopePerMinute(window) };
}

function leastSquaresSlopePerMinute(window: TemperatureSample[]): number {
  const meanAt = window.reduce((total, sample) => total + sample.atMs, 0) / window.length;
  const meanCelsius = window.reduce((total, sample) => total + sample.celsius, 0) / window.length;
  let covariance = 0;
  let variance = 0;
  for (const sample of window) {
    covariance += (sample.atMs - meanAt) * (sample.celsius - meanCelsius);
    variance += (sample.atMs - meanAt) ** 2;
  }
  // Guarded rather than assumed: every sample sharing one timestamp is a divide by zero, and this
  // number decides how much current goes into a battery.
  return variance === 0 ? 0 : (covariance / variance) * 60_000;
}
