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
/* The unfilled part of any bar, ring or meter. Here rather than beside the drawing code
   because two modules draw with it — svg.js and power-edge.js — and it was exported from
   both for a while, with the two docblocks already disagreeing about what it was for. A
   palette-token name belongs with the palette-token names. ⚠️ Must NOT be --tile: that
   was the first version, and it made every bar invisible until more than half full, which
   is exactly when you stop needing to look at it. check-theme-contrast.ts's MARK_FLOORS
   is what holds it away from the tile now. */
export const TRACK = "var(--track)";
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

/** Power direction and palette history: docs/ride-power.md. @param {number | null} kilowatts */
export function power(kilowatts) {
  if (kilowatts == null) {
    return MUTED;
  }
  return kilowatts > 0.5 ? GOOD : FLOW;
}
