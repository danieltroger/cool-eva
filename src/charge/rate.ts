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
 * How long since the reading last moved, in minutes, or null when there is no reading at all.
 *
 * ⚠️ THE THIRD FACE OF "silence is not an absence". A whole-degree sensor that has not ticked for
 * `t` minutes proves the pack moved less than one degree in `t`, so the rate is under `1/t` — and
 * that is a MEASUREMENT, available in exactly the branches that have no fitted slope to offer.
 * `estimateHeatingRate` caps a stale slope with it; `auto-curve.ts` sizes its blind step from it.
 */
export function minutesSinceNewestSample(samples: TemperatureSample[], nowMs: number): number | null {
  const newest = samples.filter(sample => sample.atMs <= nowMs).at(-1);
  return newest === undefined ? null : (nowMs - newest.atMs) / 60_000;
}

/**
 * The heating rate the samples support. Pure.
 *
 * `samples` may hold anything; only those inside the window ending at `nowMs` are read, so the
 * caller's ring does not have to be trimmed exactly.
 */
export function estimateHeatingRate(samples: TemperatureSample[], nowMs: number): HeatingRate {
  const from = nowMs - RATE_WINDOW_MS;
  const inWindow = samples.filter(sample => sample.atMs >= from && sample.atMs <= nowMs);
  // ⚠️ ANCHORED on the newest sample from BEFORE the window, when there is one. These arrive only
  // when the whole degree changes, so a pack holding one degree emits nothing at all — and without
  // the anchor the window simply empties after RATE_WINDOW_MS and the answer flips to `unknown`.
  // That is the same "silence is not blindness" mistake this file was written to fix, one timescale
  // up: it would fire exactly when the controller SUCCEEDS, because a current low enough to hold
  // the temperature steady is a current that stops the reading ticking.
  const anchor = samples.filter(sample => sample.atMs < from).at(-1);
  const window = anchor ? [anchor, ...inWindow] : inWindow;
  if (window.length === 0) {
    return { kind: "unknown" };
  }
  // ⚠️ Measured to NOW, not to the newest sample. These arrive only when the whole degree changes,
  // so a pack sitting still produces none at all — and taking the span between samples would make
  // the stillest pack look like the one we know least about, which is backwards.
  // Clamped to the window: an anchor may be much older, and the pack cannot be held to account for
  // a band it stayed inside long before we started looking.
  const spanMs = Math.min(nowMs - window[0].atMs, RATE_WINDOW_MS);
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
  // ⚠️ CAPPED BY THE SILENCE, and this is the bug that cost 45 A at a reading of 51 °C on
  // 2026-09-09. A least-squares slope is fitted to the SAMPLES, and a pack that climbs fast and
  // then flattens emits none at all — so the steep slope outlives its evidence for as long as the
  // pack stays still. Measured that day: 0.706 K/min reported with the reading unmoved for 7.5
  // minutes, against a true bulk climb of 0.103. The silence is itself a bound, so the smaller of
  // the two is the most the pack can be doing. Only ever LOWERS an estimate, so it cannot empty
  // the window (#163's anchor) and cannot bind during a live saw-tooth, where the reading is
  // ticking every 1-3 min. ⚠️ NOT applied to `bounded` above: that branch is already derived from
  // elapsed time, and capping it there spends check-charge-auto's §2. docs/charge-auto.md.
  const slope = leastSquaresSlopePerMinute(window);
  const silentMinutes = minutesSinceNewestSample(window, nowMs);
  if (silentMinutes === null || silentMinutes <= 0) {
    return { kind: "rate", perMinute: slope };
  }
  return { kind: "rate", perMinute: Math.min(slope, 1 / silentMinutes) };
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
