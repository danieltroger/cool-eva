// When a CAN frame actually arrived, according to the kernel — and how late we were
// answering it.
//
// ⚠️ THIS MEASURES THE ONE THING A TIMESTAMP TAKEN IN OUR OWN HANDLER CANNOT. That
// handler runs after libuv has already dispatched it, so a `monotonicNow()` pair inside
// it brackets our own arithmetic and reads tens of microseconds under every load,
// including the loads where the event loop is the problem. The gap that matters —
// kernel arrival to our transmit — is only visible with a stamp taken before we ran.
//
// The kernel has been stamping every frame all along: src/can/socket.ts opens the
// channel with receive timestamps on, and src/types.d.ts declares the fields. Nothing
// read them until docs/lifetime-battery-statistics.md needed to know whether the
// service can answer a First Frame in time.
//
// ⚠️ IT IS CLOCK_REALTIME — the clock src/gps/clock.ts steps with `date -u -s`, because
// this Pi has no RTC. So this is the one place a duration is deliberately NOT taken
// with monotonicNow(): the two ends come from different clocks and only the kernel owns
// one of them. `arrivalLatencyMs` is where that is made safe, by refusing an answer
// rather than returning a stepped one.

/** One frame's arrival, as the kernel recorded it. Seconds and microseconds since the epoch. */
export interface FrameArrival {
  seconds: number;
  microseconds: number;
}

/**
 * The kernel's stamp for one frame, or null when this build did not supply one.
 *
 * ⚠️ Zero is treated as absent, not as 1970. `socketcan`'s native build is the one
 * dependency this repo cannot check from a laptop, nothing has ever read these fields,
 * and a missing stamp read as an epoch instant would produce a confident latency of
 * fifty-six years — or, once subtracted the other way, a confident `0.0 ms` that looks
 * exactly like the success it is meant to be measuring.
 */
export function frameArrival(message: { ts_sec?: number; ts_usec?: number }): FrameArrival | null {
  const seconds = message.ts_sec;
  const microseconds = message.ts_usec;
  if (typeof seconds !== "number" || typeof microseconds !== "number" || seconds <= 0) {
    return null;
  }
  return { seconds, microseconds };
}

/** How late we were, or why that cannot be said. Never a number this module does not believe. */
export type ArrivalLatency =
  | { known: true; ms: number }
  | { known: false; reason: string; arrival: FrameArrival | null };

/**
 * Milliseconds from the kernel's arrival stamp to `nowMs`, a `Date.now()` sample taken
 * at the moment being measured.
 *
 * Refuses rather than returns for the two answers a stepped clock produces: a negative
 * gap (the clock jumped forward between arrival and now) and an implausibly large one
 * (it jumped back). Both are recorded with the raw stamp so the reading is still
 * evidence, and neither is stored as a duration.
 */
export function arrivalLatencyMs(arrival: FrameArrival | null, nowMs: number): ArrivalLatency {
  if (arrival === null) {
    return { known: false, reason: "the kernel supplied no arrival timestamp for this frame", arrival };
  }
  const ms = nowMs - (arrival.seconds * 1000 + arrival.microseconds / 1000);
  if (ms < 0) {
    return { known: false, reason: `arrived ${(-ms).toFixed(1)} ms in the future — the clock stepped`, arrival };
  }
  if (ms > MAX_PLAUSIBLE_LATENCY_MS) {
    return { known: false, reason: `${(ms / 1000).toFixed(1)} s is not a dispatch delay — the clock stepped`, arrival };
  }
  return { known: true, ms };
}

/**
 * Past this, the number is a clock step rather than a latency.
 *
 * Five seconds is far above anything the event loop can plausibly do to a frame — the
 * worst blocking this process has is a `better-sqlite3` write — and far below the
 * minute-sized steps `gps/clock.ts` makes, which is the failure being screened out.
 */
const MAX_PLAUSIBLE_LATENCY_MS = 5000;
