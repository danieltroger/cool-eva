import type { TemperatureSample } from "../src/charge/rate.ts";

// A REAL thermal episode off the bike, 2026-08-08 13:32-14:09 UTC: the pack climbed to the cliff,
// touched 55 °C, and came back down. Every value is `batt_temp_hi` exactly as logged.
//
// ⚠️ THIS IS THE ONLY THING THAT DEMONSTRATES THE TWO TIERS. The simulated plant cannot produce the
// situation they exist for — its packs are always either rising or pinned at the floor, never
// sitting with a fitted slope near zero at a reading of 53. The real pack reaches that state by
// OSCILLATING across the boundary, which is a limitation of the model's shape rather than its
// constants. Across the logged series there are 71 ticks at a reading of 53; on 20 of them the old
// single-ceiling rule steps the current down and the two-tier rule holds, and on none of them is
// the two-tier rule the more aggressive of the two.
//
// The clearest is 13:51:31 onwards: the pack reads 53 and is FALLING — it reaches 50 over the next
// twelve minutes — and the old rule throttled it three ticks running for no reason at all.

/** Milliseconds from the first sample, so the fixture carries no wall clock. */
export const COOLING_EPISODE: TemperatureSample[] = [
  { atMs: 0, celsius: 50 },
  { atMs: 207288, celsius: 51 },
  { atMs: 304427, celsius: 52 },
  { atMs: 427596, celsius: 53 },
  { atMs: 584822, celsius: 54 },
  { atMs: 765070, celsius: 55 },
  { atMs: 826155, celsius: 54 },
  { atMs: 1113576, celsius: 53 },
  { atMs: 1368951, celsius: 52 },
  { atMs: 1533195, celsius: 51 },
  { atMs: 1807609, celsius: 50 },
  { atMs: 2075017, celsius: 49 },
  { atMs: 2214216, celsius: 48 },
];

/** Where in that episode the reading first comes back down to 53 while still falling. */
export const COOLING_AT_53_MS = 1113576;
