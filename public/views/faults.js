// @ts-check
// One expandable row per code, with its own recorded values: docs/fault-report.md.
import van from "../vendor/van-1.6.1.js";
import {
  loadFaultData,
  collectFaults,
  headlineState,
  stored,
  storedError,
  refreshStoredCodes,
} from "../lib/fault-data.js";
import { chartTick } from "../lib/store.js";
import { activeFaultRows, storedFaultRows } from "../lib/fault-rows.js";
import { isExpected, ExpectedCheckbox } from "../lib/expected-faults.js";
import { RecordedValues, loadRecordedValues } from "./recorded-values.js";

export function FaultsView() {
  loadFaultData();
  void loadRecordedValues();
  const active = () => activeFaultRows(collectFaults());
  const current = FaultRows(active);
  const history = FaultRows(() => storedFaultRows(stored.val, active()));
  return div(
    { class: "view faults-view layout-page" },
    span({ class: "label" }, "Active"),
    () => {
      const state = headlineState();
      return state.kind === "unknown" || (state.kind === "active" && active().length < state.count)
        ? span({ class: "fault-sub", "data-active-state": "unknown" }, "Fault list unavailable")
        : span({ hidden: true });
    },
    current,
    details(
      { class: "layout-accordion stored-faults", ontoggle: () => void refreshStoredCodes() },
      summary(span({ class: "fault-title" }, "Stored faults")),
      div(
        { class: "layout-accordion-body" },
        () => {
          chartTick.val;
          void refreshStoredCodes();
          const snapshot = stored.val;
          if (!snapshot)
            return span(
              { class: "fault-sub" },
              storedError.val ? "Stored faults unavailable" : "Reading stored faults…"
            );
          return snapshot.stored.state === "codes"
            ? span({ hidden: true })
            : span({ class: "fault-sub" }, "Stored faults unavailable");
        },
        history
      )
    )
  );
}

const { details, summary, div, span } = van.tags;
/** @typedef {import("../lib/fault-rows.js").FaultIdentity} FaultIdentity */

/** @param {()=>FaultIdentity[]} readRows */
function FaultRows(readRows) {
  const rows = van.derive(() => JSON.stringify(readRows()));
  /** @type {Map<string,HTMLDetailsElement>} */
  const cache = new Map();
  return (/** @type {Node|undefined} */ previous) => {
    // Property derives belong to this wrapper; replacing it strands reused rows' bindings.
    const container = previous instanceof HTMLDivElement ? previous : div({ class: "layout-stack fault-list" });
    const entries = /** @type {FaultIdentity[]} */ (JSON.parse(rows.val));
    const identities = new Set(entries.map(row => JSON.stringify(row)));
    for (const identity of cache.keys()) {
      if (!identities.has(identity)) {
        cache.delete(identity);
      }
    }
    container.replaceChildren(
      ...entries.map(row => {
        const identity = JSON.stringify(row);
        let element = cache.get(identity);
        if (!element) {
          element = FaultDisclosure(row);
          cache.set(identity, element);
        }
        return element;
      })
    );
    return container;
  };
}

/** @param {FaultIdentity} row */
function FaultDisclosure(row) {
  return details(
    {
      class: () => `layout-accordion fault-row${isExpected(row.key) ? " expected" : ""}`,
      "data-code": row.code,
      "data-fault-key": row.key ?? "",
    },
    summary(
      span(
        { class: "layout-compact-stack fault-summary" },
        span({ class: "fault-title" }, row.description),
        span({ class: "fault-tiny" }, () => `${row.code}${isExpected(row.key) ? " · Expected" : ""}`)
      )
    ),
    div(
      { class: "layout-accordion-body" },
      row.key ? ExpectedCheckbox(row.key, row.code) : null,
      row.key ? RecordedValues(row.key) : span({ class: "fault-sub" }, "Could not read this record.")
    )
  );
}
