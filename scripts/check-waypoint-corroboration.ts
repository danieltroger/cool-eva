// ⚠️ GPS_TIME_SYNC is set before src/gps/waypoint.ts is imported, the same ordering
// scripts/check-hold-gestures.ts documents: systemClockTrust() is read at save time but
// SYNC_ENABLED is captured at module load, so setting this afterwards changes nothing.
//
// It is set ON PURPOSE here, and not as a convenience. The clock gate is what keeps #178's
// hole shut today — nothing can save a waypoint until five satellite readings agree, by
// which time a corrupt first fix has been superseded — so with the clock gate in the way
// the corroboration rule is unreachable and every assertion below would pass on a build
// that had none. GPS_TIME_SYNC=0 is the configuration in which the hole is open.
process.env.GPS_TIME_SYNC = "0";

import { boundsFor } from "../public/lib/bounds.js";
import { WAYPOINT_REFUSAL_TEXT } from "../public/lib/announce.js";
import { SIGNALS } from "../src/can/registry.ts";
import { defineSignals, latestValue, onChange, record } from "../src/can/signals.ts";

// The gate that refuses the FIRST fix of a run until a later sample has agreed with it.
//
//   node --experimental-strip-types scripts/check-waypoint-corroboration.ts
//
// #178: implausibleJumpKmh() compares a fix with the one before it and answers null when
// there is none, so a corrupt first fix was saved with nothing able to see it. The witness
// is a second SAMPLE: record() marks every decoded sample, deadbanded or not, so a mark
// newer than the fix means another sample arrived and moved the position by less than the
// 3 m deadband. Derivation and the archive numbers: docs/waypoints.md §"The first fix".
//
// ⚠️ EACH SECTION IS ITS OWN MODULE INSTANCE. `precedingFix` never returns to null once
// set, and "the first fix of a run" is exactly the null state — so a second boot is a
// fresh import rather than a reset function that would exist only for this file. The
// signal store is a static import of both copies, so liveState and the monotonic marks
// are shared, which is what makes the two halves comparable.

type WaypointModule = typeof import("../src/gps/waypoint.ts");

// ⚠️ DYNAMIC, and for the reason the header gives: a static import is hoisted above the
// assignment above, so src/gps/clock.ts would capture SYNC_ENABLED before it was set and
// every save below would be refused as `never-synced` — hiding the one gate this file is
// here to check behind a second one.
const { WAYPOINT_REFUSAL } = await import("../src/gps/waypoint.ts");

let failures = 0;

function check(what: string, condition: boolean): void {
  if (condition) {
    console.log(`  ✓ ${what}`);
  } else {
    console.error(`  ✗ ${what}`);
    failures += 1;
  }
}

/**
 * A fresh module instance of src/gps/waypoint.ts — one "boot".
 *
 * ⚠️ The query string is what makes it fresh, and it has to be built rather than written
 * as a literal: tsc resolves a literal specifier and fails on the `?boot=` suffix, while a
 * template with a substitution it cannot resolve is left alone. The same trick as boot()
 * below, which is why both go through here.
 */
async function loadBoot(tag: string): Promise<WaypointModule> {
  return (await import(`../src/gps/waypoint.ts?boot=${tag}`)) as WaypointModule;
}

/** A fresh boot with its fix tracker running, sharing the signal store. */
async function boot(tag: string): Promise<{ waypoint: WaypointModule; stop: () => void }> {
  const waypoint = await loadBoot(tag);
  return { waypoint, stop: waypoint.startWaypointFixTracking().stop };
}

/** One decoded sample, both axes together, the way src/gps/decode.ts emits them. */
function sample(latitude: number, longitude: number): void {
  record("gps_lat", latitude);
  record("gps_lon", longitude);
}

