import type { LiveValue } from "../src/can/signals.ts";
import { apply } from "../public/lib/store.js";
import {
  COOLANT_FLOW_LPH,
  COOLANT_WATTS_PER_KELVIN,
  coolantDelta,
  coolantHeatRemovedWatts,
} from "../public/lib/derive.js";

// Heat out of the coolant loop, checked from Node.
//
//   node --experimental-strip-types scripts/check-coolant-heat.ts
//
// Run by `npm test` via scripts/run-checks.ts. Takes no arguments.
//
// ṁ·cp·ΔT is one multiplication, which is exactly why it was never checked: nothing in
// scripts/ imported derive.js at all until this file. #187 put the result on the riding
// screen beside the Charge tab's, so one constant now decides what two screens say, and
// every way it can be wrong is a plausible-looking number — swap the density and the
// specific heat and 4428 W becomes 3949 W, which is still a number a rider would
// believe. The multiplier is the whole assertion.
//
//   §1 the constant, against the arithmetic written out by hand
//   §2 the function, driven through the real store
//
// ⚠️ Floats, not equality. The delta of a 0.07 °C step is 0.07000000000000028 and the
// constant is 942.0833333333334 — a check written `=== 942.083` goes red on its first
// run and the temptation is then to soften the check rather than the comparison.

const failures: string[] = [];

function check(condition: boolean, description: string): void {
  if (condition) {
    console.log(`✓ ${description}`);
    return;
  }
  failures.push(description);
  console.log(`✗ ${description}`);
}

/**
 * The loop, written out rather than only imported — and then checked against the import.
 *
 * A check that multiplied derive.js's own constants together would pass for every value
 * of them. These are the physical claims a person can check: the Bosch PAD's rated
 * delivery, 50/50 ethylene glycol's specific heat and density. ⚠️ The flow is SPECIFIED
 * rather than measured — there is no flow sensor on this bike — so everything here
 * inherits that, which is why both screens now say "rated flow" beside the number.
 */
const RATED_FLOW_LPH = 850;
const GLYCOL_SPECIFIC_HEAT_J_PER_KG_K = 3800;
const GLYCOL_DENSITY_KG_PER_L = 1.05;
const WATTS_PER_KELVIN = (RATED_FLOW_LPH / 3600) * GLYCOL_DENSITY_KG_PER_L * GLYCOL_SPECIFIC_HEAT_J_PER_KG_K;

/** Generous next to a float's last bits, tight next to any real mistake in the formula. */
const TOLERANCE_W = 1e-6;

console.log("──── §1 the multiplier ────");

check(
  COOLANT_FLOW_LPH === RATED_FLOW_LPH,
  `derive.js ships the pump's rated ${COOLANT_FLOW_LPH} L/h, and this file checks ${RATED_FLOW_LPH}`
);
check(
  Math.abs(COOLANT_WATTS_PER_KELVIN - WATTS_PER_KELVIN) < TOLERANCE_W,
  `${COOLANT_WATTS_PER_KELVIN.toFixed(4)} W/K is (${RATED_FLOW_LPH}/3600) × ${GLYCOL_DENSITY_KG_PER_L} × ${GLYCOL_SPECIFIC_HEAT_J_PER_KG_K}`
);
// Water is the mistake this catches: 4180 J/(kg·K) at 1.0 kg/L gives 987 W/K, a 5%
// error that no screen could show as anything but a slightly different plausible number.
check(
  Math.abs(COOLANT_WATTS_PER_KELVIN - (RATED_FLOW_LPH / 3600) * 4180) > 10,
  "and it is glycol's figure, not water's"
);

console.log("\n──── §2 the function, through the store ────");

// First, before anything is seeded: a probe that has never reported is null, not zero.
// The riding tile hides itself on that null and the Charge tab prints "?" — a 0 would be
// a claim that the loop is carrying nothing, on a bike with no coolant probes fitted.
check(coolantDelta() === null && coolantHeatRemovedWatts() === null, "with no probes at all the answer is null");

