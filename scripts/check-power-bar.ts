import { contrast, readPalettes, resolve, separation } from "./palette.ts";
import { FLOW, GOOD, MUTED, TRACK, power } from "../public/lib/colors.js";
import { CEILING_TICK, POWER_SCALE_KW, barLayers, ceilingMark, originY, reachable } from "../public/lib/power-bar.js";
import { powerLimitsKw } from "../public/lib/power-limits.js";

// The riding screen's power bar, checked from Node.
//
//   node --experimental-strip-types scripts/check-power-bar.ts
//
// Everything here is a direction or a side, and every one of them is invisible when it
// is backwards: a green bar and an amber bar both look like a working dashboard, and a
// ceiling 40% along the bar looks equally deliberate on either side of the origin. The
// colour ramp shipped INVERTED from 2026-08-03 (#33) until 2026-09-08 — regen amber, a
// hard pull green — under a doc comment that described it correctly the whole time.
// That is the failure this file exists to make loud.
//
// Node has no DOM, so this reaches the pure pieces rather than the drawn SVG:
// `originY()` and `reachable()` are the meter's geometry, `ceilingMark()` is the one
// state a screenshot cannot show, and `powerLimitsKw()` takes its reader as a parameter
// the way charge-mode.js does.
//
// §6 exists because covering the two ENDS is not the same as covering the path between
// them. An earlier draft asserted both and still went green with the two sides crossed
// at the call site, which draws 96 kW of regen and 38 kW of drive — a screen that looks
// entirely deliberate. Each pair is one object now so the outer hop cannot be spelled
// wrong at all, and §6 walks the whole way through the remaining one. §5 is the charge
// gate and §7 is the wall.

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

/**
 * The shipped scale, WRITTEN OUT rather than only imported — and then checked against the
 * import below.
 *
 * Asymmetric on purpose: the regen half is a bit over a quarter of the drive half, because
 * that is the shape of the machine. Everything downstream is a ratio of these two, so a
 * check that imported them would keep passing with the halves swapped — the exact failure
 * §6 exists for, one level up. The literals are what a person can check against the bike;
 * the equality below is what stops them going stale.
 */
const FULL_SCALE_KW = { drive: 130, regen: 36 };
if (FULL_SCALE_KW.drive !== POWER_SCALE_KW.drive || FULL_SCALE_KW.regen !== POWER_SCALE_KW.regen) {
  throw new Error(
    `power-bar.js now ships ${POWER_SCALE_KW.drive}/${POWER_SCALE_KW.regen} kW, not the ` +
      `${FULL_SCALE_KW.drive}/${FULL_SCALE_KW.regen} this file checks against. Verify the new scale against the ` +
      `bike and update the literals — do not delete them.`
  );
}
/** The strip is drawn in a 0…100 viewBox down its length. */
const LENGTH = 100;
const ORIGIN = originY({ fullScale: FULL_SCALE_KW });

const failures: string[] = [];

// 1. Colour. Regen is green because energy is coming back; drive is not, at any load.
if (power(REGEN_KW) !== GOOD) {
  failures.push(
    `${REGEN_KW} kW is REGEN on this bike (pack_kw is positive on regen) and must be ${GOOD}, got ${power(REGEN_KW)}`
  );
}
if (power(null) !== MUTED) {
  failures.push(`no reading must be ${MUTED}, got ${power(null)}`);
}
// Drive is one colour at every load — the ramp by magnitude is gone. A drive reading that
// comes back anything but FLOW is either the ramp returning or the sign convention
// inverted again, and both are silent on screen.
for (const kilowatts of [-0.4, -1, -5, -20, -60, DRIVE_KW, -120]) {
  if (power(kilowatts) !== FLOW) {
    const inverted =
      power(kilowatts) === GOOD ? ` — the green ${GOOD} here is the inversion that shipped for five weeks` : "";
    failures.push(`${kilowatts} kW is drive and must read ${FLOW} at any load, got ${power(kilowatts)}${inverted}`);
  }
}
// …and the marks the bar is made of have to stay apart, over both palettes.
//
// ⚠️ This block did nothing at all until 2026-09-08: TRACK and the fills are `var(--token)`
// strings, contrast() did `parseInt("ar", 16)`, and `NaN < floor` is false. It printed
// "rule over NaN, NaN, NaN:1" on every run. Tokens are resolved against style.css now.
//
// The FILL edge is the primary reading and is held higher than the marks: a draft that
// strengthened the derate edge instead cost the fill 17.9:1 → 2.5:1.
// docs/dashboard-decisions.md §"The power meter" has both failures in full.
const MIN_FILL_CONTRAST = 4;
/**
 * ⚠️ A RATCHET too, and the reason is the meter's shape: drive grows up out of the origin
 * and regen grows down, so with the strip mostly empty the ONLY thing saying which of the
 * two is happening is the fill's colour. Nothing derives 90; it sits under the shipped
 * 96.9 (dark) and 106.3 (light). Same measure as check-theme-contrast.ts's ramp: the a*b*
 * plane only, because a blue and a green that differ by lightness alone still read as one
 * colour through glare.
 */
