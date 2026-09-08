import { readFile } from "fs/promises";

// The colour arithmetic both palette checks run on, and the palettes themselves.
//
// Extracted because there were two copies: scripts/check-theme-contrast.ts wrote it first
// and scripts/check-power-bar.ts copied it when its own dead contrast floor was repaired —
// under a comment in the first file explaining why a check must not carry its own copy of
// the palette. The same argument applies to the arithmetic: two implementations of
// contrast() can disagree, and the one that disagrees is the one nobody runs by hand.
//
// The palettes are PARSED OUT OF public/style.css rather than restated here. A check with
// its own copy passes while the shipped colours are wrong, which is the one failure mode
// that would make either of these worse than nothing.

/** Both palettes, in the order a check should print them. */
export async function readPalettes(): Promise<Array<[string, Record<string, string>]>> {
  const css = await readFile(new URL("../public/style.css", import.meta.url), "utf8");
  return [
    ["dark", parsePalette(css, ":root {")],
    ["light", parsePalette(css, ':root[data-theme="light"] {')],
  ];
}

/**
 * The custom properties declared in one `:root` block of style.css.
 *
 * Reads to the first `}` after the opening, which is what makes a block-scoped rule parse
 * correctly; the palette blocks contain no nested braces.
 */
export function parsePalette(css: string, opener: string): Record<string, string> {
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

/** Resolves a `var(--token)` string — the form colors.js and power-bar.js draw with. */
export function resolve(palette: Record<string, string>, token: string): string {
  return palette[token.replace(/^var\(--|\)$/g, "")];
}

/** WCAG 2.x relative luminance. */
export function luminance(hex: string): number {
  const channels = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map(value => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

/** Contrast between two `#rrggbb` strings. Symmetric — the order of the arguments is free. */
export function contrast(first: string, second: string): number {
  const [high, low] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (high + 0.05) / (low + 0.05);
}

/** CIELAB, D65. Only the two chroma axes are used — see separation(). */
function lab(hex: string): [number, number] {
  const [red, green, blue] = [1, 3, 5].map(offset => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const x = (0.4124 * red + 0.3576 * green + 0.1805 * blue) / 0.95047;
  // The same quantity luminance() measures, so it is taken from there rather than
  // written a second time — two copies of the sRGB coefficients can drift apart.
  const y = luminance(hex);
  const z = (0.0193 * red + 0.1192 * green + 0.9505 * blue) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/**
 * Distance in the a*b* plane only, with lightness deliberately excluded.
 *
 * A full ΔE would let a ramp "separate" by making one step much darker than its
 * neighbour, which reads as noise rather than as a progression — an optimiser handed ΔE
 * picks exactly that. What has to differ between two marks is the hue.
 */
export function separation(first: string, second: string): number {
  const [aFirst, bFirst] = lab(first);
  const [aSecond, bSecond] = lab(second);
  return Math.hypot(aFirst - aSecond, bFirst - bSecond);
}
