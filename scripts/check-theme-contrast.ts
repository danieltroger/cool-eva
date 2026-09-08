import { readFile } from "fs/promises";

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
 * derives 1.25; it sits under the shipped 1.29 and 1.48.
 */
const MARK_FLOORS: Record<string, number> = { "track": 1.25 };

/**
 * ⚠️ And the two blues, which are not in the ramp below and so were not being held apart
 * by anything. --cold is a temperature and --flow is drive power; they never sit side by
 * side, but a palette edit that walked them together would make the coldest reading on
 * the screen and a hard pull the same colour. A ratchet under the shipped 17.1 / 47.4.
 */
const BLUE_SEPARATION_FLOOR = 15;

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

const source = await readFile(new URL("../public/style.css", import.meta.url), "utf8");
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
  const blues = separation(palette["flow"], palette["cold"]);
  if (blues < BLUE_SEPARATION_FLOOR) {
    failures.push(
      `${themeName}: --flow and --cold are ${blues.toFixed(1)} apart in a*b*, under ${BLUE_SEPARATION_FLOOR} — ` +
        `drive power and a cold pack would read as the same blue`
    );
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
      `   --flow vs --cold ${separation(palette["flow"], palette["cold"]).toFixed(1)}`
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
    `both grounds, the meter's track visible against the card it is drawn on, the two blues apart, and no two ` +
    `ramp steps closer than ${SEPARATION_FLOOR} in a*b*`
);

/**
 * The custom properties declared in one `:root` block of style.css.
 *
 * Reads to the first `}` after the opening, which is what makes a block-scoped rule
 * parse correctly; the palette blocks contain no nested braces.
 */
function parsePalette(css: string, opener: string): Record<string, string> {
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
}

/** WCAG 2.x relative luminance. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map(offset => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(a: string, b: string): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((first, second) => second - first);
  return (lighter + 0.05) / (darker + 0.05);
}

/** CIELAB, D65. Only the two chroma axes are used — see separation(). */
function lab(hex: string): [number, number, number] {
  const [red, green, blue] = [1, 3, 5].map(offset => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const x = (0.4124 * red + 0.3576 * green + 0.1805 * blue) / 0.95047;
  // The same quantity contrast() measures, so it is taken from there rather than
  // written a second time — two copies of the sRGB coefficients can drift apart.
  const y = luminance(hex);
  const z = (0.0193 * red + 0.1192 * green + 0.9505 * blue) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/**
 * Distance in the a*b* plane only, with lightness deliberately excluded.
 *
 * A full ΔE would let a ramp "separate" by making one step much darker than its
 * neighbour, which reads as noise rather than as a progression — an optimiser handed
 * ΔE picks exactly that. What has to differ between WATCH and WARN is the hue.
 */
function separation(a: string, b: string): number {
  const [, aStar1, bStar1] = lab(a);
  const [, aStar2, bStar2] = lab(b);
  return Math.hypot(aStar1 - aStar2, bStar1 - bStar2);
}
