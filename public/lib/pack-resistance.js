// @ts-check

// Pack internal resistance for the derived quantities that need one.
//
// The BMS publishes its own estimate on 0x206, and it is not usable: 301 rows in the
// whole 15.4 M-row history, 41 % of them zero, frozen for hours at a time, and worst
// exactly where a charge is steady. It is still logged — it is what the BMS said — but
// nothing on screen is computed from it any more. See docs/pack-resistance.md.
//
// What replaces it: a rolling least-squares fit of pack voltage against pack current,
// with a measured R(T) curve as the fallback whenever the fit has nothing to say. Every
// answer carries its provenance so a tile can tell the rider which one it is showing.
//
// ⚠️ A SAMPLE IS A PAIR FROM ONE 0x200 FRAME, never two carried-forward values. Both
// bytes come from the same frame (src/can/decode-bms.ts), one frame's values are
// coalesced into one WebSocket patch (src/can/signals.ts), and pairing across frames
// biases the slope toward zero — measurably, by about 4 mOhm.

import { monotonicNow } from "./clock.js";

/** Trailing window the fit runs over. */
const WINDOW_MS = 30_000;

/**
 * Samples kept. The buffer fills at ~5-6 Hz, not the bus's 20 Hz: a patch carries a
 * signal only if it changed, and pack_v moves about a third as often as pack_a, so
 * only ~28 % of frames yield a pair. Measured on 2026-09-07: a 30 s window holds a
 * median of 42 pairs and never more than 88. 256 is ~3x that peak.
 */
const CAPACITY = 256;

/** Below this many pairs a slope is arithmetic, not evidence. */
const LEAST_SAMPLES = 20;

/**
 * Current spread the window needs before a slope means anything. Precision goes as
 * sigma_V / (sigma_I * sqrt(n)), so spread is what buys it — and below ~40 A the answer
 * starts moving with the window rather than with the pack.
 */
const LEAST_SPREAD_A = 40;

/**
 * Fit-quality gate, as the slope's standard error over the slope.
 *
 * ⚠️ NOT a band on the value. A [60, 120] mOhm band was tried and rejected: 19 % of
 * qualifying windows fall below 60 and 2 % above 120, and both tails are real — the low
 * ones are a hot pack (median 52 C) and the high ones a cold one (median 28 C), with fit
 * quality no worse than the middle. A band on the answer throws away the physics.
 */
const MOST_RELATIVE_ERROR = 0.15;

/** Physical sanity only. Anything outside this is a decode or arithmetic fault. */
const LEAST_PLAUSIBLE_MOHM = 20;
const MOST_PLAUSIBLE_MOHM = 400;

/**
 * How long a measured estimate stays good after the window that produced it.
 *
 * Short on purpose. A rider who stops accelerating must not keep reading `measured`
 * through an entire motorway cruise — the number would be true and the label would be a
 * lie. Twenty seconds is about one overtake.
 */
const MEASURED_HOLD_MS = 20_000;

/**
 * R when there is no pack temperature at all. The pooled median of the measured
 * windows. It errs low against a cold pack, which understates heat on the informational
 * tiles and is the conservative direction on the headroom one: R enters sagPerCellMv as
 * I*R/81, so too high an R inflates the sag and makes restingMinCellMv read optimistic.
 */
const ASSUMED_MOHM = 65;

/**
 * Measured R against pack temperature — 2026-09-07, 1681 windows, strict same-frame
 * pairing. `[pack °C, mOhm, windows]`. Endpoints are held flat rather than extrapolated.
 * Below 27.5 C that under-reports: real windows at 20-24 C sit near 135 mOhm.
 * Method, per-bin scatter and the SOC-flatness result: docs/pack-resistance.md.
 */
const RESISTANCE_BY_TEMPERATURE = [
  [27.5, 115.4],
  [32.5, 95.3],
  [37.5, 80.8],
  [42.5, 69.8],
  [47.5, 64.5],
  [52.5, 61.0],
];

/** @typedef {{ milliohms: number, provenance: "measured" | "modelled" | "assumed" }} PackResistance */

