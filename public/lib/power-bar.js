// @ts-check

import van from "../vendor/van-1.6.1.js";

// The riding screen's power meter: a thin vertical strip down the left edge of the speed
// hero, copied from the Model 3/Y's own (the owner's photos are in the design notes).
//
// Vertical is not decoration. The horizontal bar it replaces cost a row of its own plus a
// row of legend under it; this one runs down the side of a numeral that was already that
// tall, so the meter is free and two rows of screen come back — which is what the riding
// screen is short of.
//
// The pure pieces are exported so scripts/check-power-bar.ts can walk them in Node, where
// van's tags have no document.createElementNS to call. docs/dashboard-decisions.md
// §"The power meter" has the measurements and the four designs this one replaces.

const svgTags = van.tags("http://www.w3.org/2000/svg");

/** The scale is drawn in a 0…100 viewBox down the strip; this is how wide it is. */
const WIDTH = 10;

/**
 * What each half shows at its end. Fixed, and asymmetric on this bike: the two
 * directions are not remotely the same size, so one number for both would spend most of
 * the regen half on power the machine cannot produce.
 * @typedef {object} SplitBarScale
 * @property {number} drive largest magnitude the upper half can show
 * @property {number} regen largest magnitude the lower half can show
 */

/**
 * The stretch of scale the pack has taken away, drawn in the track's own grey with
 * transparent gaps — the owner's spec, and Tesla's language for the same thing.
 */
export const TRACK = "var(--track)";

/** Dash geometry down the strip, in viewBox y. */
const DASH = 3.4;
const DASH_GAP = 2.6;

/**
 * How much of a dashed stretch is ink rather than the tile showing through.
 *
 * Exported because it is half of how visible a derate is, and the check that measures
 * that must not carry its own copy of it: scripts/check-theme-contrast.ts weighs --track
 * against the ground by this figure to get what the eye actually averages over a dashed
 * run. Change the dash period and the floors move with it.
 */
export const DASH_DUTY = DASH / (DASH + DASH_GAP);

/** The notch that marks zero, and the mark for a ceiling the fill has gone past. */
const ORIGIN_NOTCH = 1.6;
const CEILING_TICK = 2;

/**
 * The power meter. Drive grows UP from the origin, regen DOWN.
 *
 * ⚠️ That direction is an inference, not something the reference photos settle: they show
 * a regen segment low in the strip, and up-is-more is what every other vertical meter a
 * rider has used does. It is one line to flip. docs/dashboard-decisions.md says so too.
 * @param {object} options
 * @param {number | null} options.value
 * @param {SplitBarScale} options.fullScale largest magnitude each direction can show
 * @param {string} options.color
 * @param {import("./power-limits.js").PowerLimitsKw | null} [options.limits]
 * @returns {Element}
 */
export function powerBar({ value, fullScale, color, limits = null }) {
  const children = barLayers({ value, fullScale, color, limits }).map(layer =>
    layer.dashed
      ? svgTags.line({
          x1: WIDTH / 2,
          y1: layer.from.toFixed(2),
          x2: WIDTH / 2,
          y2: layer.to.toFixed(2),
          style: `stroke:${layer.fill}`,
          "stroke-width": WIDTH,
          "stroke-dasharray": `${DASH} ${DASH_GAP}`,
          // Anchored to the STRIP, not to this span's start: without it the pattern is
          // placed from a ceiling that moves at 2 Hz, so the dashes slide while the bike
          // is doing nothing. Same trap the hatching this replaces had to fix.
          "stroke-dashoffset": layer.from.toFixed(2),
        })
      : svgTags.rect({
          x: 0,
          y: layer.from.toFixed(2),
          width: WIDTH,
          height: (layer.to - layer.from).toFixed(2),
          style: `fill:${layer.fill}`,
        })
  );
  return svgTags.svg({ viewBox: `0 0 ${WIDTH} 100`, preserveAspectRatio: "none", class: "power-strip" }, ...children);
}

/**
 * Every mark the strip is made of, in PAINT ORDER: the dashed stretches the pack has
 * taken, the solid stretch it still allows, the fill, and last the ceiling mark.
 *
 * ⚠️ Ordered, pure and exported because the order IS the design — a draft drew the fill
 * last and silently lost the ceiling reading. check-power-bar.ts §7 walks it.
 * @param {object} options
 * @param {number | null} options.value
 * @param {SplitBarScale} options.fullScale
 * @param {string} options.color
 * @param {import("./power-limits.js").PowerLimitsKw | null} options.limits
 * @returns {Array<{ name: string, from: number, to: number, fill: string, dashed?: boolean }>}
 */
