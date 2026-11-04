// @ts-check
// Strip scaling, slot order and browser-history origins: docs/range-and-cells.md.
import van from "../vendor/van-1.6.1.js";
import { chartTick, peek } from "../lib/store.js";
import { readingStatus } from "../lib/reading-status.js";
import { cellSnapshot } from "../lib/cell-snapshot.js";
import { CELL_COUNT, MODULE_COUNT } from "../lib/cells.js";
import { barStrip } from "../lib/svg.js";
import { SubTabs } from "../lib/sub-tabs.js";
import { showView } from "../lib/router.js";
import * as colors from "../lib/colors.js";

const { button, div, h2, span } = van.tags;

export function CellsView() {
  return div(
    { class: "view cells-view", "data-view": "cells" },
    SubTabs("hypermile"),
    button(
      {
        class: "cells-back",
        onclick: () => {
          if (history.state?.coolEvaSubview) {
            history.back();
          } else {
            showView("hypermile");
          }
        },
      },
      `‹ ${history.state?.coolEvaSubview ? history.state.backName : "Range"}`
    ),
    () => {
      chartTick.val;
      return CellsContent();
    }
  );
}

function CellsContent() {
  const snapshot = cellSnapshot(peek, key => readingStatus(key, true));
  const padding = Math.max(((snapshot.high ?? 0) - (snapshot.low ?? 0)) * 0.25, 5);
  const status = `${snapshot.fresh} of ${CELL_COUNT} fresh${snapshot.fault ? ` · ${snapshot.fault} fault` : ""}${snapshot.stale ? ` · ${snapshot.stale} stale` : ""}${snapshot.missing ? ` · ${snapshot.missing} missing` : ""}`;
  return div(
    { class: "cells-content" },
    div(
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
        span({ "data-weakest": "" }, `Weakest ${snapshot.weakest === null ? "unknown" : `#${snapshot.weakest}`}`),
        span(
          { "data-strongest": "" },
          `Strongest ${snapshot.strongest === null ? "unknown" : `#${snapshot.strongest}`}`
        )
      ),
      div(
        { class: "sub" },
        "Height shows the observed spread; colour is the gap below the best cell. Outlines mark unavailable readings."
      )
    ),
    ...Array.from({ length: MODULE_COUNT }, (_, index) =>
      div(
        { class: "tile cell-module", "data-module": index + 1 },
        h2(`Module ${index + 1}`),
        div(
          { class: "cell-values" },
          ...snapshot.cells
            .filter(cell => cell.module === index + 1)
            .map(cell =>
              div(
                { class: `cell-reading ${cell.state}`, "data-cell-key": cell.key },
                div({ class: "sub" }, `#${cell.position} · cell ${cell.cell}`),
                div(
                  {
                    class: "cell-number",
                    style: `color:${cell.state === "fault" ? colors.BAD : cell.value === null ? colors.MUTED : colors.CALM}`,
                  },
                  cell.value === null
                    ? cell.state === "missing"
                      ? "—"
                      : cell.state
                    : span(String(cell.value), span({ class: "unit" }, "mV"))
                )
              )
            )
        )
      )
    )
  );
}
