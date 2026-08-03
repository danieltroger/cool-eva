// Monotonic time, for anything that measures a DURATION.
//
// This process steps its own wall clock: src/gps/clock.ts runs `date -u -s` when
// satellite time disagrees with the system clock by more than a minute, because
// the Pi has no RTC and a boot without network starts with a nonsense date. That
// step happens from inside the same frame-handling loop as everything else.
//
// So `Date.now()` differences are not durations here — they are two readings of a
// clock that can jump in either direction mid-measurement:
//   • a backwards step makes an elapsed time negative, so a "wait at most N ms"
//     loop waits far longer than N — or, against a deadline captured before the
//     step, never finishes at all;
//   • a forwards step makes it huge, so a timeout fires early and a rate limit or
//     backoff is skipped entirely.
//
// Both have already shipped and been fixed twice — in gps/clock.ts (a rate limiter
// measured against the clock it was stepping) and can/pack-temperature.ts (a 5 s
// window that a step could end early or never).
//
// performance.now() is monotonic and unaffected by `date -s`, so use these for
// timeouts, deadlines, backoff and rate limits. Keep Date.now() for what it is
// good at: stamping *when* something happened, in real time someone can read —
// reading timestamps, WebSocket message times, and the GPS-vs-system comparison
// in gps/clock.ts that exists precisely to measure the difference.

/** Milliseconds from an arbitrary origin. Only differences are meaningful. */
export function monotonicNow(): number {
  return performance.now();
}

/** Milliseconds elapsed since a mark taken with monotonicNow(). Never negative. */
export function since(markMs: number): number {
  return monotonicNow() - markMs;
}
