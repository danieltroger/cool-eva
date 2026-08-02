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
   * @param {number} ts
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
   * @param {number} now
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