/** Lets the microtask that ../src/gps/waypoint.ts's onFixChanged runs in actually run. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

defineSignals(SIGNALS);

// --- 1. A position with no tracker at all -------------------------------------------

console.log("\n1. a position nothing has ever tracked is not a corroborated position");

sample(57.7, 11.97);
await settle();
const untracked = await loadBoot("untracked");
const beforeTracking = untracked.saveWaypointNow();
check(
  `a fix whose tracker was never started is refused (${beforeTracking.message})`,
  !beforeTracking.saved && beforeTracking.refusal === WAYPOINT_REFUSAL.FIX_UNCORROBORATED
);

// --- 2. The first fix of a run, and the sample that vouches for it -------------------

console.log("\n2. the first fix of a run, before and after a second sample");

const first = await boot("first");
// A DIFFERENT position from §1's, or record() suppresses it as an equal value and the
// tracker never sees a first fix at all.
let latitudeChanges = 0;
const stopCounting = onChange(changed => {
  if ("gps_lat" in changed) {
    latitudeChanges += 1;
  }
});
sample(45.374038, 14.321478);
await settle();
const uncorroborated = first.waypoint.saveWaypointNow();
check(
  `the first fix of a run, seen once, is refused (${uncorroborated.message})`,
  !uncorroborated.saved && uncorroborated.refusal === WAYPOINT_REFUSAL.FIX_UNCORROBORATED
);
check("…and nothing was written: no waypoint_lat for a refused save", latestValue("waypoint_lat") === null);

// ⚠️ THE GUARD THAT STOPS THE NEXT ASSERTION BEING ONE THAT CANNOT FAIL. If this second
// sample logged a row, `precedingFix` would be set and the save below would pass through
// the OTHER arm of the gate — green under a build with no corroboration rule at all. Equal
// values sit inside the deadband, so record() must NOT have fired a change here.
const changesBefore = latitudeChanges;
sample(45.374038, 14.321478);
await settle();
check(
  "⚠️  the second sample carries the same position, so nothing is logged and the fix is still unsuperseded",
  latitudeChanges === changesBefore
);
const corroborated = first.waypoint.saveWaypointNow();
check(
  `…and with that sample agreeing, the same fix saves (${corroborated.message})`,
  corroborated.saved && corroborated.sequence === 1
);
check("…and the position reaches the log", latestValue("waypoint_lat") === 45.374038);
stopCounting();

// --- 3. A fix that a later fix superseded ------------------------------------------

console.log("\n3. a fix with a predecessor is the shipped gate's business, not this one");

// ⚠️ ORDERED BEFORE §2b SINCE #241, and the reordering is a finding rather than tidying.
// `first`'s tracker is still running here, so §2b's sample — 8 km away, to a position this
// section knows nothing about — used to become this save's `precedingFix`. The old jump
// gate declined below its floor, so the fixture passed while measuring a pair it never
// meant to; the step rule judges that pair and refuses it. The move below is ~107 m, which
// is what this section is actually about.
sample(45.375, 14.3216);
await settle();
const superseded = first.waypoint.saveWaypointNow();
check(
  `a second, moved fix saves without waiting for another sample (${superseded.message})`,
  superseded.saved && superseded.sequence === 2
);
first.stop();

// --- 2b. Half a sample is not a sample ----------------------------------------------

// Numbered 2b because it belongs with §2; it RUNS after §3 because its sample would
// otherwise become §3's precedingFix — see the ⚠️ there.
console.log("\n2b. one axis refreshed on its own does not corroborate anything");

// ⚠️ A RAIL, NOT A FIX, and said so rather than left to look like a measured case:
// src/gps/decode.ts pushes gps_lat and gps_lon into one array and records them together,
// so the two marks never diverge on this bike. If a future transport ever emits half a
// fix, the OLDER of the two marks is the one that tells the truth about the pair — taking
// the newer would let a refreshed latitude vouch for a longitude nothing had re-seen.
const halfSample = await boot("half-sample");
sample(45.3, 14.3);
await settle();
record("gps_lat", 45.3);
await settle();
const halfWitnessed = halfSample.waypoint.saveWaypointNow();
check(
  `a latitude refreshed alone leaves the fix uncorroborated (${halfWitnessed.message})`,
  !halfWitnessed.saved && halfWitnessed.refusal === WAYPOINT_REFUSAL.FIX_UNCORROBORATED
);
halfSample.stop();

// --- 4. The 2026-08-09 shape, arriving as a run's FIRST fix -------------------------

console.log("\n4. ⚠️  the 2026-08-09 decode failure, as the first fix of a run");

const corrupt = await boot("corrupt");
// The same shape the archive holds: a longitude carrying an extra leading digit, while the
// latitude, the satellite count and the fix flag all look perfectly healthy. It is a legal
// longitude, so no range gate can see it, and it is the first fix of this run, so nothing
// precedes it either. Measured life of such a fix in liveState: at most 661 ms.
sample(57.7, 130.303698);
await settle();
const duringCorruption = corrupt.waypoint.saveWaypointNow();
check(
  `a save inside the corrupt sample's life is refused (${duringCorruption.message})`,
  !duringCorruption.saved && duringCorruption.refusal === WAYPOINT_REFUSAL.FIX_UNCORROBORATED
);
check("⚠️  …so the corrupt longitude never reaches the log", latestValue("waypoint_lon") !== 130.303698);

// The corrected sample, 541 ms later in the archive. It differs by thousands of km, so it
// is far past the deadband and IS logged — which supersedes the corrupt fix rather than
// corroborating it, and leaves liveState holding the truth.
sample(57.7, 13.037036);
await settle();
const afterCorrection = corrupt.waypoint.saveWaypointNow();
// ⚠️ THIS ASSERTION INVERTED WITH #241, and the inversion is a cost rather than a bug. The
// corrected fix is measured against the spike, so the step rule refuses it exactly as
// src/gps/fix-plausibility.ts says a spike costs TWO refusals — and below the floor that
// cost is new, because the gate used to decline there. Measured over the archive: 75 good
// fixes, 3 991.6 s — FIX_MAX_AGE_MS does not cap it, since record() marks the age before the
// deadband test. docs/waypoints.md §"What it costs to judge the other 93 %".
check(
  `⚠️  …the corrected fix is refused too, measured against the spike (${afterCorrection.message})`,
  !afterCorrection.saved && afterCorrection.refusal === WAYPOINT_REFUSAL.FIX_IMPLAUSIBLE
);
check("…and still nothing corrupt in the log", latestValue("waypoint_lon") !== 130.303698);

// The sample after THAT gives the gate a pair of good fixes, which is the recovery the
// rider sees: hold the button again and it works. 3.80 m east — the deadband is 0.00003°,
// which is 1.78 m of LONGITUDE at this latitude rather than the 3 m it is north-south, so
// this clears it by 2.1× and not by the 4× the round number would suggest.
sample(57.7, 13.0371);
await settle();
const recovered = corrupt.waypoint.saveWaypointNow();
check(
  `…and the next fix saves the corrected position (${recovered.message})`,
  recovered.saved && latestValue("waypoint_lon") === 13.0371
);
corrupt.stop();

// --- 4b. ⚠️ The same shape as the run's SECOND fix — the hole #178 left open ---------

console.log("\n4b. ⚠️  the 2026-08-09 decode failure arriving SECOND, at the ordinary cadence");

// This is the case #241 was filed for and the one §4's rule cannot reach: with a good fix
// already behind it, laterSampleAgreed() answers true on the other arm and the corroboration
// gate waves it through. Until the step rule there was nothing else — the fixes arrive
// ~550 ms apart at this hub, under implausibleJumpKmh()'s own floor, so it declined to
// judge 93 % of the archive's pairs and this one with them.
const secondFix = await boot("second-fix");
sample(45.375, 14.322);
await settle();
sample(45.375, 14.322);
await settle();
const goodFirst = secondFix.waypoint.saveWaypointNow();
check(`the run's first fix saves once a sample agrees (${goodFirst.message})`, goodFirst.saved);

sample(45.375, 130.303698);
await settle();
const corruptSecond = secondFix.waypoint.saveWaypointNow();
check(
  `⚠️  …and the corrupt SECOND fix is refused, by the step rule (${corruptSecond.message})`,
  !corruptSecond.saved && corruptSecond.refusal === WAYPOINT_REFUSAL.FIX_IMPLAUSIBLE
);
check(
  "⚠️  …so the corrupt longitude never reaches the log from the second fix either",
  latestValue("waypoint_lon") !== 130.303698
);

// ⚠️ THE COUNTERWEIGHT. Without it every assertion above is satisfied by a rule that
// refuses every pair under the floor, which is 93 % of them — the whole population this
// change newly judges. 0.0002° of latitude is 22.24 m, the scale of a real step at this
// cadence and an order below MAX_STEP_METRES. TWO samples, because the first still pays the
// spike's second refusal: only once both tracked fixes are good ones is the pair ordinary.
sample(45.3752, 14.322);
await settle();
sample(45.3754, 14.322);
await settle();
const ordinaryStep = secondFix.waypoint.saveWaypointNow();
check(`…while an ordinary ~22 m step at the same cadence saves (${ordinaryStep.message})`, ordinaryStep.saved);
secondFix.stop();

// --- 5. The code on the wire --------------------------------------------------------

console.log("\n5. the code reaches the phone as a code, not as a fault");

const refusalBounds = boundsFor("waypoint_refusal", "", "waypoint");
check(
  `public/lib/bounds.js admits ${WAYPOINT_REFUSAL.FIX_UNCORROBORATED} (bound ${refusalBounds?.join("…")})`,
  refusalBounds !== null && WAYPOINT_REFUSAL.FIX_UNCORROBORATED <= refusalBounds[1]
);
check(
  "…and still rejects a code no enum has, so the bound is a bound and not a hole",
  refusalBounds !== null && refusalBounds[1] < WAYPOINT_REFUSAL.FIX_UNCORROBORATED + 1
);
check(
  "…and public/lib/announce.js has a sentence for it, or a rider hears nothing",
  typeof WAYPOINT_REFUSAL_TEXT[WAYPOINT_REFUSAL.FIX_UNCORROBORATED] === "string"
);

console.log(
  failures === 0
    ? "\n✓ the first fix of a run is refused until a later sample agrees, the 2026-08-09 shape included"
    : `\n✗ the first-fix corroboration gate — ${failures} failure${failures === 1 ? "" : "s"}`
);
process.exit(failures === 0 ? 0 : 1);
