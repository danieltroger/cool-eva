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

const nominal = powerLimitsKw(reading({ "allowed_discharge_a": 300, "allowed_regen_a": 120, "pack_v": 320 }));
if (nominal.drive == null || Math.abs(nominal.drive - 96) > 1e-9) {
  failures.push(`300 A at 320 V is 96 kW of discharge, got ${nominal.drive}`);
}
if (nominal.regen == null || Math.abs(nominal.regen - 38.4) > 1e-9) {
  failures.push(`120 A at 320 V is 38.4 kW of regen, got ${nominal.regen}`);
}
if ((nominal.drive ?? 0) < 0 || (nominal.regen ?? 0) < 0) {
  failures.push("both limits are magnitudes; the bar decides the side, so a negative one would draw the wrong way");
}

const derated = powerLimitsKw(reading({ "allowed_discharge_a": 0, "allowed_regen_a": 0, "pack_v": 320 }));
if (derated.drive !== 0 || derated.regen !== 0) {
  failures.push(
    `a BMS derated to 0 A must report a 0 kW ceiling — the most important thing this can say — got ` +
      `${derated.drive} / ${derated.regen}`
  );
}

const noVoltage = powerLimitsKw(reading({ "allowed_discharge_a": 300, "allowed_regen_a": 120 }));
if (noVoltage.drive !== null || noVoltage.regen !== null) {
  failures.push(`amps with no pack voltage cannot be converted to kW, got ${noVoltage.drive} / ${noVoltage.regen}`);
}
const zeroVoltage = powerLimitsKw(reading({ "allowed_discharge_a": 300, "allowed_regen_a": 120, "pack_v": 0 }));
if (zeroVoltage.drive !== null || zeroVoltage.regen !== null) {
  failures.push(`0 V is a missing reading, not a pack — it must not draw a 0 kW ceiling on a healthy bike`);
}

// 3. Which side each dashed line lands on. Drive is negative kW and draws RIGHT of
//    centre, so its marker must too; regen draws left. Swapping them would read as the
//    BMS allowing 96 kW of regen and 38 kW of drive, which is a plausible-looking lie.
const positions = limitMarkerPositions({ driveLimit: 96, regenLimit: 38.4, fullScale: FULL_SCALE_KW, centre: CENTRE });
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

// 4. …and when nothing is drawn. A limit wider than the bar is dropped rather than
//    pinned to the end, where it would sit under the border and be unreadable anyway.
const offScale = limitMarkerPositions({ driveLimit: 140, regenLimit: null, fullScale: FULL_SCALE_KW, centre: CENTRE });
if (offScale.length !== 0) {
  failures.push(`a ${FULL_SCALE_KW}+ kW ceiling is off the bar and must be dropped, got ${offScale.length} line(s)`);
}
const atFullScale = limitMarkerPositions({
  driveLimit: FULL_SCALE_KW,
  regenLimit: null,
  fullScale: FULL_SCALE_KW,
  centre: CENTRE,
});
if (atFullScale.length !== 1 || Math.abs(atFullScale[0] - 2 * CENTRE) > 1e-9) {
  failures.push(`a ceiling of exactly ${FULL_SCALE_KW} kW belongs at the bar's end, got ${atFullScale}`);
}
const fullyDerated = limitMarkerPositions({ driveLimit: 0, regenLimit: 0, fullScale: FULL_SCALE_KW, centre: CENTRE });
if (fullyDerated.length !== 2 || fullyDerated.some(x => x !== CENTRE)) {
  failures.push(`a 0 kW ceiling belongs ON the centre line — the bar cannot move at all — got ${fullyDerated}`);
}
const noLimits = limitMarkerPositions({
  driveLimit: null,
  regenLimit: null,
  fullScale: FULL_SCALE_KW,
  centre: CENTRE,
});
if (noLimits.length !== 0) {
  failures.push(`a bike that has not sent 0x202 yet must draw no lines, got ${noLimits.length}`);
}

console.log(`colour: ${REGEN_KW} kW regen is ${power(REGEN_KW)}, ${DRIVE_KW} kW drive is ${power(DRIVE_KW)}`);
console.log(`limits: 300 A / 120 A at 320 V is ${nominal.drive} kW drive and ${nominal.regen} kW regen`);
console.log(`markers: ${positions.map(x => x.toFixed(2)).join(", ")} on a bar centred at ${CENTRE}`);

if (failures.length > 0) {
  console.error("FAILED:");
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  process.exit(1);
}
console.log(
  "✓ regen is green and drive never is, the ramp gets warmer with load, both ceilings convert through the measured " +
    "pack voltage with 0 A surviving and 0 V rejected, and the dashed lines land on the sides the fill uses"
);
