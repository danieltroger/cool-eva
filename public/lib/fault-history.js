// @ts-check
// Six-hour rising-edge history and thirty-minute membership: docs/fault-report.md.
import { ringFor } from "./ring.js";

/**
 * How far back "last seen" and the firing count may look. Deliberately longer than
 * RECENT_MS, per above.
 *
 * Not ring-limited: the "~30 minutes" figure on Ring's CAPACITY is the 2 Hz case
 * (pack current and friends). A dtc_* key lands once per diagnostics round — every
 * 6th BLE request at 10 s, so ~60 s — which puts 3600 samples at roughly 60 hours.
 * This constant is what bounds the reach, not the buffer.
 */
const HISTORY_MS = 6 * 60 * 60_000;

/**
 * When this code was last non-zero, and how many separate times it has fired.
 * @param {string} key
 * @param {number} now
 * @returns {{ lastSeenMs: number | null, firings: number }}
 */
export function historyOf(key, now) {
  return faultHistory(ringFor(key).since(HISTORY_MS, now), now);
}

/**
 * The pure half of the above, split out so it can be replayed against a recorded
 * timeline without a DOM — which is how the numbers on this screen were checked
 * against the real 2026-08-02 P0A07 sequence out of the ride log.
 *
 * Counts RISING EDGES, not samples. The signal is written on change, but the ring
 * is also fed by the whole-state snapshot the server broadcasts every 5 s, so
 * counting samples would report a code that latched once as having fired hundreds
 * of times — and "247× this session" about a single stuck fault is worse than
 * saying nothing.
 *
 * @param {{ times: number[], values: number[] }} samples oldest first
 * @param {number} now
 * @returns {{ lastSeenMs: number | null, firings: number }}
 */
export function faultHistory(samples, now) {
  const { times, values } = samples;
  let lastSeenAt = /** @type {number | null} */ (null);
  let firings = 0;
  let previous = 0;
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (value > 0) {
      lastSeenAt = times[index];
      if (previous <= 0) {
        firings++;
      }
    }
    previous = value;
  }
  return { lastSeenMs: lastSeenAt === null ? null : now - lastSeenAt, firings };
}

/** @param {number | null} ageMs */
export function describeLastSeen(ageMs) {
  if (ageMs === null) {
    return "not seen this session";
  }
  const minutes = Math.round(ageMs / 60_000);
  return minutes < 1 ? "cleared just now" : `last seen ${minutes} min ago`;
}

/** @param {string} key */
export function componentOf(key) {
  return Number(key.split("_")[1]);
}

/** @param {string} key */
export function symptomOf(key) {
  return Number(key.split("_")[2]);
}

/** @param {string} key */
export function rawLabel(key) {
  return `${componentOf(key)}/${symptomOf(key)}`;
}
