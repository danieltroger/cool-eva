// @ts-check

import van from "../vendor/van-1.6.1.js";
import { MUTED } from "./colors.js";

// Inline-SVG drawing primitives: sparkline, meter, split bar, ring.
//
// Hand-rolled rather than pulled from a chart library, for two reasons. The whole
// dashboard is ~30 kB and loads over a phone hotspot in a garage — uPlot alone is
// bigger than everything here put together. And a charting library's defaults
// (axes, ticks, legends, tooltips) are all things this screen deliberately does not
// have: at 90 km/h the only readable chart is a bare shape with one number on it.
//
// Everything below takes plain numbers and returns an element, or — for
// derateSpans() — the geometry an element is built from. No state, no
// subscriptions — the views decide when to redraw, which is the 2 Hz chartTick
// rather than the 20 Hz frame rate of the underlying signals.

const svgTags = van.tags("http://www.w3.org/2000/svg");

// Unfilled part of any bar or ring. Must not be the tile background (#1e293b) —
// that was the first version, and it made every bar invisible until it was more
// than half full, which is exactly when you no longer need to look at it.
export const TRACK = "#0b1220";

/**
 * The dashes over a stretch of bar the BMS has derated away.
 *
 * ⚠️ They are drawn ON the track and the track is NOT recoloured underneath them. The
 * first version painted full-height blocks in a lighter slate instead, and that failed
 * in a way only a screenshot showed: the gaps between the blocks were the track's own
 * colour, so a gap and the still-available stretch beside it were the same pixels, and
 * the eye could not tell whether a dark chunk meant headroom or the space between two
 * marks. The fix is that the marking is no longer full height — see HATCH_HEIGHT.
 */
export const DERATED = "#64748b";

/**
 * Hatch geometry, in viewBox x — a period of 3 puts about 33 dashes across a full bar
 * and about 8 across a quarter of one, dense enough to read as a rule rather than as a
 * row of ticks at every derate worth showing.
 */
const HATCH_DASH = 1.7;
const HATCH_GAP = 1.3;

/**
 * How tall the dashes are as a fraction of the bar. Well under 1 is the whole point:
 * anything the full height of the bar competes with the fill for "this is the bar", and
 * a short rule down the middle of a stretch cannot be confused with the stretch itself.
 */
const HATCH_HEIGHT = 0.3;

/**
 * What each half of a split bar shows at its end. Fixed, and asymmetric on this bike:
 * the two directions are not remotely the same size, so one number for both would spend
 * most of the regen half on power the machine cannot produce.
 * @typedef {object} SplitBarScale
 * @property {number} drive largest magnitude the right half can show
 * @property {number} regen largest magnitude the left half can show
 */

/**
 * A bare trace with no axes. Autoscales to its own window, with a floor on the
 * span so a dead-flat signal doesn't get amplified into dramatic-looking noise.
 * @param {object} options
 * @param {number[]} options.values oldest → newest
 * @param {string} options.color
 * @param {number} [options.minSpan] smallest y-range to scale to, in signal units
 * @param {number} [options.height]
 * @param {number | null} [options.baseline] draw a reference line at this value
 * @returns {Element}
 */
export function sparkline({ values, color, minSpan = 1, height = 26, baseline = null }) {
  const width = 100;
  if (values.length < 2) {
    // Something must occupy the space or tiles jump around as data arrives.
    return svgTags.svg(
      { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: "none", class: "spark" },
      svgTags.line({ x1: 0, y1: height / 2, x2: width, y2: height / 2, stroke: MUTED, "stroke-dasharray": "2 3" })
    );
  }

  let low = Math.min(...values);
  let high = Math.max(...values);
  if (baseline != null) {
    low = Math.min(low, baseline);
    high = Math.max(high, baseline);
  }
  const span = Math.max(high - low, minSpan);
  const middle = (high + low) / 2;
  const top = middle + span / 2;
  const scaleY = /** @param {number} value */ value => height - ((value - (top - span)) / span) * height;
  const scaleX = /** @param {number} index */ index => (index / (values.length - 1)) * width;

  const points = values.map((value, index) => `${scaleX(index).toFixed(1)},${scaleY(value).toFixed(1)}`).join(" ");

  const children = [];
  if (baseline != null) {
    const y = scaleY(baseline).toFixed(1);
    children.push(
      svgTags.line({ x1: 0, y1: y, x2: width, y2: y, stroke: MUTED, "stroke-width": 0.5, "stroke-dasharray": "2 2" })
    );
  }
  children.push(
    svgTags.polyline({
      points,
      fill: "none",
      stroke: color,
      "stroke-width": 1.6,
      "stroke-linejoin": "round",
      "stroke-linecap": "round",
      // The viewBox is stretched to the tile width, which would stretch the stroke
      // with it and leave a hairline at one end and a slab at the other.
      "vector-effect": "non-scaling-stroke",
    })
  );

  return svgTags.svg({ viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: "none", class: "spark" }, ...children);
}

