import { DASH_DUTY } from "../public/lib/power-bar.js";
import { contrast, luminance, parsePalette, separation } from "./palette.ts";

// Measures both palettes in public/style.css against the floors that file commits to,
// so "if you darken any of these, measure it first" is enforced rather than hoped for.
//
//   node --experimental-strip-types scripts/check-theme-contrast.ts
//
// The tokens are PARSED OUT OF style.css rather than restated here. A check with its
// own copy of the palette passes while the shipped colours are wrong, which is the one
// failure mode that would make this worse than nothing.
//
// Two properties are checked, because the light theme trades one against the other and
// the trade is the whole design decision (docs/dashboard-decisions.md):
//
//   • CONTRAST — every ink against the ground it is actually drawn on.
//   • SEPARATION — how far apart the four status inks are in the a*b* plane. Darkening
//     yellow and orange far enough to clear 6:1 on a light ground walks them towards
//     the same brown, and a ramp whose steps cannot be told apart carries no state.

/** Every ink colors.js exports or draws with, and the ground each one lands on. */
const INK_TOKENS = ["fg", "label", "sub", "good", "watch", "warn", "bad", "cold", "cool", "flow"];

/** Marks sized by visibility rather than readability — see the note in lib/power-bar.js. */
const MARK_TOKENS = ["track"];

/**
 * …and what --track has to clear against the tile it is drawn on.
 *
 * ⚠️ MARK_TOKENS has been in this file since the palette moved to tokens and, until now,
 * only ever appeared in the completeness filter — it named the marks and measured none of
 * them. So nothing in the repo held the power meter against the card it sits on, and a
 * palette walking --track towards --tile passed every check while making the meter
 * invisible: exactly the failure style.css warns about in words at the --track note.
 *
 * A RATCHET, not a measurement, in the same shape as SEPARATION_FLOOR below. Nothing
 * derives 1.5; it sits just under the shipped 1.53 and 1.66. ⚠️ It was 1.25 in a draft,
 * quoting the values from BEFORE this palette moved — which left it permitting 1.254, i.e.
 * a regression past the 1.3:1 the --track note calls the defect it was fixing. A ratchet
 * seated under the wrong number is a ratchet that does not hold.
 */
const MARK_FLOORS: Record<string, number> = { "track": 1.5 };

/**
 * …and the two the DASHED stretch has to clear, which are not the same question.
 *
 * ⚠️ The meter has no second colour for a derate: the taken stretch is --track itself,
 * dashed, with the tile showing through the gaps. So there is no dash-ink-against-track
 * ratio to measure — the dash and the track are one colour — and what a rider actually
 * sees over a dashed run is the two averaged by the dash's duty cycle. Both numbers below
 * are that average: against the ground the meter sits on, which is how visible a derate
 * is at all, and against the solid track, which is what says the stretch is gone.
 *
 * RATCHETS under the shipped worst cases, both of which are the light theme: 1.290 and
 * 1.285. They are small numbers and that is the honest picture — this design carries the
 * derate as a texture rather than as a step in tone, which is a trade
 * docs/dashboard-decisions.md §"The power meter" states in full.
 */
const DASHED_ON_GROUND_FLOOR = 1.25;
const DASHED_VS_SOLID_FLOOR = 1.15;

/**
 * ⚠️ --flow against EVERY other ink, not against one named partner.
 *
 * It is the only ink outside the four-step ramp below, so nothing was holding it apart
 * from anything. A draft guarded it against --cold alone — and this palette has three
 * blues: --flow at #5ccfd6 clears --cold by 29.6 and lands 5.7 from --cool, the 5-20 °C
 * band, with every check green. Naming one partner guards one pair; the failure is that a
 * fill and a temperature read as the same colour, and any ink can be that partner.
 *
 * A ratchet under the shipped worst case, --cold at 17.1 on dark.
 */
const FLOW_SEPARATION_FLOOR = 15;

