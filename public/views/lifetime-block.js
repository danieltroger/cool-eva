// @ts-check
import van from "../vendor/van-1.6.1.js";
import { formatLifetimeValue, lifetimeError, lifetimeStats } from "../lib/lifetime.js";
import { ageInWords } from "../lib/format.js";

const { div } = van.tags;

export function LifetimeBlock() {
  return () => {
    const response = lifetimeStats.val;
    if (!response) {
      const failure = lifetimeError.val;
      return failure ? div({ class: "section" }, "Bike history · —") : div();
    }
    if (!response.reading) {
      return div({ class: "section" }, "Bike history · —");
    }
    const { statistics } = response.reading;
    const rows = statistics.rows;
    if (rows.length === 0) {
      return div();
    }
    return div(
      div({ class: "section" }, `Bike history · ${ageInWords(statistics.readAt)}`),
      div({ class: "raw-grid" }, ...rows.map(LifetimeTile))
    );
  };
}

/** Server scaling and missing/rejected states are retained; see docs/lifetime-battery-statistics.md.
 * @param {import("../../src/diagnostics/lifetime-stats.ts").LifetimeRow} row */
function LifetimeTile(row) {
  return div(
    {
      class: `raw${row.status === "missing" ? " stale" : ""}`,
      title: [...row.detail, row.note].filter(Boolean).join(" · "),
    },
    div({ class: "raw-key" }, row.label),
    div(
      { class: `raw-value${row.status === "rejected" ? " raw-fault" : ""}` },
      row.status === "rejected" ? "fault" : formatLifetimeValue(row)
    )
  );
}
