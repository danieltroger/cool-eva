import { readFile } from "fs/promises";
import { power } from "../public/lib/colors.js";
import { FLOW, GOOD, MUTED } from "../public/lib/colors.js";
import { TRACK, barLayers, ceilingMark, originY, reachable } from "../public/lib/power-bar.js";
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
 * ride.js's POWER_SCALE_KW. Copied, not imported: ride.js pulls in van, which needs a
 * DOM. Asymmetric on purpose — the regen half is a third the size of the drive half,
 * because that is the shape of the machine.
 */
const FULL_SCALE_KW = { drive: 130, regen: 36 };
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
if (power(DRIVE_KW) === GOOD) {
  failures.push(
    `${DRIVE_KW} kW is a hard PULL (pack_kw is negative under discharge) and must not be the green ${GOOD} — ` +
      `that is the inversion that shipped for five weeks`
  );
}
if (power(null) !== MUTED) {
  failures.push(`no reading must be ${MUTED}, got ${power(null)}`);
}
// Drive is one colour at every load — the ramp by magnitude is gone. A drive reading that
// comes back anything but FLOW is either the ramp returning or the sign convention
// inverted again, and both are silent on screen.
for (const kilowatts of [-0.4, -1, -5, -20, -60, -120]) {
  if (power(kilowatts) !== FLOW) {
    failures.push(`${kilowatts} kW is drive and must read ${FLOW} at any load, got ${power(kilowatts)}`);
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
// docs/dashboard-decisions.md §"The power bar" has both failures in full.
const MIN_FILL_CONTRAST = 4;
/**
 * ⚠️ A RATCHET, not a measurement, and the same shape as SEPARATION_FLOOR in
 * check-theme-contrast.ts. Nothing derives 2: it sits just under the shipped worst case,
 * the ceiling mark over the light theme's regen fill at 2.2, so that cannot be
 * compressed further without someone deciding to. If a future palette needs to go under
 * it, move it deliberately and say why in docs/dashboard-decisions.md rather than
 * nudging it. MIN_FILL_CONTRAST has real headroom by comparison; its worst is 4.3.
 */
const MIN_MARK_CONTRAST = 2;
/**
 * ⚠️ A RATCHET too, and the reason is the meter's shape: drive grows up out of the origin
 * and regen grows down, so with the strip mostly empty the ONLY thing saying which of the
 * two is happening is the fill's colour. Nothing derives 40; it sits under the shipped
 * 47.6 (dark) and 44.1 (light). Same measure as check-theme-contrast.ts's ramp: the a*b*
 * plane only, because a blue and a green that differ by lightness alone still read as one
 * colour through glare.
 */
const MIN_FLOW_SEPARATION = 40;
const palettes = await readPalettes();
for (const [themeName, palette] of palettes) {
  const resolve = (token: string) => palette[token.replace(/^var\(--|\)$/g, "")];
  const track = resolve(TRACK);
  const fills = [
    { what: `the drive fill (${DRIVE_KW} kW)`, hex: resolve(power(DRIVE_KW)) },
    { what: `the regen fill (${REGEN_KW} kW)`, hex: resolve(power(REGEN_KW)) },
  ];
  for (const fill of fills) {
    // ⚠️ The FILL edge is the primary reading and is held highest: a draft that
    // strengthened the derate edge instead cost the fill 17.9:1 → 2.5:1.
    // docs/dashboard-decisions.md §"The power bar" has that failure in full.
    const ratio = contrast(fill.hex, track);
    if (ratio < MIN_FILL_CONTRAST) {
      failures.push(
        `${themeName}: ${fill.what} ${fill.hex} over the track ${track} is ${ratio.toFixed(2)}:1, under the ` +
          `${MIN_FILL_CONTRAST}:1 floor — that edge is where the rider reads how hard they are pulling`
      );
    }
    // The ceiling mark is the track's own grey drawn ON the fill, which is the only place
    // it has to survive: the strip is two colours and one texture, nothing more.
    if (contrast(track, fill.hex) < MIN_MARK_CONTRAST) {
      failures.push(
        `${themeName}: the ceiling mark ${track} over ${fill.what} is ` +
          `${contrast(track, fill.hex).toFixed(2)}:1, under ${MIN_MARK_CONTRAST}:1 — a rider past the ceiling ` +
          `could not see that they were`
      );
    }
  }
  // ⚠️ …and the two fills must never be mistaken for each other. Direction is the whole
  // reading on a meter that grows both ways out of one point, and a blue and a green that
  // differ only in hue are a pair a rider in glare cannot separate.
  const drive = resolve(power(DRIVE_KW));
  const regen = resolve(power(REGEN_KW));
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
const reach = reachable({ limits: { drive: 96, regen: 27 }, fullScale: FULL_SCALE_KW, origin: ORIGIN });
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
// ⚠️ Deliberately NOT a ceiling that is half its scale. It was 22.5 of 45, and half is
// the one ratio where measuring the REACHABLE part and the LOST part give the same
// answer — so the assertion held under that mutation and only the drive half was really
// carrying it. 27 of 36 is three quarters; 96 of 130 is not.
if (Math.abs((ORIGIN - reach.from) / ORIGIN - 96 / FULL_SCALE_KW.drive) > 1e-9) {
  failures.push("each half must be measured against its OWN scale, not against a shared one");
}

// 4. The two ends, which used to be special cases. A ceiling past full scale had to be
//    dropped (indistinguishable from "0x202 has not arrived") or pinned (from a ceiling
//    AT full scale); a ceiling of zero sat on the old centre divider. Neither survives.
const roomToSpare = reachable({
  limits: { drive: 400, regen: null },
  fullScale: FULL_SCALE_KW,
  origin: ORIGIN,
});
if (roomToSpare.to !== LENGTH || roomToSpare.from !== 0) {
  failures.push(`a ceiling past full scale takes nothing away, got ${roomToSpare.from}…${roomToSpare.to}`);
}
const exactlyFull = reachable({
  limits: { drive: FULL_SCALE_KW.drive, regen: FULL_SCALE_KW.regen },
  fullScale: FULL_SCALE_KW,
  origin: ORIGIN,
});
if (Math.abs(exactlyFull.to - LENGTH) > 1e-9 || Math.abs(exactlyFull.from) > 1e-9) {
  failures.push(`a ceiling AT full scale takes nothing away either, got ${exactlyFull.from}…${exactlyFull.to}`);
}
const shutDown = reachable({
  limits: { drive: 0, regen: 0 },
  fullScale: FULL_SCALE_KW,
  origin: ORIGIN,
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
  const tiny = reachable({ limits: half.limits, fullScale: FULL_SCALE_KW, origin: ORIGIN });
  if (half.read(tiny) <= 0) {
    failures.push(`1 kW off the ${half.name} ceiling is a real derate and must take a real width`);
  }
}
const noLimits = reachable({
  limits: { drive: null, regen: null },
  fullScale: FULL_SCALE_KW,
  origin: ORIGIN,
});
if (noLimits.from !== 0 || noLimits.to !== LENGTH) {
  failures.push(`a bike that has not sent 0x202 yet reaches the whole bar, got ${noLimits.from}…${noLimits.to}`);
}
const noObject = reachable({ limits: null, fullScale: FULL_SCALE_KW, origin: ORIGIN });
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
  origin: ORIGIN,
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
  const tight = reachable({ limits: { drive: ceiling, regen: 0 }, fullScale: FULL_SCALE_KW, origin: ORIGIN });
  const filled = { from: ORIGIN - 10, to: ORIGIN };
  const mark = ceilingMark({ filled, reach: tight });
  if (mark === null || mark < filled.from || mark + 2 > ORIGIN) {
    failures.push(
      `a ${ceiling} kW drive ceiling must still mark the wall, inside the fill and above the origin ` +
        `(${ORIGIN.toFixed(2)}) — got ${mark}`
    );
  }
  const regenTight = reachable({ limits: { drive: 0, regen: ceiling }, fullScale: FULL_SCALE_KW, origin: ORIGIN });
  const regenFilled = { from: ORIGIN, to: ORIGIN + 10 };
  const regenMark = ceilingMark({ filled: regenFilled, reach: regenTight });
  if (regenMark === null || regenMark < ORIGIN || regenMark + 2 > regenFilled.to) {
    failures.push(
      `a ${ceiling} kW regen ceiling must mark the wall inside the fill and below the origin — got ${regenMark}`
    );
  }
}

const wellInside = ceilingMark({ filled: { from: ORIGIN - 3, to: ORIGIN }, reach });
if (wellInside !== null) {
  failures.push(`a fill nowhere near the ceiling must not mark it, got ${wellInside}`);
}

console.log(
  `colour: ${REGEN_KW} kW regen is ${power(REGEN_KW)}, ${DRIVE_KW} kW drive is ${power(DRIVE_KW)}; ` +
    palettes
      .map(([name, palette]) => {
        const resolve = (token: string) => palette[token.replace(/^var\(--|\)$/g, "")];
        return (
          `${name} fill-over-track ${contrast(resolve(power(DRIVE_KW)), resolve(TRACK)).toFixed(1)}:1, ` +
          `drive-vs-regen ${separation(resolve(power(DRIVE_KW)), resolve(power(REGEN_KW))).toFixed(0)} in a*b*`
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
    "end — and the wall stays marked once you are through it"
);

type Reach = { from: number; to: number };

/**
 * Both palettes out of style.css, so the `var(--token)` strings colors.js and svg.js
 * draw with can be measured. Same shape as scripts/check-theme-contrast.ts, and for the
 * same reason: a check carrying its own copy of the palette passes while the shipped
 * colours are wrong.
 */
async function readPalettes(): Promise<Array<[string, Record<string, string>]>> {
  const css = await readFile(new URL("../public/style.css", import.meta.url), "utf8");
  const read = (opener: string) => {
    const start = css.indexOf(opener);
    if (start === -1) {
      throw new Error(`style.css has no "${opener}" block — has the palette moved?`);
    }
    const block = css.slice(start + opener.length, css.indexOf("}", start));
    const palette: Record<string, string> = {};
    for (const [, name, value] of block.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
      palette[name] = value;
    }
    return palette;
  };
  return [
    ["dark", read(":root {")],
    ["light", read(':root[data-theme="light"] {')],
  ];
}

/**
 * Distance in the a*b* plane, lightness deliberately excluded — the same measure and the
 * same reason as check-theme-contrast.ts: two marks that differ only in how dark they are
 * do not read as different colours in glare.
 */
function separation(first: string, second: string): number {
  const lab = (hex: string): [number, number] => {
    const [red, green, blue] = [1, 3, 5].map(offset => {
      const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
      return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    const x = (0.4124 * red + 0.3576 * green + 0.1805 * blue) / 0.95047;
    const y = luminance(hex);
    const z = (0.0193 * red + 0.1192 * green + 0.9505 * blue) / 1.08883;
    const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    return [500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
  };
  const [aFirst, bFirst] = lab(first);
  const [aSecond, bSecond] = lab(second);
  return Math.hypot(aFirst - aSecond, bFirst - bSecond);
}

/** WCAG relative luminance of an `#rrggbb` string. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map(value => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

/**
 * Contrast between two `#rrggbb` strings. Restated here rather than imported because
 * nothing in the app computes it — style.css states its ratios as measured constants in
 * prose, and a check taking its numbers from the thing it checks would assert nothing.
 */
function contrast(first: string, second: string): number {
  const [high, low] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (high + 0.05) / (low + 0.05);
}
