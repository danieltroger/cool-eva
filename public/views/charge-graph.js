// @ts-check
// Framing, exact capped segments and marker meanings: docs/charge-dashboard.md.
import van from "../vendor/van-1.6.1.js";
import { chartTick } from "../lib/store.js";
import { readingStatus, statusWord, worstStatus } from "../lib/reading-status.js";
import { chargeValue } from "../lib/charge-display.js";
import {
  chargeAllowance,
  chargeCeiling,
  chargeCurvePoints,
  chargeWindow,
  CHARGE_CAP_INTERSECTIONS,
} from "../lib/charge-curve.js";
import * as units from "../lib/units.js";
import * as colors from "../lib/colors.js";
const { div, span } = van.tags;
const drawing = van.tags("http://www.w3.org/2000/svg");
const TEMPERATURE_KEYS = ["ambient_temp", "batt_temp_lo", "batt_temp_hi", "batt_temp_lo_vcu", "batt_temp_hi_vcu"];

export function ChargeGraph() {
  return div({ class: "tile charge-graph" }, div({ class: "label" }, "Observed charge-current behaviour"), () => {
    chartTick.val;
    const values = temperatures();
    const window = chargeWindow(values);
    const ceiling = chargeCeiling(values.reportedLow, values.reportedHigh);
    const unknown = ceiling === null;
    const reportState = worstStatus(["batt_temp_lo_vcu", "batt_temp_hi_vcu"], true);
    return div(
      {
        class: "charge-graph-content",
        "data-ceiling": ceiling === null ? "unknown" : String(ceiling),
        "data-window": `${window.low},${window.high}`,
        "data-reference": String(unknown),
      },
      div(
        { class: "charge-graph-heading" },
        span(
          {
            class: "charge-ceiling",
            style: `color:${unknown ? (reportState === "fault" ? colors.BAD : colors.MUTED) : ceiling === 0 ? colors.BAD : ceiling === 75 ? colors.GOOD : colors.WARN}`,
          },
          ceiling === null ? "— A now" : `${ceiling.toFixed(ceiling % 1 === 0 ? 0 : 1)} A now`
        ),
        span(
          { class: "sub" },
          unknown
            ? `Limit unknown · fixed ${Math.round(units.temp(-30))}…${Math.round(units.temp(65))}${units.tempUnit()}`
            : window.fixed
              ? `Fixed ${Math.round(units.temp(-30))}…${Math.round(units.temp(65))}${units.tempUnit()} · 75 A cap`
              : "Temperature ceiling · 75 A cap"
        )
      ),
      GraphDrawing(window, values, unknown),
      div(
        { class: "charge-graph-footer" },
        div({ "data-charge-context": "" }, `Outside ${temperatureText("ambient_temp")} · battery ${physicalText()}`),
        div(
          { "data-charge-reports": "" },
          `Bike sees ○${temperatureText("batt_temp_lo_vcu", false)} / ◆${temperatureText("batt_temp_hi_vcu")}${reportState === "fresh" && unknown ? " · off curve" : ` → ${ceiling === null ? "unknown" : `${ceiling.toFixed(ceiling % 1 === 0 ? 0 : 1)} A`}`}`
        ),
        div(`Bike sees below ${Math.round(units.temp(0))} ${units.tempUnit()}: near zero allowance.`),
        div(
          unknown
            ? "No ceiling inferred; other delivery limits apply."
            : values.reportedLow !== null && values.reportedLow < CHARGE_CAP_INTERSECTIONS[0]
              ? "Cold: ceiling can rise; delivery has other limits."
              : "Other limits can lower delivered current."
        ),
        div({ class: "charge-model-caveat" }, "Observed on Energica models except the Experia")
      )
    );
  });
}

function temperatures() {
  return {
    outside: chargeValue("ambient_temp", true),
    physicalLow: chargeValue("batt_temp_lo", true),
    physicalHigh: chargeValue("batt_temp_hi", true),
    reportedLow: chargeValue("batt_temp_lo_vcu", true),
    reportedHigh: chargeValue("batt_temp_hi_vcu", true),
  };
}

