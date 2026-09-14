import type { TemperatureSample } from "../src/charge/rate.ts";
import type { SocSample } from "../src/charge/soc.ts";

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

/**
 * 2026-09-13, the DC stop that produced #201's second field report — nrg AVIN 4052, 60 → 95 % SOC,
 * arriving at 44 °C. Three rings exactly as logged, from the session's first `soc` row
 * (12:03:43.797 UTC) to the tap that switched the controller off at 12:19:54.
 *
 * ⚠️ THE FIXTURE THAT SHOWS THE OVER-THROTTLE. `CLOSING` fires at 12:11:44 on a reading of **48**
 * — 49 arrives four seconds later — and the controller steps 76 → 70 → 68 → 64 → 59 while the pack
 * climbs to 50 and stops there. When Daniel switched it off at 84 % the ceiling went back to 80 A,
 * the pack took what it wanted, and `batt_temp_hi` held 50 for eight minutes and then fell. That is
 * the measurement the session-ahead veto exists for: docs/dc-taper.md.
 *
 * ⚠️ OPEN-LOOP, like the 2026-09-09 rings above — what the rule would DECIDE on this history, never
 * what would have happened.
 */
export const SEPTEMBER_13_EPISODE: TemperatureSample[] = [
  { atMs: 333, celsius: 44 },
  { atMs: 125501, celsius: 45 },
  { atMs: 206612, celsius: 46 },
  { atMs: 295740, celsius: 47 },
  { atMs: 391873, celsius: 48 },
  { atMs: 485002, celsius: 49 },
  { atMs: 668259, celsius: 50 },
];

/** `soc` across the same stop. Whole percent, logged on change, as src/charge/soc.ts reads it. */
export const SEPTEMBER_13_SOC: SocSample[] = [
  { atMs: 0, percent: 60 },
  { atMs: 21035, percent: 61 },
  { atMs: 49074, percent: 62 },
  { atMs: 85173, percent: 63 },
  { atMs: 117067, percent: 64 },
  { atMs: 145105, percent: 65 },
  { atMs: 181105, percent: 66 },
  { atMs: 209093, percent: 67 },
  { atMs: 245193, percent: 68 },
  { atMs: 273237, percent: 69 },
  { atMs: 305232, percent: 70 },
  { atMs: 341231, percent: 71 },
  { atMs: 369220, percent: 72 },
  { atMs: 405269, percent: 73 },
  { atMs: 433258, percent: 74 },
  { atMs: 465252, percent: 75 },
  { atMs: 497297, percent: 76 },
  { atMs: 529245, percent: 77 },
  { atMs: 565296, percent: 78 },
  { atMs: 593383, percent: 79 },
  { atMs: 625327, percent: 80 },
  { atMs: 665333, percent: 81 },
  { atMs: 693371, percent: 82 },
  { atMs: 733377, percent: 83 },
  { atMs: 769376, percent: 84 },
];

/** One step of `fast_dc_target_a` — the current the vehicle is asking the station for. */
export interface RequestStep {
  atMs: number;
  amps: number;
}

/**
 * `fast_dc_target_a` across the same stop, thinned to the steps that lasted more than five seconds.
 *
 * ⚠️ Thinned because the raw series ramps a dozen times a SECOND at a session's start and through
 * every change — 147 rows for fifteen steps — and a fixture nobody can read is a fixture nobody
 * checks. Every value here is logged; only the intermediate rungs of each ramp are dropped.
 */
export const SEPTEMBER_13_REQUEST_A: RequestStep[] = [
  { atMs: 35, amps: 73 },
  { atMs: 540735, amps: 71 },
  { atMs: 600639, amps: 69 },
  { atMs: 660743, amps: 70 },
  { atMs: 693245, amps: 69 },
  { atMs: 699545, amps: 68 },
  { atMs: 708146, amps: 67 },
  { atMs: 714547, amps: 66 },
  { atMs: 720647, amps: 65 },
  { atMs: 741349, amps: 63 },
  { atMs: 748750, amps: 62 },
  { atMs: 756950, amps: 61 },
  { atMs: 769551, amps: 60 },
  { atMs: 957307, amps: 59 },
  { atMs: 968008, amps: 58 },
];

/**
 * The controller's own 60 s ticks across that stop, as `charge_auto_reason` timestamps them, with
 * the commanded current it was holding when each one ran.
 *
 * ⚠️ `commandedAmps` is what the shipped rule stepped FROM, and it is load-bearing — replayed with
 * null every raise clamps at the ceiling and looks like a hold. check-charge-auto.ts §16 says what
 * that cost. The first two ticks are null because no command had landed yet.
 */
export const SEPTEMBER_13_TICKS = [
  { clock: "12:11:44", atMs: 480_203, reading: 48, soc: 75, commandedAmps: null },
  { clock: "12:12:44", atMs: 540_203, reading: 49, soc: 77, commandedAmps: 76 },
  { clock: "12:13:44", atMs: 600_203, reading: 49, soc: 79, commandedAmps: 70 },
  { clock: "12:15:44", atMs: 720_203, reading: 50, soc: 82, commandedAmps: 70 },
  { clock: "12:16:44", atMs: 780_203, reading: 50, soc: 84, commandedAmps: 64 },
];
