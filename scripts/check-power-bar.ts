import { power } from "../public/lib/colors.js";
import { BAD, CALM, GOOD, MUTED, WARN, WATCH } from "../public/lib/colors.js";
import { limitMarkerPositions } from "../public/lib/svg.js";
import { powerLimitsKw } from "../public/lib/power-limits.js";

// The riding screen's power bar, checked from Node.
//
//   node --experimental-strip-types scripts/check-power-bar.ts
//
// Everything here is a direction or a side, and every one of them is invisible when it
// is backwards: a green bar and an amber bar both look like a working dashboard, and a
// dashed line 40% along the bar looks equally deliberate on either side of the centre.
// The colour ramp shipped INVERTED from 2026-08-03 (#33) until 2026-09-08 — regen amber,
// a hard pull green — under a doc comment that described it correctly the whole time.
// That is the failure this file exists to make loud.
//
// Node has no DOM, so this reaches the two pure pieces rather than the drawn SVG:
// `limitMarkerPositions()` decides which side each dashed line lands on, and
// `powerLimitsKw()` takes its reader as a parameter the way charge-mode.js does.
//
// §5 exists because covering those two ENDS is not the same as covering the path
// between them. An earlier draft asserted both and still went green with the two sides
// crossed at the call site, which draws 96 kW of regen and 38 kW of drive — a screen
// that looks entirely deliberate. The pair is one object now so the outer hop cannot be
// spelled wrong at all, and §5 walks the whole way through the remaining one.

/**
 * Sign convention, restated as a literal rather than imported.
 *
 * derive.js asserts it in prose — `pack_a` and `pack_kw` are NEGATIVE under discharge
 * and positive on regen and charge — and this check is worthless if it derives its
 * expectations from the same code it is checking. So the two riding cases are written
 * out as numbers a person can verify against the bike.
 */
const DRIVE_KW = -100;
const REGEN_KW = 20;

/** ride.js's POWER_LIMIT_KW. Copied, not imported: ride.js pulls in van, which needs a DOM. */
const FULL_SCALE_KW = 130;
const CENTRE = 50;

const failures: string[] = [];

// 1. Colour. Regen is green because energy is coming back; drive is not, at any load.
if (power(REGEN_KW) !== GOOD) {
  failures.push(
    `${REGEN_KW} kW is REGEN on this bike (pack_kw is positive on regen) and must be ${GOOD}, got ${power(REGEN_KW)}`
  );
}
if (power(DRIVE_KW) === GOOD) {
  failures.push(
    `${DRIVE_KW} kW is a hard PULL (pack_kw is negative under discharge) and must not be the green ${GOOD} — ` +
      `that is the inversion that shipped for five weeks`
  );
}
if (power(null) !== MUTED) {
  failures.push(`no reading must be ${MUTED}, got ${power(null)}`);
}
// The ramp is the other half of the same statement: a harder pull must never read
// calmer. Saturation is expected — the top band is everything past 40 kW — so this is
// ordering plus a floor on how many steps are actually distinct, which is what stops a
// ramp collapsed to one colour from passing as monotone.
const SEVERITY = [CALM, WATCH, WARN, BAD];
const ramp = [-1, -5, -20, -60, -120];
const seen = new Set<string>();
for (let index = 0; index < ramp.length; index++) {
  const colour = power(ramp[index]);
  const rank = SEVERITY.indexOf(colour);
  if (rank < 0) {
    failures.push(`${ramp[index]} kW is drive and reads ${colour}, which is not on the drive ramp at all`);
    continue;
  }
  seen.add(colour);
  if (index > 0 && rank < SEVERITY.indexOf(power(ramp[index - 1]))) {
    failures.push(
      `${ramp[index]} kW reads calmer than ${ramp[index - 1]} kW (${colour} after ${power(ramp[index - 1])})`
    );
  }
}
if (seen.size < SEVERITY.length) {
  failures.push(`the drive ramp only reached ${seen.size} of ${SEVERITY.length} colours over ${ramp.join(", ")} kW`);
}

// 2. The kW conversion. Amps at the pack times the pack's own volts, and the two
//    boundary cases that a `positiveOrNull()`-shaped guard gets wrong in opposite ways.
const reading = (values: Record<string, number>) => (key: string) => (key in values ? values[key] : null);

