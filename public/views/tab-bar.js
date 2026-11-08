// @ts-check
import van from "../vendor/van-1.6.1.js";
import { TABS } from "../lib/router.js";
import { navigationTab, openRidingTab, ridingUrl } from "../lib/destination.js";
import { headlineState } from "../lib/fault-data.js";

export function TabBar() {
  return van.tags.nav(
    { class: "tabs", "aria-label": "Main screens" },
    ...TABS.map(tab =>
      van.tags.a(
        {
          class: () => `tab${navigationTab() === tab.name ? " on" : ""}`,
          href: ridingUrl(tab.name),
          "aria-current": () => (navigationTab() === tab.name ? "page" : "false"),
          onclick: (/** @type {MouseEvent} */ event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            openRidingTab(tab.name);
          },
        },
        TabSymbol(tab.name),
        van.tags.span(tab.label)
      )
    )
  );
}

/** @param {import("../lib/router.js").TabName} name */
function TabSymbol(name) {
  const tags = van.tags("http://www.w3.org/2000/svg");
  const paths = {
    ride: "M4 18a9 9 0 1 1 16 0M12 13l5-5M5 18h14",
    hypermile: "M20 6H3v12h17V6ZM22 10v4M7 10v4M11 10v4M15 10v4",
    charge: "M13 2 5 14h6l-1 8 9-13h-6z",
    faults: "m10 4-8 14a2 2 0 0 0 2 3h16a2 2 0 0 0 2-3L14 4a2 2 0 0 0-4 0zM12 9v5M12 17v.2",
    more: "",
  };
  return van.tags.span(
    { class: "tab-symbol" },
    tags.svg(
      {
        viewBox: "0 0 24 24",
        "aria-hidden": "true",
        fill: "none",
        stroke: "currentColor",
        "stroke-width": 1.6,
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
      },
      name === "more"
        ? [5, 12, 19].map(center => tags.circle({ cx: center, cy: 12, r: 1.5 }))
        : tags.path({ d: paths[name] }),
      name === "ride" ? tags.circle({ cx: 12, cy: 13, r: 1 }) : null
    ),
    name === "faults" ? FaultBadge : van.tags.span()
  );
}

function FaultBadge() {
  const state = headlineState();
  return state.kind === "active"
    ? van.tags.span({ class: "fault-badge", "aria-label": `${state.count} active faults` }, String(state.count))
    : van.tags.span();
}
