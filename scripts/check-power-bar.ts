import { power } from "../public/lib/colors.js";
import { CALM, GOOD, MUTED } from "../public/lib/colors.js";
import { DERATED, TRACK, derateSpans } from "../public/lib/svg.js";
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
// `derateSpans()` decides which stretch of bar each ceiling hatches away, and
// `powerLimitsKw()` takes its reader as a parameter the way charge-mode.js does.
//
// §6 exists because covering those two ENDS is not the same as covering the path
// between them. An earlier draft asserted both and still went green with the two sides
// crossed at the call site, which draws 96 kW of regen and 38 kW of drive — a screen
// that looks entirely deliberate. The pair is one object now so the outer hop cannot be
// spelled wrong at all, and §6 walks the whole way through the remaining one. §5 is the
// charge gate.

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
// Drive is white at every load — the ramp by magnitude is gone. A drive reading that
// comes back anything but CALM is either the ramp returning or the sign convention
// inverted again, and both are silent on screen.
for (const kilowatts of [-0.4, -1, -5, -20, -60, -120]) {
  if (power(kilowatts) !== CALM) {
    failures.push(`${kilowatts} kW is drive and must read ${CALM} at any load, got ${power(kilowatts)}`);
  }
}
// …and the dashed derate rule has to stay legible over everything it is drawn on: the
// track, and BOTH fills, since it draws on top of them and the reading it carries there
// is "you are past the ceiling". Over the old BAD red it was 1.72:1, which is what
// retired the ramp. Measured from the shipped constants rather than restated, so
// retuning any of the three has to keep the set legible.
//
// ⚠️ 2.5 rather than 3, and the green regen fill is why. One grey cannot clear 3:1
// against a near-black track, a near-white fill AND a mid-luminance green at the same
// time — brightening it for the green costs the track, darkening it costs the white.
// Green is the binding case at ~2.7 and it is also the rarest, regen crossing its own
// ceiling being far less common than drive crossing its. The floor exists to catch a
// repeat of the 1.72, not to certify the palette.
const MIN_RULE_CONTRAST = 2.5;
const againstRule: Array<{ what: string; hex: string }> = [
  { what: "the track", hex: TRACK },
  { what: `the drive fill (${DRIVE_KW} kW)`, hex: power(DRIVE_KW) },
  { what: `the regen fill (${REGEN_KW} kW)`, hex: power(REGEN_KW) },
];
const ruleContrasts = againstRule.map(target => ({ ...target, ratio: contrast(DERATED, target.hex) }));
for (const target of ruleContrasts) {
  if (target.ratio < MIN_RULE_CONTRAST) {
    failures.push(
      `the derate rule ${DERATED} over ${target.what} ${target.hex} is ${target.ratio.toFixed(2)}:1, under the ` +
        `${MIN_RULE_CONTRAST}:1 floor — a rider cannot see the dashes there`
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

// 3. Which side each ceiling hatches. The bar is centre-out, drive draws RIGHT, so the
//    drive ceiling must take the right END away — from the ceiling out to full scale,
//    never the reachable part. Crossing the two sides would read as the BMS allowing
//    96 kW of regen and 38 kW of drive, which is a plausible-looking lie.
const spans = derateSpans({ limits: { drive: 96, regen: 27 }, fullScale: FULL_SCALE_KW, centre: CENTRE });
if (spans.length !== 2) {
  failures.push(`two derated ceilings hatch two stretches, got ${spans.length}`);
} else {
  const [drive, regen] = spans;
  // 96 of 130 kW leaves 34 kW unreachable, which is 34/130 of the drive half.
  const expectedDriveWidth = ((FULL_SCALE_KW.drive - 96) / FULL_SCALE_KW.drive) * CENTRE;
  if (Math.abs(drive.width - expectedDriveWidth) > 1e-9) {
    failures.push(
      `a 96 kW ceiling on a ${FULL_SCALE_KW.drive} kW half hatches ${expectedDriveWidth}, got ${drive.width}`
    );
  }
  if (Math.abs(drive.x + drive.width - 2 * CENTRE) > 1e-9) {
    failures.push(`the drive hatching must run to the bar's right end, ends at ${drive.x + drive.width}`);
  }
  if (drive.x <= CENTRE) {
    failures.push(`the drive hatching must start right of centre (${CENTRE}), starts at ${drive.x}`);
  }
  if (regen.x !== 0) {
    failures.push(`the regen hatching must start at the bar's left end, starts at ${regen.x}`);
  }
  if (regen.x + regen.width >= CENTRE) {
    failures.push(`the regen hatching must stop left of centre (${CENTRE}), ends at ${regen.x + regen.width}`);
  }
  // The reachable part is what is left, and it is the half the rider reads against.
  // …and each half is measured against ITS OWN scale. 27 of 36 kW leaves a quarter of
  // the regen side unreachable; against the drive side's 130 it would be 79% of it.
  //
  // ⚠️ Deliberately NOT a value that is half its scale. It was 22.5 of 45, and half is
  // the one ratio where hatching the REACHABLE part instead of the lost part produces
  // the same width — so this assertion held under that mutation and only the drive half
  // was really carrying it.
  const expectedRegenWidth = ((FULL_SCALE_KW.regen - 27) / FULL_SCALE_KW.regen) * CENTRE;
  if (Math.abs(regen.width - expectedRegenWidth) > 1e-9) {
    failures.push(`27 kW of a ${FULL_SCALE_KW.regen} kW regen half hatches ${expectedRegenWidth}, got ${regen.width}`);
  }
}

// 4. …and the two ends, which are the reason this hatches rather than drawing a line at
//    the ceiling. Both used to be special cases: a line past full scale had to be
//    dropped (indistinguishable from "0x202 has not arrived") or pinned (from a ceiling
//    AT full scale), and a line at zero sat on the centre divider. Neither survives here.
const roomToSpare = derateSpans({ limits: { drive: 400, regen: null }, fullScale: FULL_SCALE_KW, centre: CENTRE });
if (roomToSpare.length !== 0) {
  failures.push(`a ceiling past full scale takes nothing away and must hatch nothing, got ${roomToSpare.length}`);
}
const exactlyFull = derateSpans({
  limits: { drive: FULL_SCALE_KW.drive, regen: null },
  fullScale: FULL_SCALE_KW,
  centre: CENTRE,
});
if (exactlyFull.length !== 0) {
  failures.push(`a ceiling AT full scale takes nothing away either, got ${exactlyFull.length}`);
}
const shutDown = derateSpans({ limits: { drive: 0, regen: 0 }, fullScale: FULL_SCALE_KW, centre: CENTRE });
if (shutDown.length !== 2 || shutDown.some(span => Math.abs(span.width - CENTRE) > 1e-9)) {
  failures.push(`a 0 kW ceiling hatches its ENTIRE half — the loudest thing this bar says — got ${shutDown}`);
}
// ⚠️ A derate too small to matter must still DRAW, and this is the case that used not
// to. A 7%-of-a-half minimum swallowed every drive ceiling in (120.9, 130] kW — up to
// 9.1 kW of real derate rendered pixel-identically to a healthy pack, for 10.4% of
// moving time against the 6.2% where a blank end is honest. Absence now means exactly
// one thing, and it means it on both halves: the regen guard could not fire at all at
// the old scale, so nothing here would have noticed either.
for (const half of [
  { name: "drive", limits: { drive: FULL_SCALE_KW.drive - 1, regen: null } },
  { name: "regen", limits: { drive: null, regen: FULL_SCALE_KW.regen - 1 } },
]) {
  const tiny = derateSpans({ limits: half.limits, fullScale: FULL_SCALE_KW, centre: CENTRE });
  if (tiny.length !== 1) {
    failures.push(`1 kW off the ${half.name} ceiling is a real derate and must draw, got ${tiny.length} span(s)`);
  } else if (tiny[0].width <= 0) {
    failures.push(`the ${half.name} half drew a zero-width mark for a 1 kW derate`);
  }
}
const noLimits = derateSpans({ limits: { drive: null, regen: null }, fullScale: FULL_SCALE_KW, centre: CENTRE });
if (noLimits.length !== 0) {
  failures.push(`a bike that has not sent 0x202 yet hatches nothing, got ${noLimits.length}`);
}
if (derateSpans({ limits: null, fullScale: FULL_SCALE_KW, centre: CENTRE }).length !== 0) {
  failures.push("a bar handed no limits at all must hatch nothing");
}

// 5. A charge is up. Both ceilings must go quiet: the BMS zeroes them during a DC
//    session because neither path carries that current, so believing them would hatch
//    the WHOLE bar away under a fill showing +24 kW of charge power — on a screen the
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
//
//    ⚠️ Both amps are chosen so that BOTH ceilings stay inside BOTH scales when crossed.
//    With a drive figure larger than the regen half, crossing saturates the regen side,
//    which then hatches nothing and the check fails on the span COUNT — leaving every
//    side and width assertion still passing and the real cover much thinner than this
//    header claims. 100 A and 60 A at 320 V are 32 and 19.2 kW, and 32 < 36.
const CROSS_SAFE_DRIVE_KW = 32;
const CROSS_SAFE_REGEN_KW = 19.2;
const endToEnd = derateSpans({
  limits: powerLimitsKw(reading({ "allowed_discharge_a": 100, "allowed_regen_a": 60, "pack_v": 320 }), fresh),
  fullScale: FULL_SCALE_KW,
  centre: CENTRE,
});
if (endToEnd.length !== 2) {
  failures.push(`a riding bike with both ceilings inside the bar hatches two stretches, got ${endToEnd.length}`);
} else {
  const expected = [
    { name: "drive", width: ((FULL_SCALE_KW.drive - CROSS_SAFE_DRIVE_KW) / FULL_SCALE_KW.drive) * CENTRE, x: null },
    { name: "regen", width: ((FULL_SCALE_KW.regen - CROSS_SAFE_REGEN_KW) / FULL_SCALE_KW.regen) * CENTRE, x: 0 },
  ];
  for (const [index, want] of expected.entries()) {
    const got = endToEnd[index];
    if (Math.abs(got.width - want.width) > 1e-9) {
      failures.push(
        `${want.name}: 100 A / 60 A at 320 V is ${CROSS_SAFE_DRIVE_KW} kW of drive and ${CROSS_SAFE_REGEN_KW} of ` +
          `regen, so the ${want.name} half loses ${want.width} — got ${got.width}. The two ceilings are crossed ` +
          `somewhere between the reader and the bar`
      );
    }
    if (want.x !== null && got.x !== want.x) {
      failures.push(`the ${want.name} hatching must start at x=${want.x}, got ${got.x}`);
    }
  }
  if (endToEnd[0].x <= CENTRE) {
    failures.push(`the drive hatching must start right of centre (${CENTRE}), got ${endToEnd[0].x}`);
  }
}

console.log(
  `colour: ${REGEN_KW} kW regen is ${power(REGEN_KW)}, ${DRIVE_KW} kW drive is ${power(DRIVE_KW)}; rule over ` +
    `${ruleContrasts.map(target => target.ratio.toFixed(2)).join(", ")}:1`
);
console.log(`limits: 300 A / 120 A at 320 V is ${nominal.drive} kW drive and ${nominal.regen} kW regen`);
console.log(
  `hatching: ${spans.map(s => `${s.x.toFixed(1)}+${s.width.toFixed(1)}`).join(", ")} on ${FULL_SCALE_KW.drive}/${FULL_SCALE_KW.regen} kW halves`
);
console.log(`end to end: 100 A / 60 A at 320 V hatches ${endToEnd.map(s => s.width.toFixed(1)).join(" and ")} wide`);

if (failures.length > 0) {
  console.error("FAILED:");
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  process.exit(1);
}
console.log(
  "✓ regen is green and drive is white at every load, with the derate rule legible over it, both ceilings convert " +
    "through the measured pack voltage with 0 A surviving and 0 V rejected, both go quiet while a charge is up, " +
    "and each ceiling hatches away its own side's far end — end to end, nothing at full scale and the whole half " +
    "at zero"
);

/**
 * WCAG relative-luminance contrast between two `#rrggbb` strings. Restated here rather
 * than imported because nothing in the app computes it — style.css states its ratios as
 * measured constants in prose, and a check that took its numbers from the thing it is
 * checking would assert nothing.
 */
function contrast(first: string, second: string): number {
  const luminance = (hex: string) => {
    const channels = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255);
    const linear = channels.map(value => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  };
  const [high, low] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (high + 0.05) / (low + 0.05);
}