/**
 * The floors style.css declares. Values clear 11:1 and everything else 6:1; the dark
 * theme's own --bad is 5.29:1 on a tile, which is why `.raw` puts it on the sheet
 * rather than a tile and why that one is listed as a known exemption rather than
 * quietly rounded up.
 */
const VALUE_FLOOR = 11;
const TEXT_FLOOR = 6;
/**
 * ⚠️ A RATCHET, not a measurement. Nothing derives 15; it sits just under the light
 * theme's worst adjacent pair (warn→bad, 16.0) so that ramp cannot be compressed
 * further without someone deciding to. The dark theme's worst is 38.7, so this floor
 * only ever binds on light. If a future palette needs to go under it, move it
 * deliberately and say why in docs/dashboard-decisions.md rather than nudging it.
 */
const SEPARATION_FLOOR = 15;
const EXEMPT = new Set(["dark:bad on tile"]);

const RAMP = ["good", "watch", "warn", "bad"];

const source = await (
  await import("node:fs/promises")
).readFile(new URL("../public/style.css", import.meta.url), "utf8");
const dark = parsePalette(source, ":root {");
const light = parsePalette(source, ':root[data-theme="light"] {');

const palettes = [
  ["dark", dark],
  ["light", light],
] as const;

// Completeness first, for BOTH palettes, and nothing else runs until it holds.
//
// ⚠️ This used to be interleaved with the measuring below, guarded by the shared
// `failures` list, and it was wrong twice over: a failure in the DARK palette skipped
// every LIGHT check — so light values were printed in the table and silently not
// asserted — and a missing token still reached the printing pass, where it read
// `undefined` into luminance() and threw over the diagnostic that had just been
// composed. Both found in review by breaking one token in each palette at once.
const incomplete = palettes.flatMap(([themeName, palette]) =>
  [...INK_TOKENS, ...MARK_TOKENS]
    .filter(token => !palette[token])
    .map(
      token =>
        `${themeName} palette has no --${token}, or it is not a plain hex value; colors.js or svg.js draws with it`
    )
);
if (incomplete.length > 0) {
  console.error(`\n✗ ${incomplete.length} missing token(s) — an incomplete palette cannot be measured:`);
  for (const problem of incomplete) {
    console.error(`  - ${problem}`);
  }
  process.exit(1);
}

/**
 * Two colours averaged in LINEAR light by a coverage fraction — what a dashed run of one
 * over the other averages to at a glance. Linear rather than sRGB because that is what the
 * eye integrates and what luminance() already works in.
 */
function mix(ink: string, ground: string, coverage: number): string {
  const blended = coverage * luminance(ink) + (1 - coverage) * luminance(ground);
  // Back to a channel value so contrast() can take it: the inverse of the sRGB transfer
  // curve, applied to the grey of that luminance.
  const channel = blended <= 0.0031308 ? blended * 12.92 : 1.055 * blended ** (1 / 2.4) - 0.055;
  const byte = Math.round(Math.max(0, Math.min(1, channel)) * 255)
    .toString(16)
    .padStart(2, "0");
  return `#${byte}${byte}${byte}`;
}

/** The ink --flow sits closest to in the a*b* plane, named — the pair a ratchet protects. */
function nearestToFlow(palette: Record<string, string>): string {
  const [closest] = INK_TOKENS.filter(token => token !== "flow")
    .map(token => ({ token, apart: separation(palette["flow"], palette[token]) }))
    .sort((first, second) => first.apart - second.apart);
  return `${closest.token} ${closest.apart.toFixed(1)}`;
}