/** The server's wall stamp. Only equality with the message's own matters. */
const TS = 1_788_768_000_000;

function reading(value: number): LiveValue {
  return { value, unit: "°C", group: "coolant", ts: TS };
}

/**
 * Both probes at once, through the real apply() — the same path a message off the
 * WebSocket takes, plausibility gate included. coolantDelta() reads the store through
 * valueOf() rather than a passed-in reader, so there is no lighter way in, and driving
 * the real one also proves these two keys survive bounds.js.
 */
function seed(inletCelsius: number, outletCelsius: number): void {
  apply({
    type: "patch",
    ts: TS,
    signals: { coolant_in: reading(inletCelsius), coolant_out: reading(outletCelsius) },
  });
}

// The worked example from #187: a barely-moving ΔT is still 66 W, which is the reason
// the tile shows watts at all rather than leaving the rider to multiply.
seed(31.4, 31.47);
const smallDelta = coolantDelta();
const smallWatts = coolantHeatRemovedWatts();
check(
  smallDelta !== null && Math.abs(smallDelta - 0.07) < 1e-9,
  `0.07 °C across the pack reads as ${smallDelta?.toFixed(5)}`
);
check(
  smallWatts !== null && Math.abs(smallWatts - 0.07 * WATTS_PER_KELVIN) < TOLERANCE_W,
  `and the loop is carrying ${smallWatts?.toFixed(2)} W`
);

// The riding fixture, so the number in the PR's screenshot is the number checked here.
seed(36.5, 41.2);
const ridingWatts = coolantHeatRemovedWatts();
check(
  ridingWatts !== null && Math.round(ridingWatts) === 4428,
  `the riding scene's 36.5 → 41.2 °C is ${ridingWatts === null ? "null" : Math.round(ridingWatts)} W out`
);

// Sign is not incidental: the inlet reading hotter than the outlet means the loop is
// putting heat INTO the pack, and a tile that dropped the sign would report a cooling
// system working hardest exactly when it has stopped.
seed(41.2, 36.5);
const reversed = coolantHeatRemovedWatts();
check(reversed !== null && reversed < 0, `a reversed ΔT gives ${reversed?.toFixed(0)} W, not its absolute value`);

// The sentinel must never reach the arithmetic: −242 °C through this multiplier is
// −259 kW of "cooling". That −242 is the failed-PT100 reading public/lib/bounds.js and
// CLAUDE.md both cite as the reason the plausibility gate exists.
//
// ⚠️ Their row count for it is NOT restated here: the figure is canon in six places but
// I could not reproduce it in today's rides.db (coolant_in: 32 813 rows, min 17.86 °C,
// none below −200, and the `readings` table empty), so it is presumably from an earlier
// database. The BAND is what this asserts, and the band is checkable.
//
// ⚠️ What apply() does with a rejected reading is hold the last good one, not null it —
// the value is diverted to faultState and the signal keeps what it had. So the tile goes
// on showing the last real ΔT rather than dropping to zero or going mad, and the fault
// surfaces on the ALL tab. Asserted here as the behaviour it IS, because the number this
// check exists to protect is one a sentinel could otherwise move by four orders.
seed(36.5, 41.2);
apply({
  type: "patch",
  ts: TS + 1,
  signals: { coolant_out: { value: -242, unit: "°C", group: "coolant", ts: TS + 1 } },
});
const afterSentinel = coolantHeatRemovedWatts();
check(
  afterSentinel !== null && Math.round(afterSentinel) === 4428,
  `a −242 °C sentinel leaves the last good ${afterSentinel === null ? "null" : Math.round(afterSentinel)} W standing`
);

console.log("");
if (failures.length > 0) {
  console.error(`✗ ${failures.length} failed:`);
  for (const description of failures) {
    console.error(`   ${description}`);
  }
  process.exit(1);
}
console.log(
  "✓ coolant heat: 942.08 W/K is glycol at the pump's rated flow, an unfitted probe is null and a sentinel " +
    "cannot move the number"
);
