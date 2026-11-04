import assert from "node:assert/strict";
import { arm, armed } from "../public/lib/arming.js";
import { advanceTab, currentTab, showTab, startRouting } from "../public/lib/router.js";

const environmentKeys = ["history", "location", "addEventListener"] as const;
const originalDescriptors = new Map(
  environmentKeys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
);
const listeners = new Map<string, (() => void)[]>();
let currentHash = "#charge";

try {
  Object.defineProperties(globalThis, {
    location: {
      configurable: true,
      value: {
        get hash() {
          return currentHash;
        },
      },
    },
    history: {
      configurable: true,
      value: {
        pushState: (_state: unknown, _title: string, url: string) => {
          currentHash = url;
        },
        replaceState: (_state: unknown, _title: string, url: string) => {
          currentHash = url;
        },
      },
    },
    addEventListener: {
      configurable: true,
      value: (name: string, listener: () => void) => {
        listeners.set(name, [...(listeners.get(name) ?? []), listener]);
      },
    },
  });

  startRouting();
  arm("charge-stop");
  showTab("all");
  assert.equal(currentTab(), "all");
  assert.equal(armed.val, "", "A tab change must discard its previous action confirmation.");
  showTab("charge");
  assert.equal(armed.val, "", "Returning to Charge must not restore its old confirmation.");

  arm("charge-stop");
  advanceTab();
  assert.equal(currentTab(), "all");
  assert.equal(armed.val, "", "Gesture navigation must also disarm.");

  for (const eventName of ["popstate", "hashchange"]) {
    arm("charge-stop");
    currentHash = currentTab() === "charge" ? "#all" : "#charge";
    const callbacks = listeners.get(eventName);
    assert.ok(callbacks?.length, `${eventName} must have a route listener.`);
    for (const listener of callbacks) {
      listener();
    }
    assert.equal(armed.val, "", `${eventName} must discard the old confirmation.`);
    assert.equal(`#${currentTab()}`, currentHash);
  }
  console.log("✓ route changes disarm on tab taps, gestures, Back/Forward and hash changes");
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
