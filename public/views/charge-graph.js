// @ts-check
// Framing, exact capped segments and marker meanings: docs/charge-dashboard.md.
import van from "../vendor/van-1.6.1.js";
import { chartTick } from "../lib/store.js";
import { readingStatus, statusWord, worstStatus, freshValue } from "../lib/reading-status.js";

import { chargeAllowance, chargeCeiling, chargeCurvePoints, chargeWindow } from "../lib/charge-curve.js";
import * as units from "../lib/units.js";
import * as colors from "../lib/colors.js";
const { div, span } = van.tags;
const drawing = van.tags("http://www.w3.org/2000/svg");
const TEMPERATURE_KEYS = ["ambient_temp", "batt_temp_lo_vcu", "batt_temp_hi_vcu"];

export function ChargeGraph() {
  return div({ class: "tile layout-card charge-graph" }, () => {
    chartTick.val;
    const values = temperatures();
    const window = chargeWindow(values);
    const ceiling = chargeCeiling(values.reportedLow, values.reportedHigh);
    const reportState = worstStatus(["batt_temp_lo_vcu", "batt_temp_hi_vcu"], true);
    const unknown = ceiling === null;
    return div(
      {
        class: "layout-stack charge-graph-content",
        "data-ceiling": ceiling === null ? "unknown" : String(ceiling),
        "data-window": `${window.low},${window.high}`,
        "data-reference": String(unknown),
      },
      div(
        { class: "layout-between" },
        span(
          { class: "charge-label" },
          values.reportedLow !== null && values.reportedLow === values.reportedHigh
            ? "Bike-reported ceiling"
            : "Temperature limit"
        ),
        div(
          {
            class: "value charge-ceiling",
            style: `color:${unknown ? (reportState === "fault" ? colors.BAD : colors.MUTED) : ceiling === 75 ? colors.GOOD : colors.WARN}`,
          },
          unknown
            ? statusWord(reportState, "Unknown") === "—"
              ? "Unknown"
              : statusWord(reportState, "Unknown")
            : String(Math.round(ceiling)),
          unknown ? null : span({ class: "unit" }, "A")
        )
      ),
      GraphDrawing(window, values, unknown),
      span(
        { class: "charge-sub" },
        unknown && reportState === "missing"
          ? "Temperatures missing · reference window"
          : "Observed charge-current behaviour"
      )
    );
  });
}

function temperatures() {
  return {
    outside: freshValue("ambient_temp", true),
    physicalLow: freshValue("batt_temp_lo", true),
    physicalHigh: freshValue("batt_temp_hi", true),
    reportedLow: freshValue("batt_temp_lo_vcu", true),
    reportedHigh: freshValue("batt_temp_hi_vcu", true),
  };
}

function fallbackReason() {
  const invalid = TEMPERATURE_KEYS.filter(key => readingStatus(key, true) !== "fresh");
  if (invalid.length) {
    const name = invalid.some(key => key.endsWith("_vcu"))
      ? "reported temperatures"
      : invalid.includes("ambient_temp")
        ? "outside"
        : "outside";
    return `${name} ${statusWord(worstStatus(invalid, true), "missing")}`;
  }
  return "reported temperature off curve";
}

/** @param {{low:number,high:number,fixed:boolean}} window @param {import("../lib/charge-curve.js").ChargeTemperatures} values @param {boolean} reference */
function GraphDrawing(window, values, reference) {
  const width = 342,
    left = 30,
    right = 332,
    top = 16,
    plotHeight = 84;
  const x = /** @param {number} temperature */ temperature =>
    left + ((temperature - window.low) / (window.high - window.low)) * (right - left);
  const y = /** @param {number} amps */ amps => top + ((75 - amps) / 75) * plotHeight;
  const points = chargeCurvePoints(window);
  const plot = drawing.svg(
    {
      class: "charge-chart",
      viewBox: `0 0 ${width} 132`,
      role: "img",
      "aria-label": `Observed temperature ceiling, ${Math.round(units.temp(window.low))} to ${Math.round(units.temp(window.high))} ${units.tempUnit()}, fixed 0 to 75 A${reference ? ", reference only; current limit unknown" : ""}${window.fixed ? `, fixed window: ${fallbackReason()}` : ""}`,
    },
    ...[75, 50, 0].flatMap(amps => [
      drawing.line({ x1: left, x2: right, y1: y(amps), y2: y(amps), style: `stroke:${colors.TRACK}` }),
      drawing.text(
        { x: amps === 0 ? 8 : 0, y: y(amps) + 4, "text-anchor": "start", style: `fill:${colors.MUTED}` },
        String(amps)
      ),
    ]),
    drawing.polyline({
      "data-curve": "",
      points: points.map(point => `${x(point.temperature)},${y(point.amps)}`).join(" "),
      style: `fill:none;stroke:${reference ? colors.MUTED : colors.GOOD}`,
      "stroke-width": 3,
      ...(reference ? { "stroke-dasharray": "5 4" } : {}),
    }),
    ...[
      ...new Set([
        window.low,
        ...[0, 40, 55].filter(value => x(value) - left > 55 && right - x(value) > 55),
        window.high,
      ]),
    ].map(temperature =>
      drawing.text(
        {
          x: x(temperature),
          y: 122,
          "text-anchor": temperature === window.low ? "start" : temperature === window.high ? "end" : "middle",
          style: `fill:${colors.MUTED}`,
        },
        `${Math.round(units.temp(temperature))}°`
      )
    )
  );
  for (const [kind, temperature] of /** @type {const} */ ([
    ["low", values.reportedLow],
    ["high", values.reportedHigh],
  ])) {
    const amps = chargeAllowance(temperature);
    if (temperature === null || amps === null || temperature < window.low || temperature > window.high) continue;
    const horizontal = x(temperature),
      vertical = y(amps);
    const markerInk = amps === 0 ? colors.BAD : colors.WARN;
    const coincident = values.reportedLow === values.reportedHigh;
    van.add(
      plot,
      kind === "low"
        ? drawing.circle({
            cx: horizontal,
            cy: vertical,
            r: coincident ? 7 : 5,
            style: `fill:var(--tile);stroke:${markerInk}`,
            "stroke-width": 2,
            "data-reported-marker": kind,
          })
        : drawing.polygon({
            points: `${horizontal},${vertical - 4.5} ${horizontal + 4.5},${vertical} ${horizontal},${vertical + 4.5} ${horizontal - 4.5},${vertical}`,
            style: `fill:${markerInk};stroke:var(--tile)`,
            "stroke-width": 1,
            "data-reported-marker": kind,
          })
    );
    if (!coincident || kind === "high") {
      van.add(
        plot,
        drawing.text(
          {
            x: coincident
              ? Math.min(296, Math.max(68, horizontal))
              : Math.min(306, Math.max(32, horizontal + (kind === "low" ? -24 : 6))),
            "text-anchor": coincident ? "middle" : "start",
            y: Math.min(95, Math.max(30, vertical + (coincident ? 24 : kind === "low" ? -12 : 18))),
            style: `fill:${colors.MUTED}`,
            "data-reported-label": coincident ? "both" : kind,
          },
          `${Math.round(units.temp(temperature))}°${coincident ? " · both" : ""}`
        )
      );
    }
  }
  return plot;
}
