// @ts-check
import van from "../vendor/van-1.6.1.js";
import { formatLifetimeValue, lifetimeError, lifetimeStats } from "../lib/lifetime.js";
import { ageInWords } from "../lib/format.js";

const { div, span } = van.tags;

export function LifetimeBlock() {
  return () => {
    const needle = "";
    const response = lifetimeStats.val;
    if (!response) {
      const failure = lifetimeError.val;
      return failure && needle === "" ? div({ class: "section" }, `lifetime · ${failure}`) : div();
    }
    if (!response.reading) {
      // Not an error: most Pis have never taken one. Says how — and since #177 that is a
      // button on this same phone, so the in-app path leads and the shell command is a
      // footnote for a Pi whose service is stopped. It read the other way round from
      // #177 until #187.
      return needle === ""
        ? div(
            div({ class: "section" }, "lifetime · never read"),
            div(
              { class: "raw raw-notice" },
              div({ class: "raw-sub" }, response.howToRead),
              div({ class: "raw-sub raw-footnote" }, `service stopped: ${response.howToReadWithServiceStopped}`)
            )
          )
        : div();
    }
    const { statistics, source } = response.reading;
    const rows = statistics.rows.filter(row => row.key.includes(needle) || row.label.includes(needle));
    if (rows.length === 0) {
      return div();
    }
    return div(
      div(
        { class: "section" },
        `lifetime · read ${ageInWords(statistics.readAt)}${statistics.complete ? "" : " · INCOMPLETE"}` +
          `${source === "service" ? "" : " · service stopped"}`
      ),
      div({ class: "raw-grid" }, ...rows.map(LifetimeTile))
    );
  };
}

/**
 * One lifetime number, in the same tile the grid uses.
 *
 * The note is the load-bearing half for two of these rows — `charge moved` carries a
 * raw count and the reason it is not an amount of charge — so it is rendered at the
 * same weight as a rejected reading rather than tucked away.
 *
 * @param {import("../../src/diagnostics/lifetime-stats.ts").LifetimeRow} row
 */
function LifetimeTile(row) {
  return div(
    { class: `raw${row.status === "rejected" || row.status === "missing" ? " stale" : ""}` },
    div({ class: "raw-key" }, row.label),
    div({ class: "raw-value" }, formatLifetimeValue(row)),
    row.detail.length > 0 ? div({ class: "raw-sub" }, row.detail.join(" · ")) : span(),
    row.note ? div({ class: row.status === "rejected" ? "raw-fault" : "raw-sub" }, row.note) : span()
  );
}