/** @param {string} key @param {boolean} [unit] */
function temperatureText(key, unit = true) {
  const value = chargeValue(key, true);
  return value === null
    ? statusWord(readingStatus(key, true), "missing")
    : `${Math.round(units.temp(value))}${unit ? ` ${units.tempUnit()}` : ""}`;
}
function physicalText() {
  const state = worstStatus(["batt_temp_lo", "batt_temp_hi"], true);
  return state === "fresh"
    ? `${temperatureText("batt_temp_lo", false)}–${temperatureText("batt_temp_hi")}`
    : statusWord(state);
}
function fallbackReason() {
  const invalid = TEMPERATURE_KEYS.filter(key => readingStatus(key, true) !== "fresh");
  if (invalid.length) {
    const name = invalid.some(key => key.endsWith("_vcu"))
      ? "reported temperatures"
      : invalid.includes("ambient_temp")
        ? "outside"
        : "physical battery";
    return `${name} ${statusWord(worstStatus(invalid, true), "missing")}`;
  }
  return "reported temperature off curve";
}

/** @param {{low:number,high:number,fixed:boolean}} window @param {import("../lib/charge-curve.js").ChargeTemperatures} values @param {boolean} reference */
function GraphDrawing(window, values, reference) {
  const width = 356,
    left = 34,
    right = 330,
    top = 16,
    plotHeight = 72;
  const x = /** @param {number} temperature */ temperature =>
    left + ((temperature - window.low) / (window.high - window.low)) * (right - left);
  const y = /** @param {number} amps */ amps => top + ((75 - amps) / 75) * plotHeight;
  const points = chargeCurvePoints(window);
  const plot = drawing.svg(
    {
      class: "charge-chart",
      viewBox: `0 0 ${width} 110`,
      role: "img",
      "aria-label": `Observed temperature ceiling, ${Math.round(units.temp(window.low))} to ${Math.round(units.temp(window.high))} ${units.tempUnit()}, fixed 0 to 75 A${reference ? ", reference only; current limit unknown" : ""}${window.fixed ? `, fixed window: ${fallbackReason()}` : ""}`,
    },
    ...[75, 50, 0].flatMap(amps => [
      drawing.line({ x1: left, x2: right, y1: y(amps), y2: y(amps), style: `stroke:${colors.TRACK}` }),
      drawing.text(
        { x: amps === 0 ? 8 : 0, y: y(amps) + 4, "text-anchor": "start", style: `fill:${colors.MUTED}` },
        `${amps} A`
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
          y: 106,
          "text-anchor": temperature === window.low ? "start" : temperature === window.high ? "end" : "middle",
          style: `fill:${colors.MUTED}`,
        },
        `${Math.round(units.temp(temperature))}${units.tempUnit()}`
      )
    )
  );
  if (window.low <= 40 && window.high >= 40) {
    van.add(
      plot,
      drawing.circle({ cx: x(40), cy: y(50), r: 3, style: `fill:${colors.CALM}`, "data-charge-knee": "40" })
    );
  }
  for (const intersection of CHARGE_CAP_INTERSECTIONS) {
    if (intersection >= window.low && intersection <= window.high) {
      van.add(
        plot,
        drawing.text(
          {
            x: x(intersection) + (x(intersection) > 280 ? -10 : 12),
            y: 12,
            "text-anchor": x(intersection) > 280 ? "end" : "start",
            style: `fill:${colors.MUTED};font-size:11.5px`,
            "data-cap-label": intersection,
          },
          `${units.temp(intersection).toFixed(1)}°`
        )
      );
      van.add(
        plot,
        drawing.line({
          x1: x(intersection),
          x2: x(intersection),
          y1: top,
          y2: top + plotHeight,
          style: `stroke:${colors.MUTED}`,
          "stroke-dasharray": "2 3",
          "data-cap-knee": intersection,
        })
      );
    }
  }
  if (window.low <= 0 && window.high >= 0) {
    van.add(plot, drawing.text({ x: x(0) + 4, y: y(2) - 7, style: `fill:${colors.MUTED}` }, "2 A"));
  }
  for (const [kind, temperature] of /** @type {const} */ ([
    ["low", values.reportedLow],
    ["high", values.reportedHigh],
  ])) {
    const amps = chargeAllowance(temperature);
    if (temperature === null || amps === null) continue;
    const horizontal = x(temperature),
      vertical = y(amps);
    const markerInk = amps === 0 ? colors.BAD : amps < 75 ? colors.WARN : colors.GOOD;
    van.add(
      plot,
      drawing.line({
        x1: horizontal,
        x2: horizontal,
        y1: vertical,
        y2: top + plotHeight,
        style: `stroke:${colors.MUTED}`,
        "stroke-dasharray": "2 3",
        "data-reported-guide": kind,
      })
    );
    van.add(
      plot,
      kind === "low"
        ? drawing.circle({
            cx: horizontal,
            cy: vertical,
            r: 5,
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
  }
  return plot;
}
