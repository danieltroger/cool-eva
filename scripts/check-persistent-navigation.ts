import assert from "node:assert/strict";
import { arm, armed } from "../public/lib/arming.js";
import { currentView, startRouting, showView } from "../public/lib/router.js";
import {
  destination,
  destinationSection,
  moreSection,
  navigationTab,
  openDestination,
  openRidingView,
  ridingUrl,
  startDestinationRouting,
} from "../public/lib/destination.js";

const environmentKeys = [
  "history",
  "location",
  "addEventListener",
  "dispatchEvent",
  "PopStateEvent",
  "window",
] as const;
const originalDescriptors = new Map(
  environmentKeys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
);
const listeners = new Map<string, (() => void)[]>();
let currentUrl = new URL("http://dashboard.invalid/?panel=settings&section=phone#ride/cooling");
const entries: { state: unknown; url: string }[] = [];

try {
  Object.defineProperties(globalThis, {
    location: { configurable: true, get: () => currentUrl },
    window: { configurable: true, value: { scrollTo: () => undefined } },
    history: {
      configurable: true,
      value: {
        state: null,
        pushState(state: unknown, _title: string, url: string | URL) {
          currentUrl = new URL(url, currentUrl);
          this.state = state;
          entries.push({ state, url: currentUrl.href });
        },
        replaceState(state: unknown, _title: string, url: string | URL) {
          currentUrl = new URL(url, currentUrl);
          this.state = state;
        },
      },
    },
    addEventListener: {
      configurable: true,
      value: (name: string, listener: () => void) => listeners.set(name, [...(listeners.get(name) ?? []), listener]),
    },
    dispatchEvent: {
      configurable: true,
      value: (event: Event) => {
        for (const listener of listeners.get(event.type) ?? []) {
          listener();
        }
        return true;
      },
    },
    PopStateEvent: { configurable: true, value: Event },
  });
  startRouting();
  startDestinationRouting();
  assert.equal(currentView(), "cooling");
  assert.equal(navigationTab(), "more", "Legacy panel links select More, whatever their underlying hash.");
  assert.equal(destinationSection.rawVal, "phone");
  assert.equal(moreSection(), "settings");

  for (const [panel, expected] of [
    ["bike-information", "bike"],
    ["advanced-service", "service"],
    ["settings", "settings"],
  ] as const) {
    arm("charge-stop");
    openDestination(panel);
    assert.equal(navigationTab(), "more");
    assert.equal(moreSection(), expected);
    assert.equal(currentUrl.hash, "#more");
    assert.equal(currentUrl.searchParams.get("panel"), panel);
    assert.equal(currentUrl.searchParams.has("section"), false);
    assert.equal(armed.rawVal, "", "Changing More sections discards pending write confirmation.");
  }
  openDestination("settings", "bike");
  const link = new URL(ridingUrl("cells"));
  assert.equal(link.hash, "#hypermile/cells");
  assert.equal(link.searchParams.has("panel"), false, "Modified-click targets cannot retain the old destination.");
  assert.equal(link.searchParams.has("section"), false);
  arm("charge-stop");
  openRidingView("cells");
  assert.equal(destination.rawVal, "");
  assert.equal(destinationSection.rawVal, "");
  assert.equal(navigationTab(), "hypermile");
  assert.equal(currentView(), "cells");
  assert.equal(currentUrl.searchParams.has("panel"), false);
  assert.equal(currentUrl.searchParams.has("section"), false);
  assert.equal(armed.rawVal, "");

  const count = entries.length;
  arm("charge-stop");
  openRidingView("cells");
  assert.equal(entries.length, count, "Re-selecting the actual view cannot add a duplicate Back entry.");
  assert.equal(armed.rawVal, "charge-stop", "A no-op navigation preserves current confirmation context.");
  showView("all");
  assert.equal(navigationTab(), "more");
  assert.equal(moreSection(), "service", "The legacy signals view belongs under Service.");
  showView("more");
  assert.equal(moreSection(), "settings");
  assert.equal(currentUrl.hash, "#more");
  console.log(
    "✓ persistent navigation restores legacy panels, groups More, clears destination URLs, preserves no-op history and disarms real changes"
  );
} finally {
  armed.val = "";
  for (const key of environmentKeys) {
    const descriptor = originalDescriptors.get(key);
    if (descriptor) {
      Object.defineProperty(globalThis, key, descriptor);
    } else {
      Reflect.deleteProperty(globalThis, key);
    }
  }
}