/**
 * A left-to-right filled bar, 0…1.
 * @param {object} options
 * @param {number | null} options.fraction
 * @param {string} options.color
 * @param {number} [options.height]
 * @param {number | null} [options.marker] draw a tick at this fraction
 * @returns {Element}
 */
export function meter({ fraction, color, height = 10, marker = null }) {
  const width = 100;
  const filled = fraction == null ? 0 : Math.max(0, Math.min(1, fraction));
  const children = [
    svgTags.rect({ x: 0, y: 0, width, height, rx: height / 2, fill: TRACK }),
    svgTags.rect({ x: 0, y: 0, width: (filled * width).toFixed(2), height, rx: height / 2, fill: color }),
  ];
  if (marker != null) {
    const x = (Math.max(0, Math.min(1, marker)) * width).toFixed(2);
    children.push(svgTags.rect({ x, y: -1, width: 1, height: height + 2, fill: "#e2e8f0" }));
  }
  return svgTags.svg({ viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: "none", class: "meter" }, ...children);
}

/**
 * A bar that grows from the centre: regen to the left, drive to the right. Power
 * is the one number where direction matters as much as magnitude, and a signed
 * digit is much slower to read than a bar that moves the other way.
 *
 * `limits` is what the BMS is allowing right now, and it does not move the scale — it
 * hatches the part of the scale you can no longer reach. `fullScale` is the scale, per
 * half, and it never moves at all.
 *
 * Both are positive magnitudes in the same units as `value`, and both arrive as ONE
 * object rather than as two parameters on purpose: two would be a pair of same-typed
 * arguments a caller can cross, and a crossed pair draws a plausible screen rather than
 * a broken one. Which side each lands on is this function's business.
 * @param {object} options
 * @param {number | null} options.value
 * @param {SplitBarScale} options.fullScale largest magnitude each half can show
 * @param {string} options.color
 * @param {import("./power-limits.js").PowerLimitsKw | null} [options.limits]
 * @param {number} [options.height]
 * @returns {Element}
 */
export function splitBar({ value, fullScale, color, limits = null, height = 14 }) {
  const width = 100;
  const centre = width / 2;
  // Negative is discharge on this bike, and discharge is the direction you are
  // going, so it draws to the right. See the sign note in derive.js.
  const isDrive = (value ?? 0) < 0;
  const scale = isDrive ? fullScale.drive : fullScale.regen;
  const magnitude = value == null || scale <= 0 ? 0 : Math.min(Math.abs(value) / scale, 1) * centre;
  const children = [
    svgTags.rect({ x: 0, y: 0, width, height, rx: 2, fill: TRACK }),
    svgTags.rect({
      x: isDrive ? centre : centre - magnitude,
      y: 0,
      width: magnitude.toFixed(2),
      height,
      fill: color,
    }),
  ];
  // Over the fill, not under it. A rule marking the unreachable stretch that disappears
  // the moment you reach into it hides the one reading that needed it; the fill is still
  // the loudest thing on the bar, since the rule is under a third of its height.
  //
  // ⚠️ There is no zero divider, and there was one — a 1-unit slate rect at the centre.
  // Nothing needs it: the bar always spans the whole tile, so zero is the middle of a
  // shape the eye already has, and the fill grows FROM there, so its inner edge marks
  // the same point whenever there is any power to speak of. What it did instead was
  // stand in the way. It had to be drawn after the hatching to survive a 0 A ceiling,
  // and it then read as a slate block interrupting a run of dashes — one more thing on
  // the bar to work out, in the state with the least to say.
  for (const span of derateSpans({ limits, fullScale, centre })) {
    children.push(hatching(span, height));
  }
  return svgTags.svg({ viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: "none", class: "meter" }, ...children);
}

