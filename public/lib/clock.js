// @ts-check

// Time on the phone. Mirrors src/monotonic.ts, and exists for a second reason on
// top of it.
//
// **Durations must be monotonic.** `performance.now()` is unaffected by the phone
// picking up NTP, crossing a timezone, or the rider changing the clock — all of
// which move `Date.now()` under a measurement in progress. Everything here that
// asks "how long since…" uses monotonicNow().
//
// **There are two wall clocks, and they disagree.** Signal timestamps (`LiveValue.ts`)
// come from the Pi, which has no RTC: until its first GPS fix it can be hours or
// years out from the phone. So a client `Date.now()` must never be compared against
// a server `ts` — the first version of the ring buffer did exactly that (pushing
// `reading.ts` and querying with `Date.now()`), which on a cold-booted Pi silently
// emptied every sparkline for the whole ride, or filled it with samples dated in
// the future.
//
// The rule that falls out, and the one the rest of public/ follows:
//
//   • elapsed time on the phone      → monotonicNow() / since(), from here
//   • comparing two server stamps    → serverTime.val vs LiveValue.ts, both wall
//   • a client clock vs a server ts  → never

/** Milliseconds from an arbitrary origin. Only differences are meaningful. */
export function monotonicNow() {
  return performance.now();
}

/**
 * Milliseconds elapsed since a mark taken with monotonicNow(). Never negative.
 * @param {number} markMs
 */
export function since(markMs) {
  return monotonicNow() - markMs;
}