/**
 * One word for a tile to append, or "" when the number is a live measurement and needs
 * no qualifier. Here rather than in derive.js so it sits with the type it describes and
 * the four screens that show it cannot word it differently.
 * @param {PackResistance} resistance
 * @returns {string}
 */
export function resistanceNote(resistance) {
  if (resistance.provenance === "measured") {
    return "";
  }
  return resistance.provenance === "modelled" ? "modelled R" : "assumed R";
}

/**
 * Pack resistance and where it came from. Never null: with no measurement and no pack
 * temperature it still answers, as `assumed`, so no consumer needs a null branch.
 *
 * Parameterised on how it reads, so the subscribing and sampling variants in derive.js
 * cannot drift apart — the same reason headroomMvWith() there exists. `nowMs` is a
 * parameter for the same reason scripts/virtual-clock.ts exists: an assertion about the
 * staleness INTERVAL cannot be made against the real clock.
 * @param {(key: string) => number | null} read
 * @param {number} [nowMs] monotonic, defaults to the phone's clock
 * @returns {PackResistance}
 */
export function packResistanceWith(read, nowMs = monotonicNow()) {
  const measured = freshMeasurement(nowMs);
  if (measured != null) {
    return { milliohms: measured, provenance: "measured" };
  }
  const packCelsius = read("batt_temp_hi");
  if (packCelsius != null) {
    return { milliohms: modelledMilliohms(packCelsius), provenance: "modelled" };
  }
  // Reachable on a real bike, not just at startup: pack-temperature.ts leaves
  // batt_temp_hi permanently unlogged under CUSTOM_BMS_CONFIG when 0x660 never arrives.
  return { milliohms: ASSUMED_MOHM, provenance: "assumed" };
}

/**
 * Offers one WebSocket message's accepted readings to the buffer.
 *
 * Called once per message from store.js with the readings that passed the plausibility
 * gate. A pair is taken only when BOTH keys are in the same message: co-presence is what
 * proves they came from one 0x200 frame, because signals.ts coalesces a frame's values
 * into a single patch and ws.ts sends or drops that patch whole.
 * @param {Record<string, import("../../src/can/signals.ts").LiveValue>} accepted
 * @param {number} [nowMs] monotonic, defaults to the phone's clock
 */
export function observeFrame(accepted, nowMs = monotonicNow()) {
  const volts = accepted["pack_v"];
  const amps = accepted["pack_a"];
  if (!volts || !amps) {
    return;
  }
  // True by construction today — both record() calls sit in one synchronous loop — but
  // only because nothing async separates them, which a later edit could change.
  if (Math.abs(volts.ts - amps.ts) > 1) {
    return;
  }
  // ws.ts heartbeats a full snapshot every 5 s, which re-offers the pair the last patch
  // already carried. Same frame, same server stamp, so one dedupe covers it.
  if (volts.ts === lastPairedTs) {
    return;
  }
  lastPairedTs = volts.ts;
  push(volts.value, amps.value, nowMs);
  refreshMeasurement(nowMs);
}

/** Drops every sample and the held estimate. Used by the check; nothing in public/ calls it. */
export function resetPackResistance() {
  sampleCount = 0;
  written = 0;
  lastPairedTs = null;
  measured = null;
}

const sampleVolts = new Float64Array(CAPACITY);
const sampleAmps = new Float64Array(CAPACITY);
const sampleTimes = new Float64Array(CAPACITY);
let written = 0;
let sampleCount = 0;
/** @type {number | null} */
let lastPairedTs = null;
/** @type {{ milliohms: number, atMs: number } | null} */
let measured = null;

/**
 * @param {number} volts
 * @param {number} amps
 * @param {number} ts monotonic, from lib/clock.js
 */
function push(volts, amps, ts) {
  sampleVolts[written] = volts;
  sampleAmps[written] = amps;
  sampleTimes[written] = ts;
  written = (written + 1) % CAPACITY;
  sampleCount = Math.min(sampleCount + 1, CAPACITY);
}

/**
 * The held measurement if it is still inside MEASURED_HOLD_MS.
 * @param {number} nowMs
 * @returns {number | null}
 */