/**
 * The stretches of bar the BMS has taken away, in viewBox x — from each ceiling out to
 * that side's end. Drive is right of centre and regen is left, matching the fill.
 *
 * The scale never moves. That is the whole point of showing a derate this way rather
 * than as a line at the ceiling, which is what this drew first: a line answers "where
 * is the limit" and leaves the rider to measure the gap, while hatching answers "how
 * much has gone" directly, and the two ends stop being special cases. A ceiling wider
 * than its half hatches NOTHING, and — with no minimum width to swallow the small
 * cases — an unhatched half means exactly one thing: the pack is not what is limiting
 * you. The line had to be either dropped (indistinguishable from "0x202 has not
 * arrived", 5-11% of moving time) or pinned to the end (indistinguishable from a ceiling
 * AT full scale). A ceiling of zero hatches the whole half, where the line sat on the
 * centre divider and could be mistaken for it.
 *
 * Each half is measured against ITS OWN full scale, which is why `fullScale` is a pair.
 * A single scale wide enough for the drive side leaves the regen side unable to fill
 * more than a third of its half on the best day the pack has ever had — so ~70% of it
 * would hatch permanently, on a healthy bike, teaching the eye to ignore the hatching
 * exactly where it is the signal. See docs/dashboard-decisions.md §"The power bar".
 *
 * Pure, and exported, so scripts/check-power-bar.ts can assert which side each lands on
 * without a DOM — van's tags need document.createElementNS and Node has neither.
 * @param {object} options
 * @param {import("./power-limits.js").PowerLimitsKw | null} options.limits
 * @param {SplitBarScale} options.fullScale
 * @param {number} options.centre half the bar's width, in viewBox units
 * @returns {Array<{ x: number, width: number }>}
 */
export function derateSpans({ limits, fullScale, centre }) {
  if (limits == null) {
    return [];
  }
  const sides = [
    { value: limits.drive, scale: fullScale.drive, direction: 1 },
    { value: limits.regen, scale: fullScale.regen, direction: -1 },
  ];
  const spans = [];
  for (const side of sides) {
    if (side.value == null || side.scale <= 0) {
      continue;
    }
    const reachable = Math.min(side.value / side.scale, 1) * centre;
    const lost = centre - reachable;
    // ⚠️ Strictly zero, and no "too small to bother" threshold. There was one, at 7% of
    // a half, and it drew NOTHING for any drive ceiling in (120.9, 130] kW — a derate of
    // up to 9.1 kW rendered identically to a healthy pack, for 10.4% of moving time
    // against the 6.2% where the blank end is honest. That is the "absence has two
    // meanings" failure this bar has now been through twice; the threshold was a third
    // route to it. A derate too small to see renders as a mark too small to see, which
    // is the truthful picture and needs no rule.
    if (lost <= 0) {
      continue;
    }
    spans.push({ x: side.direction > 0 ? centre + reachable : 0, width: lost });
  }
  return spans;
}

/**
 * One hatched stretch: a single dashed horizontal rule down the middle of it, which is
 * a run of marks for two attributes and no per-dash geometry.
 *
 * Deliberately NOT `vector-effect: non-scaling-stroke`, unlike every other stroke in
 * this file. Both the stroke width and the dash period here are fractions of the bar's
 * own dimensions, so the rule keeps its proportions from a 380 px phone to a 1000 px
 * laptop. The non-scaling strokes elsewhere are hairlines, where stretching is the bug.
 * @param {{ x: number, width: number }} span
 * @param {number} height
 * @returns {Element}
 */
function hatching(span, height) {
  return svgTags.line({
    x1: span.x.toFixed(2),
    y1: height / 2,
    x2: (span.x + span.width).toFixed(2),
    y2: height / 2,
    stroke: DERATED,
    "stroke-width": (height * HATCH_HEIGHT).toFixed(2),
    "stroke-dasharray": `${HATCH_DASH} ${HATCH_GAP}`,
    // Anchors the pattern to the BAR rather than to this span's start. Without it the
    // dashes are placed from `span.x`, which is a constant 0 on the regen side but the
    // moving ceiling on the drive side — so the drive texture slid sideways every time
    // the derate changed, at 2 Hz, reading as motion where there is none, and the two
    // halves behaved differently for no reason visible to anyone looking at them.
    "stroke-dashoffset": span.x.toFixed(2),
  });
}

