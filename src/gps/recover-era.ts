// The machine the offline waypoint recovery is modelling: what the bike's handlebar gestures
// did on the days being recovered, and the instant it stopped doing it.
//
// ⚠️ These are HISTORICAL FACTS about days already ridden, not live policy, which is why they
// live apart from src/gestures/runner.ts and src/gps/waypoint.ts rather than being imported
// from them. They were split out of scripts/recover-waypoints.ts when a second reader appeared:
// scripts/import-ride-log.ts has to know where the era ENDS in order to bound what it commits,
// and it cannot import that script — which runs `await main()` at module scope.

/**
 * The gesture beat in force on the days being recovered.
 *
 * ⚠️ NOT imported from src/gestures/runner.ts. That constant is 50 ms today because #197
 * halved it; it was 100 ms while these rides happened, and importing it would silently
 * re-place every recovered point the next time it moves.
 */
export const BEAT_MS_ON_THE_RECOVERY_DAYS = 100;

/**
 * The waypoint threshold in force on those days, before #197 trimmed it.
 *
 * ⚠️ Also NOT imported, and the asymmetry with WAYPOINT_HOLD_MS is deliberate. That one is
 * live POLICY — what should be recovered today — and is imported. This is a fact about the
 * past, and the two shared a number once by coincidence. Importing it would do more than shift
 * points: `durationMs >= legacyHoldMs` decides WHICH COUNTERFACTUAL applies, so a future trim
 * to 400 ms would silently reclassify holds between the two populations and change the
 * argument rather than the arithmetic.
 */
export const LEGACY_HOLD_MS = 1000;

/**
 * When the bike stopped running the beat above: #197 (`9b6970a`), 2026-09-10 23:55:06 +0200.
 *
 * ⚠️ The DEPLOY to the Pi is later than the commit, so a window ending here errs towards
 * judging too little rather than placing a point with a beat that no longer existed — the safe
 * direction. Anything past it must be judged by whatever the bike was actually running, which
 * this file does not know. docs/waypoints.md §"Not losing the ride log".
 */
export const LEGACY_BEAT_ERA_END_MS = Date.parse("2026-09-10T21:55:06Z");