const MIN_FLOW_SEPARATION = 90;
const palettes = await readPalettes();
for (const [themeName, palette] of palettes) {
  const track = resolve(palette, TRACK);
  const fills = [
    { what: `the drive fill (${DRIVE_KW} kW)`, hex: resolve(palette, power(DRIVE_KW)) },
    { what: `the regen fill (${REGEN_KW} kW)`, hex: resolve(palette, power(REGEN_KW)) },
  ];
  for (const fill of fills) {
    const ratio = contrast(fill.hex, track);
    if (ratio < MIN_FILL_CONTRAST) {
      failures.push(
        `${themeName}: ${fill.what} ${fill.hex} over the track ${track} is ${ratio.toFixed(2)}:1, under the ` +
          `${MIN_FILL_CONTRAST}:1 floor — that edge is where the rider reads how hard they are pulling`
      );
    }
    // ⚠️ There is no separate floor for the ceiling mark, and that is deliberate rather
    // than an omission: the mark is the track's own grey drawn ON the fill, so its edge is
    // the same two colours as the one above, and contrast() is symmetric. A draft shipped
    // that second check anyway, with a lower floor, in the very commit that repaired two
    // other checks for asserting nothing.
  }
  // ⚠️ …and the two fills must never be mistaken for each other. Direction is the whole
  // reading on a meter that grows both ways out of one point, and a blue and a green that
  // differ only in hue are a pair a rider in glare cannot separate.
  const drive = resolve(palette, power(DRIVE_KW));
  const regen = resolve(palette, power(REGEN_KW));
  if (separation(drive, regen) < MIN_FLOW_SEPARATION) {
    failures.push(
      `${themeName}: the drive fill ${drive} and the regen fill ${regen} are ` +
        `${separation(drive, regen).toFixed(1)} apart in a*b*, under ${MIN_FLOW_SEPARATION} — up and down on this ` +
        `meter are told apart by colour and by nothing else`
    );
  }
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

// 3. The origin, and which side each ceiling takes from. Each half gets the share of
//    the width its scale has of the total, so one viewBox unit is the same number of
//    kilowatts on both sides — the property the old centred bar did not have and paid
//    for in a documented "a given distance means different kilowatts" caveat.
const kwPerUnit = {
  drive: FULL_SCALE_KW.drive / ORIGIN,
  regen: FULL_SCALE_KW.regen / (LENGTH - ORIGIN),
};
if (Math.abs(kwPerUnit.drive - kwPerUnit.regen) > 1e-9) {
  failures.push(
    `one viewBox unit must be the same power on both halves, got ${kwPerUnit.drive} kW above the origin and ` +
      `${kwPerUnit.regen} below it — the halves are not sized by their scales`
  );
}
if (ORIGIN <= 0 || ORIGIN >= LENGTH) {
  failures.push(`the origin must be inside the bar, got ${ORIGIN}`);
}
if (ORIGIN <= LENGTH / 2) {
  failures.push(`drive is the larger scale and grows UP, so the origin sits below the middle, got ${ORIGIN}`);
}

// The strip is origin-out and drive draws UP, so the drive ceiling must shorten the TOP
// — smaller y. Crossing the two sides would read as the BMS allowing 96 kW of regen and 38 kW
// of drive, which is a plausible-looking lie.
// ⚠️ 27 of 36, deliberately NOT half a scale. It was 22.5 of 45, and half is the one ratio
// where measuring the REACHABLE part and the LOST part give the same answer — so these held
// under that mutation and only the drive half was really carrying them. 96 of 130 is not
// half either.
const reach = reachable({ limits: { drive: 96, regen: 27 }, fullScale: FULL_SCALE_KW });
const expectedFrom = ORIGIN - (96 / FULL_SCALE_KW.drive) * ORIGIN;
const expectedTo = ORIGIN + (27 / FULL_SCALE_KW.regen) * (LENGTH - ORIGIN);
if (Math.abs(reach.from - expectedFrom) > 1e-9) {
  failures.push(`a 96 kW ceiling on a ${FULL_SCALE_KW.drive} kW half reaches ${expectedFrom}, got ${reach.from}`);
}
if (Math.abs(reach.to - expectedTo) > 1e-9) {
  failures.push(`a 27 kW ceiling on a ${FULL_SCALE_KW.regen} kW half reaches ${expectedTo}, got ${reach.to}`);
}
if (reach.to <= ORIGIN || reach.from >= ORIGIN) {
  failures.push(`each side must reach outwards from the origin, got ${reach.from}…${reach.to} around ${ORIGIN}`);
}
// 4. The two ends, which used to be special cases. A ceiling past full scale had to be
//    dropped (indistinguishable from "0x202 has not arrived") or pinned (from a ceiling
//    AT full scale); a ceiling of zero sat on the old centre divider. Neither survives.
const roomToSpare = reachable({
  limits: { drive: 400, regen: null },
  fullScale: FULL_SCALE_KW,
});
if (roomToSpare.to !== LENGTH || roomToSpare.from !== 0) {
  failures.push(`a ceiling past full scale takes nothing away, got ${roomToSpare.from}…${roomToSpare.to}`);
}
const exactlyFull = reachable({
  limits: { drive: FULL_SCALE_KW.drive, regen: FULL_SCALE_KW.regen },
  fullScale: FULL_SCALE_KW,
});
if (Math.abs(exactlyFull.to - LENGTH) > 1e-9 || Math.abs(exactlyFull.from) > 1e-9) {
  failures.push(`a ceiling AT full scale takes nothing away either, got ${exactlyFull.from}…${exactlyFull.to}`);
}
const shutDown = reachable({
  limits: { drive: 0, regen: 0 },
  fullScale: FULL_SCALE_KW,
});
if (shutDown.from !== ORIGIN || shutDown.to !== ORIGIN) {
  failures.push(
    `a 0 kW ceiling leaves NO track — the loudest thing this bar says — got ${shutDown.from}…${shutDown.to}`
  );
}
// ⚠️ A derate too small to matter must still draw, and this is the case that used not
// to. A 7%-of-a-half minimum swallowed every drive ceiling in (120.9, 130] kW — up to
// 9.1 kW of real derate rendered pixel-identically to a healthy pack, for 10.4% of
// moving time against the 6.2% where a blank end is honest. Absence means exactly one
// thing now, and it means it on both halves.
for (const half of [
  { name: "drive", limits: { drive: FULL_SCALE_KW.drive - 1, regen: null }, read: (r: Reach) => r.from },
  { name: "regen", limits: { drive: null, regen: FULL_SCALE_KW.regen - 1 }, read: (r: Reach) => LENGTH - r.to },
]) {
  const tiny = reachable({ limits: half.limits, fullScale: FULL_SCALE_KW });
  if (half.read(tiny) <= 0) {
    failures.push(`1 kW off the ${half.name} ceiling is a real derate and must take a real width`);
  }
}
const noLimits = reachable({
  limits: { drive: null, regen: null },
  fullScale: FULL_SCALE_KW,
});
if (noLimits.from !== 0 || noLimits.to !== LENGTH) {
  failures.push(`a bike that has not sent 0x202 yet reaches the whole bar, got ${noLimits.from}…${noLimits.to}`);
}
const noObject = reachable({ limits: null, fullScale: FULL_SCALE_KW });
if (noObject.from !== 0 || noObject.to !== LENGTH) {
  failures.push("a bar handed no limits at all must draw its whole scale as reachable");
}

// 5. A charge is up. Both ceilings must go quiet: the BMS zeroes them during a DC
//    session because neither path carries that current, so believing them would erase
//    the whole bar under a fill showing +24 kW of charge power — on a screen the rider
//    can be looking at mid-charge, and fresh enough that staleness never fires.
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
//
//    ⚠️ Both amps are chosen so BOTH ceilings stay inside BOTH scales when crossed.
//    With a drive figure larger than the regen half, crossing saturates the regen side,
//    which then takes nothing away and every side assertion still passes.
const CROSS_SAFE_DRIVE_KW = 32;
const CROSS_SAFE_REGEN_KW = 19.2;
const endToEnd = reachable({
  limits: powerLimitsKw(reading({ "allowed_discharge_a": 100, "allowed_regen_a": 60, "pack_v": 320 }), fresh),
  fullScale: FULL_SCALE_KW,
});
const wantFrom = ORIGIN - (CROSS_SAFE_DRIVE_KW / FULL_SCALE_KW.drive) * ORIGIN;
const wantTo = ORIGIN + (CROSS_SAFE_REGEN_KW / FULL_SCALE_KW.regen) * (LENGTH - ORIGIN);
if (Math.abs(endToEnd.to - wantTo) > 1e-9 || Math.abs(endToEnd.from - wantFrom) > 1e-9) {
  failures.push(
    `100 A / 60 A at 320 V is ${CROSS_SAFE_DRIVE_KW} kW of drive and ${CROSS_SAFE_REGEN_KW} of regen, so the bar ` +
      `reaches ${wantFrom}…${wantTo} — got ${endToEnd.from}…${endToEnd.to}. The two ceilings are crossed somewhere ` +
      `between the reader and the bar`
  );
}

// 7. The wall, once you are through it. Every state a screenshot can show is on the near
//    side of the ceiling, so no render argues about this one. The bar this replaces drew
//    its rule over the fill for the same reason.
// ⚠️ The ORDER, first. §7 walked ceilingMark() alone in an earlier draft, which meant
// moving the mark back under the fill left every check green and brought the bug
// straight back. barLayers() is ordered and pure precisely so this can be asserted.
const crossing = barLayers({
  value: -120,
  fullScale: FULL_SCALE_KW,
  color: FLOW,
  limits: { drive: 60, regen: 20 },
});
const fillAt = crossing.findIndex(layer => layer.name === "fill");
const markAt = crossing.findIndex(layer => layer.name === "ceiling");
if (fillAt < 0 || markAt < 0) {
  failures.push(`a fill past its ceiling draws both a fill and a ceiling mark, got ${crossing.map(l => l.name)}`);
} else if (markAt < fillAt) {
  failures.push(
    `the ceiling mark must be painted AFTER the fill or crossing the ceiling erases it — got ` +
      `${crossing.map(layer => layer.name).join(", ")}`
  );
}
// …and the fill goes over every stretch of scale, never under one.
const names = crossing.map(layer => layer.name);
if (fillAt >= 0 && (fillAt < names.lastIndexOf("track") || fillAt < names.lastIndexOf("taken"))) {
  failures.push(`the fill must be painted over the scale, not under it — got ${names.join(", ")}`);
}

const atTheWall = ceilingMark({ filled: { from: reach.from, to: ORIGIN }, reach });
if (atTheWall !== null) {
  failures.push(`a fill stopping exactly at the ceiling needs no mark — the track's own end is it — got ${atTheWall}`);
}
const throughIt = ceilingMark({ filled: { from: reach.from - 5, to: ORIGIN }, reach });
if (throughIt === null || Math.abs(throughIt - reach.from) > 1e-9) {
  failures.push(
    `a fill past the drive ceiling must still mark it, inside the reachable stretch so the mark lands on the fill ` +
      `— got ${throughIt} for a ceiling at ${reach.to}`
  );
}
const throughRegen = ceilingMark({ filled: { from: ORIGIN, to: reach.to + 5 }, reach });
if (throughRegen === null || throughRegen <= ORIGIN || throughRegen > reach.to) {
  failures.push(`the same on the regen side: expected a mark inside ${ORIGIN}…${reach.to}, got ${throughRegen}`);
}
// ⚠️ A ceiling under one viewBox unit — 1.66 kW on this scale, which includes the 0 A
// derate power-limits.js calls the most important thing this bar can say. An unclamped
// mark lands on the far side of the origin here, on the other half's track.
for (const ceiling of [0, 1, 1.65]) {
  const tight = reachable({ limits: { drive: ceiling, regen: 0 }, fullScale: FULL_SCALE_KW });
  const filled = { from: ORIGIN - 10, to: ORIGIN };
  const mark = ceilingMark({ filled, reach: tight });
  if (mark === null || mark < filled.from || mark + CEILING_TICK > ORIGIN) {
    failures.push(
      `a ${ceiling} kW drive ceiling must still mark the wall, inside the fill and above the origin ` +
        `(${ORIGIN.toFixed(2)}) — got ${mark}`
    );
  }
  const regenTight = reachable({ limits: { drive: 0, regen: ceiling }, fullScale: FULL_SCALE_KW });
  const regenFilled = { from: ORIGIN, to: ORIGIN + 10 };
  const regenMark = ceilingMark({ filled: regenFilled, reach: regenTight });
  if (regenMark === null || regenMark < ORIGIN || regenMark + CEILING_TICK > regenFilled.to) {
    failures.push(
      `a ${ceiling} kW regen ceiling must mark the wall inside the fill and below the origin — got ${regenMark}`
    );
  }
}

const wellInside = ceilingMark({ filled: { from: ORIGIN - 3, to: ORIGIN }, reach });
if (wellInside !== null) {
  failures.push(`a fill nowhere near the ceiling must not mark it, got ${wellInside}`);
}

// 8. Which way each direction GROWS, which §1-§7 left unpinned.
//
//    ⚠️ §3 pins where the origin sits and which end each CEILING shortens. Neither touches
//    the fill, so `isDrive = (value ?? 0) < 0` could be flipped to `> 0` — one character —
//    with every check here still green while a 120 kW pull drew downward into the regen
//    half. That is this file's own headline failure, a screen that looks entirely
//    deliberate, one layer below the colour it was written to catch. Asserted against the
//    same literals §1 uses rather than anything imported from the module under test.
for (const side of [
  { name: "drive", kilowatts: DRIVE_KW, grows: "up" },
  { name: "regen", kilowatts: REGEN_KW, grows: "down" },
]) {
  const layers = barLayers({ value: side.kilowatts, fullScale: FULL_SCALE_KW, color: FLOW, limits: null });
  const fill = layers.find(layer => layer.name === "fill");
  if (!fill || fill.to - fill.from <= 0) {
    failures.push(`${side.kilowatts} kW must draw a fill, got ${fill ? "an empty one" : "none"}`);
    continue;
  }
  const wrongWay = side.grows === "up" ? fill.to > ORIGIN + 1e-9 : fill.from < ORIGIN - 1e-9;
  if (wrongWay) {
    failures.push(
      `${side.kilowatts} kW is ${side.name} and must grow ${side.grows} from the origin (${ORIGIN.toFixed(2)}), ` +
        `got a fill spanning ${fill.from.toFixed(2)}…${fill.to.toFixed(2)} — the sign convention is inverted`
    );
  }
}

//    …and the clamp, so power past full scale fills its half rather than running off the
//    end of the viewBox, where it would be clipped and so invisible.
for (const kilowatts of [DRIVE_KW * 10, REGEN_KW * 10]) {
  const layers = barLayers({ value: kilowatts, fullScale: FULL_SCALE_KW, color: FLOW, limits: null });
  const spilt = layers.filter(layer => layer.from < -1e-9 || layer.to > LENGTH + 1e-9);
  if (spilt.length > 0) {
    failures.push(
      `${kilowatts} kW is past full scale and must clamp to its half, got ` +
        spilt.map(layer => `${layer.name} ${layer.from.toFixed(1)}…${layer.to.toFixed(1)}`).join(", ")
    );
  }
}

console.log(
  `colour: ${REGEN_KW} kW regen is ${power(REGEN_KW)}, ${DRIVE_KW} kW drive is ${power(DRIVE_KW)}; ` +
    palettes
      .map(([name, palette]) => {
        return (
          `${name} fill-over-track ${contrast(resolve(palette, power(DRIVE_KW)), resolve(palette, TRACK)).toFixed(1)}:1, ` +
          `drive-vs-regen ${separation(resolve(palette, power(DRIVE_KW)), resolve(palette, power(REGEN_KW))).toFixed(0)} in a*b*`
        );
      })
      .join("; ")
);
console.log(`limits: 300 A / 120 A at 320 V is ${nominal.drive} kW drive and ${nominal.regen} kW regen`);
console.log(
  `geometry: origin ${ORIGIN.toFixed(3)} down a ${LENGTH}-unit strip, ${kwPerUnit.drive.toFixed(4)} kW per unit ` +
    `above it and below it`
);
console.log(`end to end: 100 A / 60 A at 320 V reaches ${endToEnd.from.toFixed(1)}…${endToEnd.to.toFixed(1)}`);

if (failures.length > 0) {
  console.error("FAILED:");
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  process.exit(1);
}
console.log(
  "✓ regen is green and drive is its own colour at every load, both fills clear their floors over the track and " +
    "stay a long way apart in hue over both palettes, both ceilings convert through the measured pack voltage with 0 A surviving " +
    "and 0 V rejected, both go quiet while a charge is up, each ceiling shortens its own side's far end — end to " +
    "end — the wall stays marked once you are through it, and each direction grows its own way out of " +
    "the origin"
);

type Reach = { from: number; to: number };