/** Nothing is stale in these cases unless a case says so — every reading is handed in fresh. */
const fresh = () => false;

const nominal = powerLimitsKw(reading({ "allowed_discharge_a": 300, "allowed_regen_a": 120, "pack_v": 320 }), fresh);
if (nominal.drive == null || Math.abs(nominal.drive - 96) > 1e-9) {
  failures.push(`300 A at 320 V is 96 kW of discharge, got ${nominal.drive}`);
}
if (nominal.regen == null || Math.abs(nominal.regen - 38.4) > 1e-9) {
  failures.push(`120 A at 320 V is 38.4 kW of regen, got ${nominal.regen}`);
}
if ((nominal.drive ?? 0) < 0 || (nominal.regen ?? 0) < 0) {
  failures.push("both limits are magnitudes; the bar decides the side, so a negative one would draw the wrong way");
}

const derated = powerLimitsKw(reading({ "allowed_discharge_a": 0, "allowed_regen_a": 0, "pack_v": 320 }), fresh);
if (derated.drive !== 0 || derated.regen !== 0) {
  failures.push(
    `a BMS derated to 0 A must report a 0 kW ceiling — the most important thing this can say — got ` +
      `${derated.drive} / ${derated.regen}`
  );
}

const noVoltage = powerLimitsKw(reading({ "allowed_discharge_a": 300, "allowed_regen_a": 120 }), fresh);
if (noVoltage.drive !== null || noVoltage.regen !== null) {
  failures.push(`amps with no pack voltage cannot be converted to kW, got ${noVoltage.drive} / ${noVoltage.regen}`);
}
const zeroVoltage = powerLimitsKw(reading({ "allowed_discharge_a": 300, "allowed_regen_a": 120, "pack_v": 0 }), fresh);
if (zeroVoltage.drive !== null || zeroVoltage.regen !== null) {
  failures.push(`0 V is a missing reading, not a pack — it must not draw a 0 kW ceiling on a healthy bike`);
}

// 3. Which side each dashed line lands on. Drive is negative kW and draws RIGHT of
//    centre, so its marker must too; regen draws left. Swapping them would read as the
//    BMS allowing 96 kW of regen and 38 kW of drive, which is a plausible-looking lie.
const positions = limitMarkerPositions({
  limits: { drive: 96, regen: 38.4 },
  fullScale: FULL_SCALE_KW,
  centre: CENTRE,
});
if (positions.length !== 2) {
  failures.push(`two in-range limits must draw two lines, got ${positions.length}`);
} else {
  const [drive, regen] = positions;
  if (drive <= CENTRE) {
    failures.push(`the discharge limit must draw right of centre (${CENTRE}), landed at ${drive}`);
  }
  if (regen >= CENTRE) {
    failures.push(`the regen limit must draw left of centre (${CENTRE}), landed at ${regen}`);
  }
  const expectedDrive = CENTRE + (96 / FULL_SCALE_KW) * CENTRE;
  if (Math.abs(drive - expectedDrive) > 1e-9) {
    failures.push(`96 kW of ${FULL_SCALE_KW} kW belongs at x=${expectedDrive}, landed at ${drive}`);
  }
}

