// @ts-check
// Counts stay complete; only the two previews are bounded. See docs/fault-report.md.
import van from "../vendor/van-1.6.1.js";
import { chartTick, valueOf } from "../lib/store.js";
import { monotonicNow } from "../lib/clock.js";
import { isExpected } from "../lib/expected-faults.js";
import { openRidingView } from "../lib/destination.js";
import { loadFaultData, collectFaults, headlineState, headlineValue, headlineColor } from "../lib/fault-data.js";
import { historyOf, describeLastSeen, rawLabel } from "../lib/fault-history.js";
import * as colors from "../lib/colors.js";

const { button, div } = van.tags;
/** @typedef {import("../lib/fault-data.js").FaultRow} FaultRow */

export function FaultsView() {
  loadFaultData();
  return div(
    { class: "view riding-view faults-view" },
    div({ class: "riding-heading" }, "Faults", div({ class: "sub" }, "Active and recent")),
    div(
      { class: "tile faults-count" },
      div({ class: "label" }, () => (headlineState().kind === "active" ? "Faults active now" : "Faults")),
      div({ class: "value faults-number", style: () => `color:${headlineColor()}` }, headlineValue),
      div({ class: "sub", "data-fault-split": "" }, expectedSplit)
    ),
    () => div({ class: "fault-previews" }, ...collectFaults().slice(0, 2).map(FaultPreview)),
    div(
      { class: "fault-report-action" },
      button({ class: "settings-button", onclick: () => openRidingView("fault-report") }, () => {
        const state = headlineState();
        const stored = valueOf("dtc_count");
        return `Full report · ${state.kind === "unknown" ? "?" : state.count} ${state.kind === "recent" ? "recent" : "active"} / ${stored === null ? "?" : stored} stored →`;
      })
    ),
    div({ class: "sub faults-footnote" }, () => {
      const omitted = Math.max(0, collectFaults().length - 2, headlineState().count - 2);
      return `${omitted} more in full report. History starts on page load. Read when parked.`;
    })
  );
}

function expectedSplit() {
  const state = headlineState();
  if (state.kind === "unknown") return "Fault list unavailable — this is not “no faults”";
  if (state.kind === "clear") return "Nothing in the bike’s active list";
  const faults = collectFaults().filter(fault => state.kind === "recent" || fault.active);
  const expected = faults.filter(fault => isExpected(fault.codeKey)).length;
  const unknown = valueOf("dtc_unrecognised_count");
  return `${state.count - expected} unexpected · ${expected} expected${state.kind === "recent" ? " · recent, not active" : ""}${unknown ? ` · ${unknown} unrecognised` : ""}`;
}

/** @param {FaultRow} fault */
function FaultPreview(fault) {
  return div(
    {
      class: "tile fault-preview",
      "data-fault-key": fault.key,
      style: `border-left-color:${fault.active ? colors.BAD : colors.MUTED}`,
    },
    div(
      { class: "label", style: `color:${fault.active ? colors.BAD : colors.MUTED}` },
      `${fault.row?.obdCode ?? rawLabel(fault.key)} · ${fault.active ? "Active" : "Recent"} · ${isExpected(fault.codeKey) ? "expected" : "unexpected"}`
    ),
    div(
      { class: "fault-preview-name" },
      fault.row?.description ?? "Not in Energica's code table — a code the type-approval document does not list."
    ),
    div({ class: "sub" }, () => {
      chartTick.val;
      return fault.active
        ? "Reported by the motorcycle"
        : describeLastSeen(historyOf(fault.key, monotonicNow()).lastSeenMs);
    })
  );
}
