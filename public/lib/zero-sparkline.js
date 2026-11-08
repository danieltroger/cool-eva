// @ts-check
import van from "../vendor/van-1.6.1.js";

const tags = van.tags("http://www.w3.org/2000/svg");

/** The reference stays visible for positive, negative and flat traces; docs/ride-thermal.md.
 * @param {number[]} values
 * @param {string} color */
export function zeroSparkline(values, color) {
  const high = Math.max(0, ...values);
  const low = Math.min(0, ...values);
  const span = Math.max(0.5, high - low);
  const zero = 4 + (high / span) * 40;
  const points = values
    .map((value, index) => `${16 + (index / Math.max(1, values.length - 1)) * 326},${4 + ((high - value) / span) * 40}`)
    .join(" ");
  return tags.svg(
    { viewBox: "0 0 342 48", class: "spark ride-zero-trace", role: "img", "aria-label": "Coolant ΔT" },
    tags.line({
      x1: 16,
      x2: 342,
      y1: zero,
      y2: zero,
      style: "stroke:var(--sub)",
      "stroke-width": 1,
      "data-zero-line": "",
    }),
    tags.text({ x: 0, y: Math.max(12, Math.min(46, zero + 2)), class: "ride-chart-label" }, "0"),
    values.length < 2
      ? null
      : tags.polyline({
          points,
          style: `fill:none;stroke:${color}`,
          "stroke-width": 2,
          "stroke-linejoin": "round",
          "stroke-linecap": "round",
        })
  );
}