// 4. …and the ends. A ceiling wider than the bar is PINNED there rather than dropped:
//    dropping made it indistinguishable from "0x202 has not arrived", which is 5-11% of
//    moving time, while both readings of a pinned line say "the pack is not your limit".
//    The pin must also stay inside the viewBox, or the stroke is half clipped away.
const pinned = limitMarkerPositions({ limits: { drive: 400, regen: null }, fullScale: FULL_SCALE_KW, centre: CENTRE });
const atFullScale = limitMarkerPositions({
  limits: { drive: FULL_SCALE_KW, regen: null },
  fullScale: FULL_SCALE_KW,
  centre: CENTRE,
});
if (pinned.length !== 1 || atFullScale.length !== 1) {
  failures.push(`a ceiling at or past full scale still draws one line, got ${pinned.length} and ${atFullScale.length}`);
} else {
  if (pinned[0] !== atFullScale[0]) {
    failures.push(`a ceiling past full scale must pin where one AT full scale sits, ${pinned[0]} vs ${atFullScale[0]}`);
  }
  if (pinned[0] >= 2 * CENTRE || pinned[0] <= CENTRE) {
    failures.push(`the pinned line must sit inside the bar's right end, landed at ${pinned[0]}`);
  }
}
const fullyDerated = limitMarkerPositions({ limits: { drive: 0, regen: 0 }, fullScale: FULL_SCALE_KW, centre: CENTRE });
if (fullyDerated.length !== 2 || fullyDerated.some(x => x !== CENTRE)) {
  failures.push(`a 0 kW ceiling belongs ON the centre line — the bar cannot move at all — got ${fullyDerated}`);
}
const noLimits = limitMarkerPositions({
  limits: { drive: null, regen: null },
  fullScale: FULL_SCALE_KW,
  centre: CENTRE,
});
if (noLimits.length !== 0) {
  failures.push(`a bike that has not sent 0x202 yet must draw no lines, got ${noLimits.length}`);
}
if (limitMarkerPositions({ limits: null, fullScale: FULL_SCALE_KW, centre: CENTRE }).length !== 0) {
  failures.push("a bar handed no limits at all must draw no lines");
}

// 5. A charge is up. Both ceilings must go quiet: the BMS zeroes them during a DC
//    session because neither path carries that current, so drawing them puts two
//    ceilings of 0 kW under a bar showing +24 kW of charge power — on a screen the
//    rider can be looking at mid-charge, and fresh enough that staleness never fires.
const dcCharging = powerLimitsKw(
  reading({ "allowed_discharge_a": 0, "allowed_regen_a": 0, "pack_v": 341, "fast_dc_contactor": 1 }),
  fresh
);
if (dcCharging.drive !== null || dcCharging.regen !== null) {
  failures.push(
    `nothing may be claimed about the ceilings during a DC charge, got ${dcCharging.drive} / ${dcCharging.regen}`
  );
}
const acCharging = powerLimitsKw(
  reading({ "allowed_discharge_a": 280, "allowed_regen_a": 34, "pack_v": 341, "bms_state_charge": 1 }),
  fresh
);
if (acCharging.drive !== null || acCharging.regen !== null) {
  failures.push(`the same goes for an AC charge, got ${acCharging.drive} / ${acCharging.regen}`);
}

// 6. End to end, through the shape the view actually forwards. §2 and §3 each cover one
//    end; this is the only case that fails if the two are joined the wrong way round.
//    Deliberately asymmetric amps, so a swap cannot land on the same number by accident.
const endToEnd = limitMarkerPositions({
  limits: powerLimitsKw(reading({ "allowed_discharge_a": 300, "allowed_regen_a": 60, "pack_v": 320 }), fresh),
  fullScale: FULL_SCALE_KW,
  centre: CENTRE,
});
if (endToEnd.length !== 2) {
  failures.push(`a riding bike draws both lines, got ${endToEnd.length}`);
} else if (endToEnd[0] <= CENTRE || endToEnd[1] >= CENTRE) {
  failures.push(
    `300 A of discharge and 60 A of regen must draw right and left of ${CENTRE} respectively, got ` +
      `${endToEnd[0]} and ${endToEnd[1]} — the two ceilings are crossed somewhere between the reader and the bar`
  );
}

console.log(`colour: ${REGEN_KW} kW regen is ${power(REGEN_KW)}, ${DRIVE_KW} kW drive is ${power(DRIVE_KW)}`);
console.log(`limits: 300 A / 120 A at 320 V is ${nominal.drive} kW drive and ${nominal.regen} kW regen`);
console.log(`markers: ${positions.map(x => x.toFixed(2)).join(", ")} on a bar centred at ${CENTRE}`);
console.log(`end to end: 300 A / 60 A at 320 V lands at ${endToEnd.map(x => x.toFixed(2)).join(", ")}`);

if (failures.length > 0) {
  console.error("FAILED:");
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  process.exit(1);
}
console.log(
  "✓ regen is green and drive never is, the ramp gets warmer with load, both ceilings convert through the measured " +
    "pack voltage with 0 A surviving and 0 V rejected, both go quiet while a charge is up, and the dashed lines " +
    "land on the sides the fill uses — end to end, pinned inside the bar rather than dropped off it"
);
