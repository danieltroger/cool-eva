// @ts-check
import van from "../vendor/van-1.6.1.js";
import { chartTick, connection, faultState, peek, signalState } from "../lib/store.js";
import { readingStatus } from "../lib/reading-status.js";
import { reading } from "../lib/format.js";
import { serviceCatalogue } from "../lib/service-client.js";
import { serviceGroupLabel } from "../lib/parameter-backup.js";

/** @typedef {import("../../src/http/service-catalogue.ts").ServiceSignal} ServiceSignal */

/** @param {boolean} [open] */
export function ServiceSignals(open = false) {
  const query = van.state("");
  return details(
    { class: "layout-accordion all-signals", open },
    summary(span({ class: "service-title" }, "Current CAN values")),
    div(
      { class: "layout-accordion-body" },
      input({
        class: "service-input",
        type: "search",
        name: "signal-search",
        autocomplete: "off",
        placeholder: "Find a signal…",
        "aria-label": "Find a signal",
        oninput: (/** @type {Event} */ event) => {
          if (event.target instanceof HTMLInputElement) {
            query.val = event.target.value.toLowerCase().trim();
          }
        },
      }),
      () => {
        const signals = serviceCatalogue.val?.signals ?? [];
        const groups = [...new Set(signals.map(signal => signal.group))].sort();
        return div(
          { class: "layout-compact-stack" },
          groups.map(group =>
            SignalGroup(
              group,
              signals.filter(signal => signal.group === group),
              query
            )
          )
        );
      },
      span(
        {
          class: "service-sub",
          hidden: () => serviceCatalogue.val?.signals.some(signal => matchesSignal(signal, query.val)) ?? true,
        },
        "No matching signals"
      )
    )
  );
}

const { details, div, input, span, summary } = van.tags;

/** @param {string} group @param {ServiceSignal[]} signals @param {import("../vendor/van-1.6.1.js").State<string>} query */
function SignalGroup(group, signals, query) {
  return details(
    {
      class: "service-group",
      hidden: () => !signals.some(signal => matchesSignal(signal, query.val)),
      open: () => query.val !== "" && signals.some(signal => matchesSignal(signal, query.val)),
    },
    summary({ class: "layout-list-row" }, serviceGroupLabel(group)),
    div(
      { class: "layout-compact-stack signal-list" },
      signals.map(signal =>
        div(
          { class: "signal-row", hidden: () => !matchesSignal(signal, query.val), "data-signal": signal.key },
          span(signal.key),
          span(
            {
              class: () =>
                `signal-reading${signalStatus(signal.key) === "fault" ? " bad" : signalStatus(signal.key) === "stale" ? " stale" : ""}`,
            },
            () => {
              if (signalStatus(signal.key) === "fault") {
                return "fault";
              }
              const value = peek(signal.key);
              return value === null ? "—" : `${reading(value)}${signal.unit ? ` ${signal.unit}` : ""}`;
            }
          )
        )
      )
    )
  );
}

/** @param {ServiceSignal} signal @param {string} query */
function matchesSignal(signal, query) {
  return `${signal.key} ${signal.group}`.toLowerCase().includes(query);
}

/** @param {string} key */
function signalStatus(key) {
  signalState(key).val;
  faultState(key).val;
  connection.val;
  chartTick.val;
  return readingStatus(key, true);
}
