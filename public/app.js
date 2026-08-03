// @ts-check

import van from "./vendor/van-1.6.1.js";
import { chartTick, connect, connection, peek, signalState } from "./lib/store.js";
import { headroomMvSampled, isChargingSampled } from "./lib/derive.js";
import { updateDwell } from "./lib/dwell.js";
import { updateTrip } from "./lib/trip.js";
import { RideView } from "./views/ride.js";
import { HypermileView } from "./views/hypermile.js";
import { ChargeView } from "./views/charge.js";
import { AllView } from "./views/all.js";
import { FaultsView } from "./views/faults.js";
import { Sheet, hasTroubleCodes, refreshStatus, sheetOpen } from "./views/sheet.js";
import { monotonicNow } from "./lib/clock.js";

const { button, div, span } = van.tags;

// Shell: header, the current view, the tab bar, and the rules for when the bike
// gets to choose the view instead of you.

/** @typedef {"ride" | "hypermile" | "charge" | "all" | "faults"} ViewName */

const TABS = /** @type {const} */ ([
  { name: "ride", label: "Ride" },
  { name: "hypermile", label: "Hypermile" },
  { name: "charge", label: "Charge" },
  { name: "all", label: "All" },
  { name: "faults", label: "Faults" },
]);

const view = van.state(/** @type {ViewName} */ ("ride"));

/** SOC at or below which the hypermiling screen takes over, as requested. */
const HYPERMILE_SOC = 5;

/**
 * …or this little left in the weakest cell, whichever happens first. SOC near
 * empty comes from an OCV table that was never re-characterised for these cells
 * (HYPERMILING.md §1), so it cannot be the only thing that triggers the screen
 * that exists precisely because SOC is untrustworthy down there.
 */
const HYPERMILE_HEADROOM_MV = 150;

function App() {
  return div(
    Header(),
    () => {
      switch (view.val) {
        case "hypermile":
          return HypermileView();
        case "charge":
          return ChargeView();
        case "all":
          return AllView();
        case "faults":
          return FaultsView();
        default:
          return RideView();
      }
    },
    TabBar(),
    Sheet()
  );
}

function Header() {
  return div(
    { class: "header" },
    button(
      {
        class: "menu",
        onclick: () => {
          sheetOpen.val = true;
          void refreshStatus();
        },
      },
      // The Faults tab carries the warning now, and it leads somewhere that names
      // the code. Two ⚠ for one fault is how a warning stops being read.
      "☰"
    ),
    span({ class: "brand" }, "Cool Eva"),
    div(
      { class: "status" },
      span({ class: () => `dot ${connection.val}` }),
      span(() => (connection.val === "live" ? "live" : connection.val === "connecting" ? "connecting" : "offline"))
    )
  );
}

function TabBar() {
  return div(
    { class: "tabs" },
    ...TABS.map(tab =>
      button(
        {
          class: () => `tab${view.val === tab.name ? " on" : ""}`,
          onclick: () => {
            view.val = tab.name;
          },
        },
        // The Faults tab carries the warning itself, so a code that appears mid-ride
        // is visible without giving up any space on the screen you are looking at.
        tab.name === "faults" ? () => (hasTroubleCodes() ? `⚠ ${tab.label}` : tab.label) : tab.label
      )
    )
  );
}

/**
 * Switch views when the bike's state changes, but only on the edge — the moment
 * charging starts, or the moment the pack drops into hypermiling territory.
 *
 * Edge-triggered rather than continuous on purpose: a rule that keeps forcing the
 * view fights the rider. Once it has moved you, you can move back and it stays put
 * until the condition next changes.
 */
let wasCharging = false;
let wasCritical = false;

function autoFocus() {
  const charging = isChargingSampled();
  if (charging && !wasCharging) {
    view.val = "charge";
  }
  // Leaving the charger takes you back to the riding screen, but only if you are
  // still looking at the one it moved you to.
  if (!charging && wasCharging && view.val === "charge") {
    view.val = "ride";
  }
  wasCharging = charging;

  const soc = peek("soc");
  const headroom = headroomMvSampled();
  const critical = (soc != null && soc <= HYPERMILE_SOC) || (headroom != null && headroom <= HYPERMILE_HEADROOM_MV);
  if (critical && !wasCritical && !charging) {
    view.val = "hypermile";
  }
  wasCritical = critical;
}

// Flash the high beam three times to change view without touching the phone.
//
// Kept from the old dashboard, where it toggled between two screens; with four it
// advances to the next one. `high_beam` (0x102 b0 bit6) already streams in with a
// deadband of 0, so every flash-to-pass press arrives as its own rising edge —
// which is the only input this dashboard has that works with both hands on the
// bars.
const FLASH_COUNT = 3;
const FLASH_WINDOW_MS = 2000;

let previousHighBeam = /** @type {number | null} */ (null);
let flashEdges = /** @type {number[]} */ ([]);

function detectHighBeamGesture() {
  // peek(): the enclosing derive already subscribes to high_beam explicitly, and
  // reading it again through valueOf() would say the same thing less clearly.
  const current = peek("high_beam");
  if (current == null) {
    return;
  }
  if (previousHighBeam === 0 && current === 1) {
    // Monotonic: three flashes inside a 2 s window is a duration, and a wall-clock
    // jump between two of them would either swallow the gesture or fire it early.
    const now = monotonicNow();
    flashEdges = [...flashEdges, now].filter(edge => now - edge <= FLASH_WINDOW_MS);
    if (flashEdges.length >= FLASH_COUNT) {
      flashEdges = [];
      const index = TABS.findIndex(tab => tab.name === view.val);
      view.val = TABS[(index + 1) % TABS.length].name;
    }
  }
  previousHighBeam = current;
}

// One timer drives everything that has to advance with wall-clock time: the
// under-voltage dwell, trip accounting, and the view rules. Individual modules
// keeping their own intervals would drift apart and each pay their own wakeup cost
// on a phone that is trying to sleep.
//
// For that to be true, everything reached from here has to *sample* signals rather
// than subscribe to them — hence peek() throughout updateDwell, updateTrip and
// autoFocus. Reading through valueOf() instead would quietly add every signal they
// touch to this binding's dependencies, and the tick would stop being what paces
// it. Nothing would break (the two counters use wall-clock deltas and autoFocus is
// edge-triggered, so both are correct at any rate) but the comment above would be
// false, which is worse.
van.derive(() => {
  chartTick.val;
  // Both counters integrate elapsed time, so they take the monotonic clock — the
  // dwell timer in particular decides how much of the BMS's 60 s cut-off window is
  // used, and a wall-clock jump would credit or refund it in one step.
  const now = monotonicNow();
  updateDwell(now);
  updateTrip(now);
  autoFocus();
});

// The gesture is bound to the signal rather than the tick: at a 500 ms tick, three
// flashes inside a 2 s window would be sampled two or three times and the third
// edge missed about as often as not.
van.derive(() => {
  signalState("high_beam").val;
  detectHighBeamGesture();
});

van.add(document.body, App());
connect();
void refreshStatus();
