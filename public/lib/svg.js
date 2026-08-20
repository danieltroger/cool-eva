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
// Everything below takes plain numbers and returns an element. No state, no
// subscriptions — the views decide when to redraw, which is the 2 Hz chartTick
// rather than the 20 Hz frame rate of the underlying signals.

const svgTags = van.tags("http://www.w3.org/2000/svg");

// Unfilled part of any bar or ring. Must not be the tile background (#1e293b) —
// that was the first version, and it made every bar invisible until it was more
// than half full, which is exactly when you no longer need to look at it.
const TRACK = "#0b1220";

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
 * @param {object} options
 * @param {number | null} options.value
 * @param {number} options.limit largest magnitude the bar can show
 * @param {string} options.color
 * @param {number} [options.height]
 * @returns {Element}
 */
export function splitBar({ value, limit, color, height = 14 }) {
  const width = 100;
  const centre = width / 2;
  const magnitude = value == null ? 0 : Math.min(Math.abs(value) / limit, 1) * centre;
  // Negative is discharge on this bike, and discharge is the direction you are
  // going, so it draws to the right. See the sign note in derive.js.
  const isDrive = (value ?? 0) < 0;
  return svgTags.svg(
    { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: "none", class: "meter" },
    svgTags.rect({ x: 0, y: 0, width, height, rx: 2, fill: TRACK }),
    svgTags.rect({
      x: isDrive ? centre : centre - magnitude,
      y: 0,
      width: magnitude.toFixed(2),
      height,
      fill: color,
    }),
    svgTags.rect({ x: centre - 0.5, y: 0, width: 1, height, fill: "#475569" })
  );
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
