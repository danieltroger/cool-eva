// @ts-check
// Header and persistent navigation: docs/dashboard-navigation.md.
import van from "../vendor/van-1.6.1.js";
import { connection } from "../lib/store.js";
import { destination, destinationSection, moreSection, navigationTab, openDestination } from "../lib/destination.js";
import { currentView, showView, hashForView, TABS } from "../lib/router.js";

const { a, div, header, nav, span } = van.tags;

export function Header() {
  return header(
    { class: "header layout-between" },
    div(
      { class: "app-title layout-row" },
      span(() => TABS.find(tab => tab.name === navigationTab())?.label ?? "Ride"),
      span({ class: () => `dot ${connection.val}`, role: "img", "aria-label": () => connection.val })
    ),
    () => HeaderSwitch()
  );
}

function HeaderSwitch() {
  const tab = navigationTab();
  if (tab === "more") {
    return nav(
      { class: "header-switch layout-row", "aria-label": "More views" },
      .../** @type {const} */ ([
        ["Settings", "settings", "settings"],
        ["Bike", "bike", "bike-information"],
        ["Service", "service", "advanced-service"],
      ]).map(([label, section, panel]) =>
        a(
          {
            href: destinationUrl(panel),
            "data-more": section,
            "aria-current": () => (moreSection() === section ? "page" : "false"),
            onclick: (/** @type {MouseEvent} */ event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              if (destination.rawVal === panel && !destinationSection.rawVal) return;
              if (panel === "settings" && !destination.rawVal && !destinationSection.rawVal && currentView() === "more")
                return;
              openDestination(panel);
            },
          },
          label
        )
      )
    );
  }
  const views = tab === "ride" ? ["ride", "cooling"] : tab === "hypermile" ? ["hypermile", "cells"] : [];
  if (views.length === 0) return span();
  return nav(
    { class: "header-switch layout-row", "aria-label": `${tab === "hypermile" ? "Range" : "Ride"} views` },
    .../** @type {("ride" | "cooling" | "hypermile" | "cells")[]} */ (views).map(view =>
      a(
        {
          href: hashForView(view),
          "data-view": view,
          "aria-current": () => (currentView() === view ? "page" : "false"),
          onclick: (/** @type {MouseEvent} */ event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            showView(view);
          },
        },
        view === "hypermile" ? "Range" : view[0].toUpperCase() + view.slice(1)
      )
    )
  );
}

/** @param {import("../lib/destination.js").Destination} panel */
function destinationUrl(panel) {
  const url = new URL(location.href);
  url.hash = "#more";
  url.searchParams.set("panel", panel);
  url.searchParams.delete("section");
  return url.href;
}