/**
 * A progress ring. Used once, for state of charge on the charging screen, where
 * it is the only thing on the page and can afford to be large.
 * @param {object} options
 * @param {number | null} options.fraction
 * @param {string} options.color
 * @returns {Element}
 */
export function ring({ fraction, color }) {
  const size = 100;
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  const filled = fraction == null ? 0 : Math.max(0, Math.min(1, fraction));
  return svgTags.svg(
    { viewBox: `0 0 ${size} ${size}`, class: "ring" },
    svgTags.circle({ cx: size / 2, cy: size / 2, r: radius, fill: "none", stroke: TRACK, "stroke-width": 8 }),
    svgTags.circle({
      cx: size / 2,
      cy: size / 2,
      r: radius,
      fill: "none",
      stroke: color,
      "stroke-width": 8,
      "stroke-linecap": "round",
      "stroke-dasharray": `${(filled * circumference).toFixed(2)} ${circumference.toFixed(2)}`,
      // Start at twelve o'clock rather than three.
      transform: `rotate(-90 ${size / 2} ${size / 2})`,
    })
  );
}

/**
 * A row of thin vertical bars — the 81 cell voltages, weakest highlighted. Reading
 * 81 numbers is impossible; seeing which bar is short is instant.
 * @param {object} options
 * @param {Array<{ value: number, color: string }>} options.bars
 * @param {number} options.low bottom of the scale
 * @param {number} options.high top of the scale
 * @param {number} [options.height]
 * @returns {Element}
 */
export function barStrip({ bars, low, high, height = 60 }) {
  const width = 100;
  const span = Math.max(high - low, 1);
  const barWidth = width / Math.max(bars.length, 1);
  const rects = bars.map((bar, index) => {
    const fraction = Math.max(0, Math.min(1, (bar.value - low) / span));
    const barHeight = Math.max(fraction * height, 0.5);
    return svgTags.rect({
      x: (index * barWidth).toFixed(2),
      y: (height - barHeight).toFixed(2),
      width: Math.max(barWidth - 0.25, 0.3).toFixed(2),
      height: barHeight.toFixed(2),
      fill: bar.color,
    });
  });
  return svgTags.svg({ viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: "none", class: "strip" }, ...rects);
}

/**
 * A labelled grid of coloured cells — the pack, module by module.
 *
 * Rows are modules and columns are the sensors or cells within one, so the shape on
 * screen is the shape of the pack: a strip shows that something is drifting, a grid
 * shows *which module*. Cells with no reading are drawn as an empty outline rather than
 * skipped, so a hole looks like a missing sensor and not like a shifted row, and row
 * labels are HTML beside the SVG because preserveAspectRatio="none" would stretch
 * glyphs ~1.9x wider than tall. See docs/dashboard-decisions.md §"The heatmap".
 *
 * @param {object} options
 * @param {Array<{ label: string, cells: Array<{ value: number | null, color: string }> }>} options.rows
 * @param {number} [options.columns] widest row; defaults to the longest supplied
 * @returns {Element}
 */
export function heatmap({ rows, columns }) {
  const width = 100;
  const labelWidth = 0;
  const rowHeight = 8;
  const gap = 0.6;
  const columnCount = columns ?? Math.max(...rows.map(row => row.cells.length), 1);
  const cellWidth = (width - labelWidth) / columnCount;
  const height = rows.length * rowHeight;

  /** @type {Element[]} */
  const children = [];
  rows.forEach((row, rowIndex) => {
    const y = rowIndex * rowHeight;
    row.cells.forEach((cell, columnIndex) => {
      const x = labelWidth + columnIndex * cellWidth;
      if (cell.value == null) {
        children.push(
          svgTags.rect({
            x: x + gap / 2,
            y: y + gap / 2,
            width: cellWidth - gap,
            height: rowHeight - gap,
            fill: "none",
            stroke: TRACK,
            "stroke-width": 0.4,
          })
        );
        return;
      }
      children.push(
        svgTags.rect({
          x: x + gap / 2,
          y: y + gap / 2,
          width: cellWidth - gap,
          height: rowHeight - gap,
          rx: 0.8,
          fill: cell.color,
        })
      );
    });
  });

  return van.tags.div(
    { class: "heatmap-wrap" },
    van.tags.div({ class: "heatmap-labels" }, ...rows.map(row => van.tags.div(row.label))),
    svgTags.svg({ viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: "none", class: "heatmap" }, ...children)
  );
}
