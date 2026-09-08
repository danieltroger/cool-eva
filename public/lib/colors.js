// @ts-check

// Colour carries the state so the number doesn't have to be read.
//
// Deliberately few steps, and the same ramp everywhere: calm blue-green when
// there's nothing to think about, amber when it's worth a look, red when it isn't.
// A dashboard that is mostly grey-green at a glance means "fine" without being
// read at all, which is the only thing that works at speed.

/* Tokens rather than hex, so the light theme restates the ramp in one place and the
   flip repaints from the CSS engine with no JS re-run — which matters because half of
   these are read once, when an element is CREATED (svg.js), and a binding that never
   re-runs would otherwise keep its old ink for as long as the element lives.
   The values, and the contrast ratio behind each, are in style.css's palette blocks. */
export const CALM = "var(--fg)";
/* Drive on the power meter, and the kW figure beside it. Its own token because the
   meter's fill used to be CALM — the same ink as the numerals next to it — so the two
   loudest things on the hero were drawn in one colour. Regen stays GOOD: one green on
   this dashboard, not two. */
export const FLOW = "var(--flow)";
export const GOOD = "var(--good)";
export const WATCH = "var(--watch)";
export const WARN = "var(--warn)";
export const BAD = "var(--bad)";
export const COLD = "var(--cold)";
/* 6.1:1 against the tiles dark, 6.9:1 light — matches --sub in both. Anything dimmer
   is unreadable in daylight; see the palette note in style.css before changing it. */
export const MUTED = "var(--sub)";

/**
 * @param {number | null} celsius
 * @returns {string}
 */
export function temperature(celsius) {
  if (celsius == null) {
    return MUTED;
  }
  if (celsius < 5) {
    return COLD;
  }
  if (celsius < 20) {
    return "var(--cool)";
  }
  if (celsius < 35) {
    return GOOD;
  }
  if (celsius < 45) {
    return WATCH;
  }
  if (celsius < 55) {
    return WARN;
  }
  return BAD;
}

/**
 * Cell spread. Tens of millivolts is a healthy pack; past ~50 mV one cell is
 * dragging the usable capacity of the whole thing down with it.
 * @param {number | null} millivolts
 */
export function spread(millivolts) {
  if (millivolts == null) {
    return MUTED;
  }
  if (millivolts < 15) {
    return GOOD;
  }
  if (millivolts < 30) {
    return WATCH;
  }
  if (millivolts < 50) {
    return WARN;
  }
  return BAD;
}

/**
 * Headroom of the weakest cell above the configured cut-off, in mV.
 * The BMS cuts on one cell, so this — not SOC — is what ends a ride.
 * @param {number | null} millivolts
 */
export function headroom(millivolts) {
  if (millivolts == null) {
    return MUTED;
  }
  if (millivolts > 300) {
    return GOOD;
  }
  if (millivolts > 150) {
    return WATCH;
  }
  if (millivolts > 50) {
    return WARN;
  }
  return BAD;
}

/**
 * @param {number | null} percent
 */
export function stateOfCharge(percent) {
  if (percent == null) {
    return MUTED;
  }
  if (percent < 10) {
    return BAD;
  }
  if (percent < 20) {
    return WARN;
  }
  if (percent < 35) {
    return WATCH;
  }
  return GOOD;
}

/**
 * How much of the pack's output is being burned as heat in its own resistance.
 * Scales with current squared, so this climbs fast and is the most direct signal
 * that you are riding expensively.
 * @param {number | null} percent
 */
export function lossFraction(percent) {
  if (percent == null) {
    return MUTED;
  }
  if (percent < 2) {
    return GOOD;
  }
  if (percent < 5) {
    return WATCH;
  }
  if (percent < 10) {
    return WARN;
  }
  return BAD;
}

/**
 * Power flow: regen green because energy is coming back, drive its own blue at any load.
 *
 * ⚠️ `pack_kw` is NEGATIVE under discharge and POSITIVE on regen and charge — the
 * convention derive.js asserts by name rather than leaving in a minus sign. The
 * comparison here was `< -0.5` from 2026-08-03 (#33) until 2026-09-08, which is the
 * same test with the bike's sign convention read backwards: it painted a 100 kW pull
 * green and a 20 kW recovery amber. Nothing catches that by looking — both colours are
 * plausible on their own. scripts/check-power-bar.ts §1 asserts the direction.
 *
 * Drive used to ramp CALM → WATCH → WARN → BAD by magnitude, and that ramp is gone
 * rather than retuned. Two reasons, and the second is the real one:
 *
 *   • Contrast. The meter marks the BMS's ceiling ON TOP of the fill, and over the old
 *     BAD red that mark sat at 1.72:1 — the one state where crossing into unreachable
 *     power matters most. One flat colour per direction needs no second colour to be
 *     legible against, and scripts/check-power-bar.ts holds both to a floor.
 *   • The ramp answered a worse question. Its thresholds were absolute — 3, 15, 40 kW —
 *     while the hatching beside it answers "how close am I to what the pack will
 *     actually give me", which moves with heat, cold and SOC and is the number a rider
 *     can act on. Two colour languages for load, one of them fixed and wrong most of
 *     the time, is worse than one.
 * @param {number | null} kilowatts
 */
export function power(kilowatts) {
  if (kilowatts == null) {
    return MUTED;
  }
  return kilowatts > 0.5 ? GOOD : FLOW;
}