const failures: string[] = [];
for (const [themeName, palette] of palettes) {
  for (const ground of ["bg", "tile"] as const) {
    for (const token of INK_TOKENS) {
      const measured = contrast(palette[token], palette[ground]);
      const floor = token === "fg" ? VALUE_FLOOR : TEXT_FLOOR;
      const label = `${themeName}:${token} on ${ground}`;
      if (measured < floor && !EXEMPT.has(label)) {
        failures.push(`${label} measures ${measured.toFixed(2)}:1, under the ${floor}:1 floor style.css declares`);
      }
    }
  }
  for (const token of MARK_TOKENS) {
    const measured = contrast(palette[token], palette["tile"]);
    if (measured < MARK_FLOORS[token]) {
      failures.push(
        `${themeName}:${token} is ${measured.toFixed(2)}:1 against the tile it is drawn on, under ` +
          `${MARK_FLOORS[token]}:1 — the meter would disappear into the card`
      );
    }
  }
  // The dashed stretch, duty-weighted — see DASHED_ON_GROUND_FLOOR.
  const dashed = mix(palette["track"], palette["tile"], DASH_DUTY);
  for (const against of [
    { what: "the tile it is drawn on", hex: palette["tile"], floor: DASHED_ON_GROUND_FLOOR },
    { what: "the solid track beside it", hex: palette["track"], floor: DASHED_VS_SOLID_FLOOR },
  ]) {
    const measured = contrast(dashed, against.hex);
    if (measured < against.floor) {
      failures.push(
        `${themeName}: a dashed stretch averages ${measured.toFixed(3)}:1 against ${against.what}, under ` +
          `${against.floor}:1 — a derate would not read`
      );
    }
  }
  for (const token of INK_TOKENS) {
    if (token === "flow") {
      continue;
    }
    const apart = separation(palette["flow"], palette[token]);
    if (apart < FLOW_SEPARATION_FLOOR) {
      failures.push(
        `${themeName}: --flow and --${token} are ${apart.toFixed(1)} apart in a*b*, under ` +
          `${FLOW_SEPARATION_FLOOR} — the power meter's fill and a reading would be the same colour`
      );
    }
  }
  for (let step = 0; step < RAMP.length - 1; step++) {
    const [from, to] = [RAMP[step], RAMP[step + 1]];
    const apart = separation(palette[from], palette[to]);
    if (apart < SEPARATION_FLOOR) {
      failures.push(
        `${themeName}: --${from} and --${to} are ${apart.toFixed(1)} apart in a*b*, under ${SEPARATION_FLOOR} — ` +
          `two ramp steps that read as the same colour carry no state`
      );
    }
  }
}

for (const [themeName, palette] of palettes) {
  console.log(`\n${themeName}`);
  for (const ground of ["bg", "tile"] as const) {
    const row = INK_TOKENS.map(token => `${token} ${contrast(palette[token], palette[ground]).toFixed(1)}`).join("  ");
    console.log(`  on --${ground.padEnd(4)} ${row}`);
  }
  console.log(
    `  marks on --tile   ` +
      MARK_TOKENS.map(token => `${token} ${contrast(palette[token], palette["tile"]).toFixed(2)}`).join("  ") +
      `  dashed ${contrast(mix(palette["track"], palette["tile"], DASH_DUTY), palette["tile"]).toFixed(3)} on tile` +
      ` / ${contrast(mix(palette["track"], palette["tile"], DASH_DUTY), palette["track"]).toFixed(3)} vs solid` +
      `   --flow's nearest ink ${nearestToFlow(palette)}`
  );
  const steps = RAMP.slice(0, -1)
    .map(
      (token, step) => `${token}→${RAMP[step + 1]} ${separation(palette[token], palette[RAMP[step + 1]]).toFixed(1)}`
    )
    .join("   ");
  console.log(`  ramp separation  ${steps}`);
}

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} contrast problem(s):`);
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}
console.log(
  `\n✓ both palettes clear their floors — values ${VALUE_FLOOR}:1, text and status inks ${TEXT_FLOOR}:1 on ` +
    `both grounds, the meter's track and its dashed stretches visible against the card they are drawn on, ` +
    `--flow apart from every other ink, and no two ` +
    `ramp steps closer than ${SEPARATION_FLOOR} in a*b*`
);