export function barLayers({ value, fullScale, color, limits }) {
  const origin = originY({ fullScale });
  // Negative is discharge on this bike, and discharge is the direction you are going, so
  // it draws upwards. See the sign note in derive.js.
  const isDrive = (value ?? 0) < 0;
  const scale = isDrive ? fullScale.drive : fullScale.regen;
  const travel = isDrive ? origin : 100 - origin;
  const magnitude = value == null || scale <= 0 ? 0 : Math.min(Math.abs(value) / scale, 1) * travel;
  const reach = reachable({ limits, fullScale, origin });
  const filled = { from: isDrive ? origin - magnitude : origin, to: isDrive ? origin : origin + magnitude };

  const layers = [];
  if (reach.from > 0) {
    layers.push({ name: "taken", from: 0, to: reach.from, fill: TRACK, dashed: true });
  }
  if (reach.to < 100) {
    layers.push({ name: "taken", from: reach.to, to: 100, fill: TRACK, dashed: true });
  }
  for (const segment of trackSegments({ reach, origin })) {
    layers.push({ name: "track", from: segment.from, to: segment.to, fill: TRACK });
  }
  if (magnitude > 0) {
    layers.push({ name: "fill", from: filled.from, to: filled.to, fill: color });
  }
  const mark = ceilingMark({ filled, reach });
  if (mark !== null) {
    layers.push({ name: "ceiling", from: mark, to: mark + CEILING_TICK, fill: TRACK });
  }
  return layers;
}

/**
 * Where zero sits down the strip, in viewBox y. Each direction gets the share of the
 * HEIGHT its scale has of the total, so one viewBox unit is the same number of kilowatts
 * above the origin as below it.
 *
 * Pure, and exported, so scripts/check-power-bar.ts can assert it without a DOM.
 * @param {object} options
 * @param {SplitBarScale} options.fullScale
 * @returns {number}
 */
export function originY({ fullScale }) {
  const span = fullScale.drive + fullScale.regen;
  return span <= 0 ? 50 : (fullScale.drive / span) * 100;
}

/**
 * The stretch of scale the BMS is still allowing, in viewBox y. A ceiling wider than its
 * half reaches that half's end and takes nothing away; a ceiling of zero collapses that
 * side onto the origin. Both fall out of the arithmetic with nothing to special-case, and
 * there is no minimum width — a derate too small to see renders as a change too small to
 * see. Pure and exported for the same reason as originY().
 * @param {object} options
 * @param {import("./power-limits.js").PowerLimitsKw | null} options.limits
 * @param {SplitBarScale} options.fullScale
 * @param {number} options.origin
 * @returns {{ from: number, to: number }}
 */
export function reachable({ limits, fullScale, origin }) {
  if (limits == null) {
    return { from: 0, to: 100 };
  }
  return {
    from: origin - side(limits.drive, fullScale.drive, origin),
    to: origin + side(limits.regen, fullScale.regen, 100 - origin),
  };
}

/**
 * How far one direction reaches, in viewBox units.
 *
 * ⚠️ A missing ceiling reaches the END, not the origin. `null` means 0x202 has not
 * arrived (5-11% of moving time) or a charge is up, and drawing that as "the pack allows
 * nothing" would be the loudest statement on the strip made out of no evidence.
 * @param {number | null} kilowatts
 * @param {number} scale
 * @param {number} travel
 * @returns {number}
 */
function side(kilowatts, scale, travel) {
  if (kilowatts == null || scale <= 0) {
    return travel;
  }
  return Math.max(0, Math.min(kilowatts / scale, 1)) * travel;
}

/**
 * The runs of solid track either side of the notch that marks zero.
 *
 * The notch is a gap rather than a mark, so nothing is painted in a colour assumed for
 * the ground. It is the only thing that says where zero is while the strip is empty; once
 * there is power the fill grows from that point and marks it itself.
 * @param {object} options
 * @param {{ from: number, to: number }} options.reach
 * @param {number} options.origin
 * @returns {Array<{ from: number, to: number }>}
 */
function trackSegments({ reach, origin }) {
  const half = ORIGIN_NOTCH / 2;
  return [
    { from: reach.from, to: Math.min(reach.to, origin - half) },
    { from: Math.max(reach.from, origin + half), to: reach.to },
  ].filter(segment => segment.to > segment.from);
}

/**
 * Where to mark the ceiling, or null while the fill has not reached it.
 *
 * ⚠️ Clamped inside the FILL. A ceiling under one tick's worth of scale leaves less than
 * a tick of reachable stretch, and an unclamped mark then lands on the far side of zero,
 * in the other direction's half.
 * @param {object} options
 * @param {{ from: number, to: number }} options.filled the stretch the fill covers
 * @param {{ from: number, to: number }} options.reach
 * @returns {number | null}
 */
export function ceilingMark({ filled, reach }) {
  if (filled.to - filled.from < CEILING_TICK) {
    return null;
  }
  if (filled.from < reach.from) {
    return Math.min(reach.from, filled.to - CEILING_TICK);
  }
  if (filled.to > reach.to) {
    return Math.max(reach.to - CEILING_TICK, filled.from);
  }
  return null;
}
