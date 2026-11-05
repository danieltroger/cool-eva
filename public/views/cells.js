// @ts-check
// Strip scaling, slot order and browser-history origins: docs/range-and-cells.md.
import van from "../vendor/van-1.6.1.js";
import { chartTick, peek } from "../lib/store.js";
import { freshValue, readingStatus, statusWord } from "../lib/reading-status.js";
import { cellSnapshot } from "../lib/cell-snapshot.js";
import { cellVoltageLayout, CELL_COUNT, MODULE_COUNT } from "../lib/cells.js";
import { barStrip } from "../lib/svg.js";
import { SubTabs } from "../lib/sub-tabs.js";
import { ringFor } from "../lib/ring.js";
import { monotonicNow } from "../lib/clock.js";
import { sparkline } from "../lib/svg.js";
import * as colors from "../lib/colors.js";

const { button, div, h2, span } = van.tags;

export function CellsView() {
  return div(
    { class: "view cells-view", "data-view": "cells" },
    SubTabs("hypermile"),
    ...(history.state?.menuOrigin
      ? [
          button(
            {
              class: "cells-back",
              onclick: () => history.back(),
            },
            `‹ ${history.state.backName}`
          ),
        ]
      : []),
    CellsContent()
  );
}

function CellsContent() {
  const slots = cellVoltageLayout();
  return div(
    { class: "cells-content" },
    () => {
      chartTick.val;
      return CellsOverview();
    },
    SpreadHistory(),
    ...Array.from({ length: MODULE_COUNT }, (_, index) =>
      div(
        { class: "tile cell-module", "data-module": index + 1 },
        h2(`Module ${index + 1}`),
        div({ class: "cell-values" }, ...slots.filter(cell => cell.module === index + 1).map(CellReading))
      )
    )
  );
}

function CellsOverview() {
  const snapshot = cellSnapshot(peek, key => readingStatus(key, true));
  const padding = Math.max(((snapshot.high ?? 0) - (snapshot.low ?? 0)) * 0.25, 5);
  const status = `${snapshot.fresh} of ${CELL_COUNT} fresh${snapshot.fault ? ` · ${snapshot.fault} fault` : ""}${snapshot.stale ? ` · ${snapshot.stale} stale` : ""}${snapshot.missing ? ` · ${snapshot.missing} missing` : ""}`;
  return div(
    { class: "tile cells-overview" },
    h2("Battery cells"),
    div({ class: "sub", "data-cell-count": "" }, status),
    div(
      { role: "img", "aria-label": `${CELL_COUNT} physical cell positions in pack order. ${status}.` },
      barStrip({
        bars: snapshot.cells.map(cell => ({
          key: cell.key,
          state: cell.state,
          value: cell.value,
          color:
            cell.state === "fault"
              ? colors.BAD
              : cell.value === null
                ? colors.MUTED
                : colors.spread((snapshot.high ?? 0) - cell.value),
        })),
        low: (snapshot.low ?? 0) - padding,
        high: (snapshot.high ?? 1) + padding,
      })
    ),
    div(
      { class: "sub", "data-cell-extremes": "" },
      snapshot.low === null
        ? "Cell span unavailable"
        : `${snapshot.low} – ${snapshot.high} mV · observed span ${(snapshot.high ?? 0) - snapshot.low} mV`
    ),
    div(
      { class: "cells-identities" },
      span({ "data-weakest": "" }, `Weakest position ${snapshot.weakest ?? "unknown"}`),
      span({ "data-strongest": "" }, `Strongest position ${snapshot.strongest ?? "unknown"}`)
    ),
    div(
      { class: "sub" },
      "Positions 1–81 follow pack order. Height shows the observed spread; colour is the gap below the best cell. Outlines mark unavailable readings."
    )
  );
}

/** @param {ReturnType<typeof cellVoltageLayout>[number]} cell */
function CellReading(cell) {
  return div(
    {
      class: () => {
        chartTick.val;
        return `cell-reading ${readingStatus(cell.key, true)}`;
      },
      "data-cell-key": cell.key,
    },
    div({ class: "sub" }, `Position ${cell.position} · cell ${cell.cell}`),
    div(
      {
        class: "cell-number",
        style: () => {
          chartTick.val;
          const state = readingStatus(cell.key, true);
          return `color:${state === "fault" ? colors.BAD : state === "fresh" ? colors.CALM : colors.MUTED}`;
        },
      },
      () => {
        chartTick.val;
        const state = readingStatus(cell.key, true);
        const value = freshValue(cell.key, true);
        return value === null ? statusWord(state) : span(String(value), span({ class: "unit" }, "mV"));
      }
    )
  );
}

function SpreadHistory() {
  return div(
    { class: "tile cell-spread-history" },
    div({ class: "label" }, "Cell spread history"),
    div({ class: "value" }, () => {
      chartTick.val;
      const state = readingStatus("cell_spread_mv", true);
      const value = state === "fresh" ? peek("cell_spread_mv") : null;
      return value === null ? statusWord(state) : `${Math.round(value)} mV`;
    }),
    () => {
      chartTick.val;
      const fresh = readingStatus("cell_spread_mv", true) === "fresh";
      return sparkline({
        values: fresh ? ringFor("cell_spread_mv").since(600_000, monotonicNow()).values : [],
        color: colors.spread(fresh ? peek("cell_spread_mv") : null),
        minSpan: 10,
      });
    },
    div({ class: "sub" }, "last 10 min")
  );
}
