// @ts-check
import van from "../vendor/van-1.6.1.js";
import { ROUTES, currentView, showView } from "./router.js";

/** @param {import("./router.js").TabName} parent */
export function SubTabs(parent) {
  return van.tags.div(
    { class: "sub-tabs span2", role: "tablist", "aria-label": "Views" },
    ...ROUTES.filter(route => route.tab === parent).map(route =>
      van.tags.button(
        {
          role: "tab",
          "data-view": route.name,
          "aria-selected": () => String(currentView() === route.name),
          class: () => `sub-tab${currentView() === route.name ? " on" : ""}`,
          onclick: () => showView(route.name),
        },
        route.label
      )
    )
  );
}