function freshMeasurement(nowMs) {
  if (measured == null || nowMs - measured.atMs > MEASURED_HOLD_MS) {
    return null;
  }
  return measured.milliohms;
}

/**
 * Refits over the trailing window and keeps the answer if it earns keeping. Run on push
 * rather than on read, so every binding that asks is an O(1) lookup.
 * @param {number} nowMs
 */
function refreshMeasurement(nowMs) {
  const fitted = fitWindow(nowMs - WINDOW_MS);
  if (fitted == null) {
    return;
  }
  measured = { milliohms: fitted, atMs: nowMs };
}

/**
 * Least squares of V on I over the samples at or after `sinceMs`.
 *
 * Sign: pack_a is signed and negative on discharge, so dV/dI is +R. (Negating it —
 * the intuitive "voltage sags under load" reading — produces about 1 mOhm and looks
 * plausible enough to ship.)
 * @param {number} sinceMs
 * @returns {number | null} milliohms, or null if the window does not support a fit
 */
function fitWindow(sinceMs) {
  let count = 0;
  let sumAmps = 0;
  let sumVolts = 0;
  let leastAmps = Infinity;
  let mostAmps = -Infinity;
  for (let at = 0; at < sampleCount; at += 1) {
    if (sampleTimes[at] < sinceMs) {
      continue;
    }
    count += 1;
    sumAmps += sampleAmps[at];
    sumVolts += sampleVolts[at];
    leastAmps = Math.min(leastAmps, sampleAmps[at]);
    mostAmps = Math.max(mostAmps, sampleAmps[at]);
  }
  if (count < LEAST_SAMPLES || mostAmps - leastAmps < LEAST_SPREAD_A) {
    return null;
  }
  const meanAmps = sumAmps / count;
  const meanVolts = sumVolts / count;
  let ampsSquared = 0;
  let crossProduct = 0;
  let voltsSquared = 0;
  for (let at = 0; at < sampleCount; at += 1) {
    if (sampleTimes[at] < sinceMs) {
      continue;
    }
    const deltaAmps = sampleAmps[at] - meanAmps;
    const deltaVolts = sampleVolts[at] - meanVolts;
    ampsSquared += deltaAmps * deltaAmps;
    crossProduct += deltaAmps * deltaVolts;
    voltsSquared += deltaVolts * deltaVolts;
  }
  if (ampsSquared <= 0) {
    return null;
  }
  const slope = crossProduct / ampsSquared;
  const milliohms = slope * 1000;
  if (milliohms < LEAST_PLAUSIBLE_MOHM || milliohms > MOST_PLAUSIBLE_MOHM) {
    return null;
  }
  const residualSquares = Math.max(voltsSquared - slope * crossProduct, 0);
  const standardError = (Math.sqrt(residualSquares / (count - 2) / ampsSquared) * 1000) / milliohms;
  if (!Number.isFinite(standardError) || standardError > MOST_RELATIVE_ERROR) {
    return null;
  }
  return milliohms;
}

/**
 * The measured curve, linearly interpolated, endpoints held flat.
 * @param {number} packCelsius
 * @returns {number}
 */
function modelledMilliohms(packCelsius) {
  const first = RESISTANCE_BY_TEMPERATURE[0];
  const last = RESISTANCE_BY_TEMPERATURE[RESISTANCE_BY_TEMPERATURE.length - 1];
  // Clamping is what holds the endpoints flat: at either end `across` lands on 0 or 1
  // and the interpolation below returns that endpoint unchanged.
  const celsius = Math.min(Math.max(packCelsius, first[0]), last[0]);
  for (let i = 1; i < RESISTANCE_BY_TEMPERATURE.length; i += 1) {
    const [upperCelsius, upperMilliohms] = RESISTANCE_BY_TEMPERATURE[i];
    if (celsius > upperCelsius) {
      continue;
    }
    const [lowerCelsius, lowerMilliohms] = RESISTANCE_BY_TEMPERATURE[i - 1];
    const across = (celsius - lowerCelsius) / (upperCelsius - lowerCelsius);
    return lowerMilliohms + across * (upperMilliohms - lowerMilliohms);
  }
  return last[1];
}
