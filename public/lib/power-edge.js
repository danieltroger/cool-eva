// @ts-check
// Fixed scale, inset geometry and inactive charging state: docs/ride-power.md.
import van from "../vendor/van-1.6.1.js";
import { powerPosition } from "./ride-power-state.js";

const tags = van.tags("http://www.w3.org/2000/svg");
let sequence = 0;
/** @typedef {import("./ride-power-state.js").RidePowerState} RidePowerState */

/** @param {RidePowerState} state @param {import("./ride-power-display.js").RidePowerDisplay} display */
export function powerEdge(state, display) {
  const clipId = `power-bar-${++sequence}`;
  const origin = powerPosition(0);
  const layers = [rectangle(0, 1, "var(--track)", "base")];
  if (!state.charging && state.value !== null && state.value !== 0) {
    const endpoint = bounded(powerPosition(state.value));
    layers.push(
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
      layers.push(rectangle(Math.min(ceiling, endpoint), Math.max(ceiling, endpoint), "var(--bad)", "excess"));
    }
  }
  if (!state.charging) {
    for (const side of ["regen", "drive"]) {
      const limit = side === "drive" ? state.drive : state.regen;
      const position =
        limit.kilowatts === null
          ? origin
          : bounded(powerPosition(side === "drive" ? -limit.kilowatts : limit.kilowatts));
      layers.push(
        tags.line({
          x1: percent(side === "regen" ? 0 : position),
          x2: percent(side === "regen" ? position : 1),
          y1: 12,
          y2: 12,
          style: "stroke:var(--sub)",
          "stroke-width": 2,
          "stroke-dasharray": "4 4",
          "data-layer": limit.kilowatts === null ? "unknown" : "locked",
          "data-side": side,
        })
      );
    }
  }
  const ticks = state.charging
    ? []
    : ["regen", "drive"].flatMap(side => {
        const limit = side === "drive" ? state.drive : state.regen;
        return limit.kilowatts === null
          ? []
          : [
              tags.line({
                x1: percent(bounded(powerPosition(side === "drive" ? -limit.kilowatts : limit.kilowatts))),
                x2: percent(bounded(powerPosition(side === "drive" ? -limit.kilowatts : limit.kilowatts))),
                y1: 3,
                y2: 21,
                style: "stroke:var(--fg)",
                "stroke-width": 2,
                "data-layer": "ceiling",
                "data-side": side,
              }),
            ];
      });
  return tags.svg(
    {
      class: "power-edge",
      width: "100%",
      height: 24,
      role: "img",
      "aria-label": description(state, display),
      "aria-hidden": String(state.charging),
      "data-charging": String(state.charging),
      style: `visibility:${state.charging ? "hidden" : "visible"}`,
    },
    tags.defs(tags.clipPath({ id: clipId }, tags.rect({ y: 6, width: "100%", height: 12, rx: 6 }))),
    tags.g({ "clip-path": `url(#${clipId})`, class: "power-band" }, ...layers),
    ...[
      [1, 5],
      [19, 23],
    ].map(([start, end]) =>
      tags.line({
        x1: percent(origin),
        x2: percent(origin),
        y1: start,
        y2: end,
        style: "stroke:var(--sub)",
        "stroke-width": 1,
        "data-layer": "zero-reference",
      })
    ),
    ...ticks
  );
}

/** @param {RidePowerState} state @param {import("./ride-power-display.js").RidePowerDisplay} display */
function description(state, display) {
  const power = `${display.label} ${state.value === null ? state.powerStatus : `${display.magnitude} kW`}`;
  return state.charging
    ? `${power}. Riding limits inactive.`
    : `Fixed scale: 36 kW regen, 130 kW drive. ${power}. Drive limit ${state.drive.kilowatts === null ? state.drive.state : `${state.drive.kilowatts.toFixed(1)} kW`}; regen limit ${state.regen.kilowatts === null ? state.regen.state : `${state.regen.kilowatts.toFixed(1)} kW`}.`;
}

/** @param {number} from @param {number} to @param {string} fill @param {string} layer */
function rectangle(from, to, fill, layer) {
  return tags.rect({
    x: percent(from),
    y: 6,
    width: percent(Math.max(0, to - from)),
    height: 12,
    style: `fill:${fill}`,
    "data-layer": layer,
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
