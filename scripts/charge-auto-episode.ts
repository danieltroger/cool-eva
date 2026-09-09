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
// twelve minutes — and the old rule throttled it four ticks running for no reason at all.

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

/**
 * 2026-09-07T15:09-15:26 UTC, inside the DC stops the plant's own constants were fitted from: the
 * reading comes back to 53 after a 55 excursion and is still drifting UP.
 *
 * ⚠️ SUPERSEDED EXPECTATION, kept because the DATA is what matters. Under #181's tiers this fixture
 * pinned "a pack reading 53 and drifting up must NOT be raised"; under the 54 °C setpoint it pins
 * the opposite — 53 is a degree below target, so the current goes up. `estimateHeatingRate` reads
 * +0.037 K/min here, which is the band where the decision is neither forced by the cliff nor
 * obvious, so it is still the fixture that would go red if the no-raise tier were reinstated.
 * docs/charge-auto.md § "Superseded: the two tiers at 53 and 54".
 */
export const DRIFTING_EPISODE: TemperatureSample[] = [
  { atMs: 0, celsius: 53 },
  { atMs: 557849, celsius: 54 },
  { atMs: 686054, celsius: 55 },
  { atMs: 777187, celsius: 54 },
  { atMs: 955443, celsius: 53 },
];

/** 15:26:08 UTC — a tick with the reading back at 53 and the fitted slope still positive. */
export const DRIFTING_AT_53_MS = 1008062;

/**
 * 2026-09-09, the DC stop that produced #186 — `batt_temp_hi` exactly as logged, from the moment
 * the session opened (`charge_manager_state` → 0x23 at 15:50:56, which is when `forgetSession`
 * clears the ring) to the moment the pack first read 54.
 *
 * ⚠️ THE FIXTURE THAT SHOWS THE STALE-SLOPE BUG: the reading climbs 46 → 50 in four and a half
 * minutes and then does not move for nearly ten, and the shipped estimator kept reporting the
 * steep early slope right through that silence. Numbers and consequence:
 * docs/charge-auto.md § "The silence is a bound too".
 *
 * ⚠️ OPEN-LOOP — these show what the rule would have DECIDED on this history, never what would
 * have HAPPENED. Closed-loop behaviour is the plant grid's job.
 */
export const SEPTEMBER_9_EPISODE: TemperatureSample[] = [
  { atMs: 1000, celsius: 46 },
  { atMs: 52_000, celsius: 47 },
  { atMs: 101_000, celsius: 48 },
  { atMs: 183_000, celsius: 49 },
  { atMs: 271_000, celsius: 50 },
  { atMs: 852_000, celsius: 51 },
  { atMs: 1_344_000, celsius: 52 },
  { atMs: 1_421_000, celsius: 53 },
  { atMs: 1_468_000, celsius: 54 },
];

/** 16:03:08 — the tick where the shipped rule commanded 65 A with the reading at 50. */
export const SEPTEMBER_9_RATCHET_MS = 732_000;

/** 16:07:08 — four ticks later, where it reached 45 A with the reading at 51. */
export const SEPTEMBER_9_AT_45A_MS = 972_000;
