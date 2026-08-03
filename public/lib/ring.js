// @ts-check

// Phone-side history. The bike keeps none: its only persistence is the write-only
// encrypted log, which it cannot read back by design. So every trend line on this
// dashboard is built from what has arrived over the WebSocket since the page was
// opened, and nothing about it costs the Pi anything.
//
// Consequence worth knowing: reloading the page restarts the traces. That is the
// accepted trade for not keeping a plaintext buffer on a bike that gets stolen.
//
// Fixed-size typed arrays rather than a growing array of objects — this runs for a
// whole ride in a backgrounded Safari tab, and the allocation churn of the obvious
// implementation is exactly what gets a tab killed under memory pressure.
//
// Timestamps here are the PHONE's monotonic clock (lib/clock.js), never the Pi's
// `LiveValue.ts`. Two reasons, and both have teeth: these are only ever used to ask
// "how long ago", which must survive the phone's wall clock moving; and the Pi has
// no RTC, so mixing its stamps with a client `Date.now()` — which is what this did
// first — silently empties every trace on a cold-booted bike. Nothing in a chart
// needs to correlate with the ride log, so the simplest correct base is the local
// monotonic one.

/** Samples kept per signal. At the 2 Hz write rate below this is ~30 minutes. */
const CAPACITY = 3600;

/**
 * Highest rate a single signal is appended at. `pack_a` arrives at 20 Hz, which
 * would fill the buffer in 3 minutes and spend most of it on detail no sparkline
 * can show. Sampling on write keeps the window long and the cost flat.
 */
const MIN_INTERVAL_MS = 500;

export class Ring {
  #times = new Float64Array(CAPACITY);
  #values = new Float64Array(CAPACITY);
  #next = 0;
  #length = 0;

  /**
   * @param {number} ts monotonic, from lib/clock.js — NOT a server `LiveValue.ts`
   * @param {number} value
   */
  push(ts, value) {
    // Drop samples that arrive faster than the window needs. Checked against the
    // newest entry rather than a wall clock so a burst after a stall still lands.
    if (this.#length > 0) {
      const newest = this.#times[(this.#next - 1 + CAPACITY) % CAPACITY];
      if (ts - newest < MIN_INTERVAL_MS) {
        return;
      }
    }
    this.#times[this.#next] = ts;
    this.#values[this.#next] = value;
    this.#next = (this.#next + 1) % CAPACITY;
    if (this.#length < CAPACITY) {
      this.#length += 1;
    }
  }

  get length() {
    return this.#length;
  }

  /**
   * Oldest-to-newest samples from the last `windowMs`, as flat [t, v] pairs ready
   * for a polyline. Returns a fresh array; callers must not hold onto it.
   * @param {number} windowMs
   * @param {number} now monotonic, from lib/clock.js
   * @returns {{ times: number[], values: number[], min: number, max: number }}
   */
  since(windowMs, now) {
    const times = [];
    const values = [];
    let min = Infinity;
    let max = -Infinity;
    const oldest = this.#next - this.#length + CAPACITY;
    for (let offset = 0; offset < this.#length; offset++) {
      const index = (oldest + offset) % CAPACITY;
      const ts = this.#times[index];
      if (now - ts > windowMs) {
        continue;
      }
      const value = this.#values[index];
      times.push(ts);
      values.push(value);
      if (value < min) {
        min = value;
      }
      if (value > max) {
        max = value;
      }
    }
    return { times, values, min, max };
  }

  /** Newest value, or null if nothing has been pushed. */
  latest() {
    if (this.#length === 0) {
      return null;
    }
    return this.#values[(this.#next - 1 + CAPACITY) % CAPACITY];
  }

  /**
   * Mean over the last `windowMs`. Used for the rolling figures the hypermiling
   * view leads with, where an instantaneous number is too twitchy to act on.
   * @param {number} windowMs
   * @param {number} now
   */
  meanSince(windowMs, now) {
    const { values } = this.since(windowMs, now);
    if (values.length === 0) {
      return null;
    }
    let sum = 0;
    for (const value of values) {
      sum += value;
    }
    return sum / values.length;
  }
}

/**
 * Differences two windows sample-by-sample, pairing by *timestamp* rather than by
 * array index.
 *
 * Index pairing looks right and is not: two signals only line up by index if they
 * were sampled together, and nothing here guarantees that. coolant_in and
 * coolant_out are read from separate awaited calls and each is gated by its own
 * 0.05 °C deadband before it is pushed, so the two rings hold different numbers of
 * samples taken at different moments — on this bike coolant_in has roughly ten
 * times the rows of coolant_out. Subtracting by index would drift further into the
 * past the further along the window you look, and produce a plausible-looking
 * trace of the rate mismatch rather than of the quantity being measured.
 *
 * For each sample of `primary`, this takes the newest `reference` sample at or
 * before it — a zero-order hold, which is the correct reading of "what was the
 * inlet doing when the outlet was measured".
 *
 * @param {{ times: number[], values: number[] }} primary
 * @param {{ times: number[], values: number[] }} reference
 * @returns {number[]}
 */
export function differenceByTime(primary, reference) {
  /** @type {number[]} */
  const out = [];
  if (reference.times.length === 0) {
    return out;
  }
  // Both windows come out of Ring.since() oldest-first, so one forward walk does it.
  let index = 0;
  for (let position = 0; position < primary.times.length; position++) {
    const at = primary.times[position];
    while (index + 1 < reference.times.length && reference.times[index + 1] <= at) {
      index += 1;
    }
    // Skip primary samples older than anything in the reference window: there is
    // nothing to hold from, and extrapolating backwards would invent the value.
    if (reference.times[index] > at) {
      continue;
    }
    out.push(primary.values[position] - reference.values[index]);
  }
  return out;
}

/** @type {Map<string, Ring>} */
const rings = new Map();

/**
 * The history buffer for a signal, created on first use.
 * @param {string} key
 * @returns {Ring}
 */
export function ringFor(key) {
  let ring = rings.get(key);
  if (!ring) {
    ring = new Ring();
    rings.set(key, ring);
  }
  return ring;
}
