// @ts-check
import van from "../vendor/van-1.6.1.js";
import { powerPosition } from "./ride-power-state.js";

const tags = van.tags("http://www.w3.org/2000/svg");
let sequence = 0;
const HATCH_STROKE = 3;
export const HATCH_DUTY = (HATCH_STROKE * Math.SQRT2) / 8;
/** @typedef {import("./ride-power-state.js").RidePowerState} RidePowerState */

/** The 18px Edge and 2px tick extension share CSS-pixel coordinates. @param {RidePowerState} state */
export function powerEdge(state) {
  const pattern = `power-hatch-${++sequence}`;
  const excessPattern = `${pattern}-excess`;
  const origin = powerPosition(0);
  const children = [
    tags.defs(hatch(pattern, "var(--track)"), hatch(excessPattern, "var(--tile)")),
    rectangle(0, 1, state.charging ? "var(--track)" : "var(--tile)", "base"),
  ];
  if (!state.charging) {
    for (const side of ["regen", "drive"]) {
      const limit = side === "drive" ? state.drive : state.regen;
      const from = side === "regen" ? 0 : origin;
      const to = side === "regen" ? origin : 1;
      if (limit.kilowatts === null) {
        children.push(
          tags.line({
            x1: percent(from),
            x2: percent(to),
            y1: 11,
            y2: 11,
            style: "stroke:var(--sub)",
            "stroke-width": 2,
            "stroke-dasharray": "4 4",
            "data-layer": "unknown",
            "data-side": side,
          })
        );
      } else {
        const ceiling = bounded(powerPosition(side === "drive" ? -limit.kilowatts : limit.kilowatts));
        children.push(
          rectangle(Math.min(origin, ceiling), Math.max(origin, ceiling), "var(--track)", "capacity", side)
        );
        children.push(
          rectangle(
            side === "regen" ? 0 : ceiling,
            side === "regen" ? ceiling : 1,
            `url(#${pattern})`,
            "unavailable",
            side
          )
        );
      }
    }
    if (state.value !== null && state.value !== 0) {
      const endpoint = bounded(powerPosition(state.value));
      children.push(
        rectangle(
          Math.min(origin, endpoint),
          Math.max(origin, endpoint),
          state.value < 0 ? "var(--flow)" : "var(--good)",
          "measured"
        )
      );
      const limit = state.value < 0 ? state.drive : state.regen;
      if (state.excess && limit.kilowatts !== null) {
        const ceiling = bounded(powerPosition(state.value < 0 ? -limit.kilowatts : limit.kilowatts));
        children.push(rectangle(Math.min(ceiling, endpoint), Math.max(ceiling, endpoint), "var(--bad)", "excess"));
        children.push(
          rectangle(Math.min(ceiling, endpoint), Math.max(ceiling, endpoint), `url(#${excessPattern})`, "excess-hatch")
        );
      }
      if (powerPosition(state.value) < 0 || powerPosition(state.value) > 1) {
        const arrowPath = state.value < 0 ? "M-8 -5 -2 0 -8 5" : "M8 -5 2 0 8 5";
        children.push(
          tags.svg(
            {
              x: state.value < 0 ? "100%" : "0%",
              y: 11,
              width: 1,
              height: 1,
              overflow: "visible",
              "data-layer": "off-scale",
            },
            ...[4, 2].map(width =>
              tags.path({
                d: arrowPath,
                style: `fill:none;stroke:${width === 4 ? "var(--tile)" : "var(--fg)"}`,
                "stroke-width": width,
              })
            )
          )
        );
      }
    }
  }
  children.push(
    tags.rect({
      x: percent(origin),
      y: 2,
      width: 2,
      height: 18,
      transform: "translate(-1 0)",
      style: "fill:var(--tile)",
      "data-layer": "zero-gap",
    })
  );
  if (!state.charging) {
    for (const side of ["regen", "drive"]) {
      const limit = side === "drive" ? state.drive : state.regen;
      if (limit.kilowatts === null) continue;
      const position = bounded(powerPosition(side === "drive" ? -limit.kilowatts : limit.kilowatts));
      const correction = position === 0 ? 1 : position === 1 ? -1 : 0;
      for (const [width, color] of [
        [4, "var(--tile)"],
        [2, "var(--fg)"],
      ]) {
        children.push(
          tags.line({
            x1: percent(position),
            x2: percent(position),
            y1: 0,
            y2: 20,
            transform: `translate(${correction} 0)`,
            style: `stroke:${color}`,
            "stroke-width": width,
            "data-layer": width === 2 ? "ceiling" : "ceiling-halo",
            "data-side": side,
          })
        );
      }
    }
  }
  const firstTick = children.findIndex(element => element.getAttribute("data-layer") === "ceiling-halo");
  const band = children.splice(0, firstTick < 0 ? children.length : firstTick);
  return tags.svg(
    {
      class: "power-edge",
      height: 20,
      width: "100%",
      role: "img",
      "aria-label": description(state),
      "data-charging": String(state.charging),
    },
    tags.svg({ class: "power-band", width: "100%", height: 20 }, ...band),
    ...children
  );
}

/** @param {RidePowerState} state */
function description(state) {
  return state.charging
    ? `Signed power ${state.value ?? state.powerStatus} kW. Charging; riding limits inactive.`
    : `Fixed scale: 36 kW regen, 130 kW drive. Power ${state.value ?? state.powerStatus} kW. Drive limit ${state.drive.kilowatts === null ? state.drive.state : `${state.drive.kilowatts.toFixed(1)} kW`}; regen limit ${state.regen.kilowatts === null ? state.regen.state : `${state.regen.kilowatts.toFixed(1)} kW`}.`;
}

/** @param {string} id @param {string} color */
function hatch(id, color) {
  return tags.pattern(
    { id, patternUnits: "userSpaceOnUse", width: 8, height: 8 },
    tags.path({ d: "M-4 4 4 -4M0 8 8 0M4 12 12 4", style: `fill:none;stroke:${color}`, "stroke-width": HATCH_STROKE })
  );
}

/** @param {number} from @param {number} to @param {string} fill @param {string} layer @param {string} [side] */
function rectangle(from, to, fill, layer, side = "") {
  return tags.rect({
    x: percent(from),
    y: 2,
    width: percent(Math.max(0, to - from)),
    height: 18,
    style: `fill:${fill}`,
    "data-layer": layer,
    "data-side": side,
  });
}

/** @param {number} value */
function percent(value) {
  return `${value * 100}%`;
}
/** @param {number} value */
function bounded(value) {
  return Math.max(0, Math.min(1, value));
}
