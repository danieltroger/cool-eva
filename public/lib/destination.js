// @ts-check
import van from "../vendor/van-1.6.1.js";
import { hashForView, currentViewLabel } from "./router.js";
import { SETTINGS_PAGE_TITLES } from "./settings-map.js";
import { armed } from "./arming.js";

/** @typedef {"" | "settings" | "session" | "bike-information" | "battery-cooling" | "advanced-service"} Destination */
export const destination = van.state(/** @type {Destination} */ (""));
export const destinationSection = van.state("");
export const backDestinationName = van.state("Ride");
/** @type {(() => void) | undefined} */
let returnToOrigin;

/** @param {Destination} name @param {string} [section] @param {() => void} [onReturn] */
export function openDestination(name, section = "", onReturn) {
  if (!destination.rawVal) {
    returnToOrigin = onReturn;
  }
  const url = new URL(location.href);
  url.searchParams.set("panel", name);
  if (section) {
    url.searchParams.set("section", section);
  } else {
    url.searchParams.delete("section");
  }
  const backName = destination.rawVal
    ? destinationName(destination.rawVal, destinationSection.rawVal)
    : onReturn
      ? "Menu"
      : currentViewLabel();
  history.pushState({ coolEvaPanel: true, backName }, "", url);
  backDestinationName.val = backName;
  destination.val = name;
  destinationSection.val = section;
  armed.val = "";
  window.scrollTo(0, 0);
}

export function closeDestination() {
  if (history.state?.coolEvaPanel) {
    history.back();
    return;
  }
  const url = new URL(location.href);
  url.searchParams.delete("panel");
  url.searchParams.delete("section");
  history.replaceState(null, "", url);
  destination.val = "";
  destinationSection.val = "";
  armed.val = "";
  returnToOrigin?.();
}

export function startDestinationRouting() {
  readDestination();
  addEventListener("popstate", readDestination);
  addEventListener("hashchange", readDestination);
}

function readDestination() {
  const before = destination.rawVal;
  backDestinationName.val = history.state?.backName ?? currentViewLabel();
  const url = new URL(location.href);
  const name = url.searchParams.get("panel") ?? "";
  destination.val = ["settings", "session", "bike-information", "battery-cooling", "advanced-service"].includes(name)
    ? /** @type {Destination} */ (name)
    : "";
  destinationSection.val = url.searchParams.get("section") ?? "";
  armed.val = "";
  if (before && !destination.rawVal) {
    returnToOrigin?.();
  }
}

/** @param {import("./router.js").TabName} tab */
export function openRidingTab(tab) {
  openRidingView(tab);
}

/** Browser history preserves the actual menu origin; see docs/range-and-cells.md. @param {import("./router.js").ViewName} view */
export function openRidingView(view) {
  const backName = destination.rawVal ? destinationName() : currentViewLabel();
  const url = new URL(location.href);
  url.searchParams.delete("panel");
  url.searchParams.delete("section");
  url.hash = hashForView(view);
  history.pushState(
    view === "cells" ? { coolEvaSubview: true, menuOrigin: destination.rawVal !== "", backName } : null,
    "",
    url
  );
  destination.val = "";
  destinationSection.val = "";
  armed.val = "";
  dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
}

/** @param {Destination} [name] @param {string} [section] */
export function destinationName(name = destination.val, section = destinationSection.val) {
  if (name === "settings") return SETTINGS_PAGE_TITLES[section] ?? "Settings";
  return (
    /** @type {Record<string, string>} */ ({
      session: "Session",
      "bike-information": "Bike information",
      "battery-cooling": "Battery & cooling",
      "advanced-service": "Advanced service",
    })[name] ?? "Cool Eva"
  );
}
