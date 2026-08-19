// @ts-check

import van from "./vendor/van-1.6.1.js";
import { chartTick, connect, connection, isStaleSampled, peek, signalState } from "./lib/store.js";
import { headroomMvSampled } from "./lib/derive.js";
import { chargeMode } from "./lib/charge-mode.js";
import { updateDwell } from "./lib/dwell.js";
import { updateTrip } from "./lib/trip.js";
import { RideView } from "./views/ride.js";
import { HypermileView } from "./views/hypermile.js";
import { ChargeView } from "./views/charge.js";
import { AllView } from "./views/all.js";
import { FaultsView } from "./views/faults.js";
import { Sheet, hasTroubleCodes, openSheet, refreshStatus } from "./views/sheet.js";
import { monotonicNow } from "./lib/clock.js";
import { TABS, advanceTab, currentTab, peekTab, showTab, startRouting } from "./lib/router.js";

const { button, div, span } = van.tags;

// Shell: header, the current view, the tab bar, and the rules for when the bike
// gets to choose the view instead of you.
//
// Which tab is showing lives in ./lib/router.js, because it also lives in the URL.
// Everything here that changes the view goes through showTab() or advanceTab() — the
// tap on the bar, the high-beam gesture and the bike's own rules alike — so that Back
// walks through the screens the rider actually saw, whoever chose them.

/** @typedef {import("./lib/router.js").TabName} ViewName */

/**
 * The view each tab shows.
 *
 * A Record over ViewName rather than the switch this used to be: ViewName is derived
 * from the router's TABS, so adding a tab there widens it and a tab with no view here
 * fails `npm run typecheck`. The switch's `default` case would instead have drawn the
 * riding screen under the new tab's URL and said nothing.
 *
 * @type {Record<ViewName, () => Element>}
 */
const VIEWS = {
  ride: RideView,
  hypermile: HypermileView,
  charge: ChargeView,
  all: AllView,
  faults: FaultsView,
};

// Routing before anything else: startRouting() sets the tab from the URL, so the first
// render draws the screen a link named rather than drawing Ride and swapping it a frame
// later. It answers whether the URL named a tab at all, which the rules below need.
const arrivedByDeepLink = startRouting();

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
  return div(Header(), () => VIEWS[currentTab()](), TabBar(), Sheet());
}

function Header() {
  return div(
    { class: "header" },
    button(
      {
        class: "menu",
        // openSheet() rather than setting the flag here: the sheet's sections fetch
        // when they become visible, and it owns the list of what has to be
        // refreshed so this button cannot fall behind it.
        onclick: () => openSheet(),
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
          class: () => `tab${currentTab() === tab.name ? " on" : ""}`,
          onclick: () => showTab(tab.name),
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
 *
 * These go through showTab() like every other view change, which buys two things.
 * The URL cannot fall behind a move the rider did not make — so the screen a reload
 * or a shared link restores is the one that was actually up. And a move the bike made
 * is undoable: plugging in takes you to Charge, and Back takes you back, the same
 * press that would have undone the tap you did not have to make.
 *
 * They push a history entry rather than replacing one, deliberately, and the argument
 * is in the header of lib/router.js — the short version being that replaceState would
 * not decline to add an entry, it would overwrite the one the rider had made.
 */
let wasCharging = false;
let wasCritical = false;

/**
 * A URL that named a tab gets the first word; the bike gets every word after it.
 *
 * The rules above are edge-triggered — "the moment charging starts" — but a page load
 * has no previous moment, and seeding from `false` makes the first reading that says
 * "charging" look like charging having just *started*. On the bare entry URL that is
 * worth keeping: it is why opening the dashboard at a charger lands on Charge.
 *
 * It is not worth keeping when a link, a bookmark or an iOS reload asked for a screen
 * by name. The bike would move you off it a second later and — now that the tab is in
 * the URL — rewrite the address with it, so reloading the link would no longer reach
 * the screen the link names. A shared link that quietly overwrites its own address is
 * worse than one the bike is allowed to overrule.
 *
 * So a URL that named a tab buys exactly one pass: the first readings are taken as the
 * state the bike was already in rather than as a change into it. Every edge after that
 * is a real change and moves the view as it always did.
 */
let honourUrlTab = arrivedByDeepLink;

function autoFocus() {
  // The charging screen's own rule, so the tab you are thrown onto agrees with what
  // it then shows you. It also means a DC fast charge finally triggers this at all:
  // the BMS reports Idle for the whole of one, so the BMS-bits-only test this
  // replaces was blind to exactly the charge worth watching.
  const charging = chargeMode(peek, isStaleSampled) !== "none";
  const soc = peek("soc");
  const headroom = headroomMvSampled();
  const critical = (soc != null && soc <= HYPERMILE_SOC) || (headroom != null && headroom <= HYPERMILE_HEADROOM_MV);

  if (honourUrlTab) {
    wasCharging = charging;
    wasCritical = critical;
    // Held until the bike has said something. Before the first BMS message every
    // reading above is "no", which is the absence of a state rather than a state to
    // seed from — seed on that and the pass is spent before it was ever needed.
    honourUrlTab = soc == null;
    return;
  }

  if (charging && !wasCharging) {
    showTab("charge");
  }
  // Leaving the charger takes you back to the riding screen, but only if you are
  // still looking at the one it moved you to. peekTab(), not currentTab(): this runs
  // inside the chartTick timer, and subscribing that timer to the tab would re-pace it
  // on every tab change.
  if (!charging && wasCharging && peekTab() === "charge") {
    showTab("ride");
  }
  wasCharging = charging;

  if (critical && !wasCritical && !charging) {
    showTab("hypermile");
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
      advanceTab();
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
// than subscribe to them — hence peek() and isStaleSampled() throughout updateDwell,
// updateTrip and autoFocus, and peekTab() where autoFocus asks which tab is up.
// Reading through valueOf() or isStale() instead would quietly add every signal they
// touch to this binding's dependencies — serverTime included, which moves on every
// message — and the tick would stop being what paces it. Nothing would break (the two
// counters use wall-clock deltas and autoFocus is edge-triggered, so both are correct
// at any rate) but the comment above would be false, which is worse.
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
