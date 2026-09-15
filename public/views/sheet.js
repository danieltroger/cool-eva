// @ts-check

import van from "../vendor/van-1.6.1.js";
import { knownKeys, valueOf } from "../lib/store.js";
import { bytes } from "../lib/format.js";
import * as units from "../lib/units.js";
import * as theme from "../lib/theme.js";
import { saveWaypoint } from "../lib/waypoint.js";
import { armed } from "../lib/arming.js";
import { CanRestartButton, UpdateButton } from "./pi-actions.js";
import { ServiceMode, refreshServiceMode } from "./service-mode.js";
import { FanControl, refreshFanStatus } from "./fan.js";
import { TripStats } from "./trip-stats.js";
import { WaypointList, collapseWaypointList } from "./waypoints.js";
import { blankWaypointMemory, shouldRefreshOnWaypoint } from "../lib/waypoint-list.js";

const { button, div, h2, h3 } = van.tags;

// The sheet behind the header button: trip summary, waypoints, and the two actions
// that used to require typing a URL on a phone.
//
// Everything here is deliberately not on the riding screens. None of it is worth
// looking at at speed, and all of it is worth having when you stop.

/** @typedef {import("../../src/http/status.ts").StatusPayload} StatusPayload */

export const sheetOpen = van.state(false);

/**
 * Opens the sheet and refreshes everything in it.
 *
 * The single entry point on purpose: each section here fetches its own endpoint
 * when it becomes visible rather than polling in the background, so an opener that
 * set `sheetOpen` directly would show one section's stale numbers next to
 * another's fresh ones. Service mode is handed a way to ask whether the sheet is
 * still open, which is half of what stops it polling forever.
 */
export function openSheet() {
  sheetOpen.val = true;
  // ⚠️ Re-opening the sheet must never find a half-confirmed Update waiting for its second
  // tap. Spelled here rather than left to refreshServiceMode()'s disarm: the two controls
  // in ./pi-actions.js are this file's to reset, not another module's to reset for it.
  // scripts/check-arming.ts asserts this line, and reads this file only because of it.
  armed.val = "";
  // Same rule, same reason: a section this sheet expanded stays expanded across opens
  // unless somebody shuts it, and a waypoint list left open pushes every control on this
  // sheet down by however long the ride was. ./waypoints.js says it there too.
  collapseWaypointList();
  void refreshStatus();
  void refreshFanStatus();
  refreshServiceMode(() => sheetOpen.val);
}

const status = van.state(/** @type {StatusPayload | null} */ (null));
const waypointMessage = van.state("");
const saving = van.state(false);

export function Sheet() {
  return div(
    {
      class: () => `sheet${sheetOpen.val ? " open" : ""}`,
      // Tapping the backdrop closes it; taps inside must not bubble out to that.
      onclick: () => {
        sheetOpen.val = false;
      },
    },
    div(
      {
        class: "sheet-body",
        onclick: (/** @type {Event} */ event) => event.stopPropagation(),
      },
      // `sheet-heading` for the sheet's own sections, `sheet-title` for the
      // subsections inside one of them. See style.css.
      //
      // ⚠️ h2 and h3, not divs, and that is the whole of what makes the hierarchy
      // real: everything else about it is paint, and paint reaches exactly one kind
      // of reader. Until this change there was not a single heading element anywhere
      // in public/, so VoiceOver's rotor listed nothing and this sheet was one flat
      // run of text to it. Levels start at 2 because the sheet is a section of a page
      // rather than a document of its own, and nothing renders differently — see
      // docs/dashboard-decisions.md §"The menu sheet".
      // The two preferences this dashboard has, at the top of the sheet where they are
      // found first rather than buried below the stats — neither is worth reaching for at
      // speed, but when the sheet is open they are the controls most likely wanted, and
      // the page flips under your thumb as you tap. Persisted in lib/theme.js, lib/units.js.
      h2({ class: "sheet-heading" }, "Screen"),
      ThemeToggle(),
      h2({ class: "sheet-heading" }, "Units"),
      UnitsToggle(),
      h2({ class: "sheet-heading" }, "This session"),
      TripStats(status),
      // h3 inside "This session", not a sixth h2: the list is what the Waypoints tile
      // above it counts, and a top-level heading would leave "This session" meaning the
      // stats grid alone. The levels are the accessible hierarchy, not paint — see the
      // note at the top of this file.
      h3({ class: "sheet-title" }, "Waypoints"),
      WaypointList(status),
      // No subtitle here, deliberately. Three sections carrying a one-line "what can
      // this do to the bike" was one sentence too many for a single bit of
      // information: all four controls in this one are in the grey tier, which says the
      // same thing without a sentence. The two that keep a subtitle are the two
      // either side of the read/write boundary, where the bit is not obvious. The CAN
      // restart and Update are grey-tier too — they act on the Pi, not on the bike —
      // and they arm anyway, which is a separate channel from the tier (./pi-actions.js).
      h2({ class: "sheet-heading" }, "Actions"),
      WaypointButton(),
      DownloadButton(),
      CanRestartButton(),
      UpdateButton(),
      // The cooling fan brings its own heading, so it disappears completely on a Pi
      // without FAN_ENABLED rather than leaving a heading over nothing. It sits between
      // the grey Actions and Service mode because that is what it is: the only control on
      // this sheet that MOVES something physical. (Narrowed in #129's pass: the two Pi
      // actions above it act on the Pi, but nothing on the bike or in the garage turns.)
      FanControl(),
      // Last of the doing-things sections and first of the reading-things ones,
      // because it is the only SECTION here whose controls reach the bike's bus —
      // worth a heading of its own rather than a third entry under "Actions". It
      // said "the only control" until #129; the scope was right and the noun was
      // not, since the sweep, the lifetime read and the write fold are all inside it.
      h2({ class: "sheet-heading" }, "Service mode"),
      // ⚠️ It used to end "…the section that can change it is further down", which was
      // prose apologising for the layout — if a sentence has to tell you where the
      // other section is, the boundary is not doing its job. The boundary now does it:
      // the write section has a rule in the one colour nothing else on this sheet uses
      // for a rule, and states its own risk under its own heading.
      div({ class: "sheet-heading-note" }, "Reads the bike. Nothing in this part changes it."),
      ServiceMode(),
      // No "Link" section, deliberately. A per-source liveness readout was here in
      // two shapes and neither could be read: a grid of sixteen fractions needed the
      // reader to know sixteen normal denominators (BATTERY 17/46 is a HEALTHY parked
      // bike), and collapsing it to "what is dark" cried wolf instead — `security`
      // reads dark for most of the wall clock on measured captures where 0x480 is
      // present, and three more groups are the same shape. Every exemption is
      // defensible and the list only grows, which is the tell.
      //
      // The per-group numbers stay in /status. Measurements, and what left the
      // payload: docs/dashboard-decisions.md §"There is no Link section".
      button(
        {
          class: "sheet-close",
          onclick: () => {
            sheetOpen.val = false;
          },
        },
        "Close"
      )
    )
  );
}

/**
 * Saves a waypoint from the phone. The same endpoint a Siri Shortcut hits and the same
 * one a long press of the indicator-cancel switch reaches, through the same client in
 * lib/waypoint.js — so there is one code path and one thing to get wrong.
 *
 * No banner from here, unlike the handlebar gesture: you are looking at this button
 * when you press it, and the note under it is already in view.
 */
function WaypointButton() {
  return div(
    button(
      {
        class: "action",
        disabled: saving,
        onclick: async () => {
          saving.val = true;
          waypointMessage.val = "saving…";
          try {
            const reply = await saveWaypoint();
            waypointMessage.val = reply.message;
            if (reply.saved) {
              // The Waypoints tile above this button asks /status whether any waypoint
              // belongs to THIS boot, and nothing else refreshes that after a save — so
              // without this the note here says "Waypoint 1 saved." while the tile two
              // rows up still reads "none since restart" until the sheet is reopened.
              void refreshStatus();
            }
          } finally {
            // saveWaypoint() reports its own failures and never throws, so this is
            // only here to guarantee the button re-enables.
            saving.val = false;
          }
        },
      },
      "📍  Save waypoint here"
    ),
    () => (waypointMessage.val ? div({ class: "action-note" }, waypointMessage.val) : div())
  );
}

/** Downloads the sealed ride log, with its size known before you commit to it. */
function DownloadButton() {
  return div(
    button(
      {
        class: "action",
        onclick: () => {
          // A plain navigation rather than fetch(): this can be tens of megabytes
          // over garage wifi, and the browser's own download UI handles pausing,
          // backgrounding and progress far better than anything here could.
          location.href = "/dl";
        },
      },
      () => {
        const current = status.val;
        if (!current) {
          return "⬇  Download ride log";
        }
        if (!current.log.enabled) {
          return "⚠  No log — public key missing";
        }
        return `⬇  Download ride log (${bytes(current.log.bytes)})`;
      }
    )
    // No caption under the button. The file count that used to sit here is still
    // in the status payload (`log.files`) and still correct — it was dropped for
    // screen space, not because it was wrong. The two facts it carried are worth
    // knowing and live in the code that owns them: a `.celog` holds hundreds or
    // thousands of segments, so the count moves a few times a day rather than as you
    // ride — a day file plus whatever was sealed before the clock could be believed
    // (src/http/status.ts, docs/ride-log-clock.md); and the log is unreadable without the laptop's
    // private key, but /dl authenticates nobody, so the ciphertext is pullable by
    // anyone on that wifi (src/http/download.ts, and README "What this does and
    // doesn't hide").
  );
}

/** True while the bike is reporting at least one stored trouble code. */
export function hasTroubleCodes() {
  return knownKeys.val.some(key => /^dtc_\d+_\d+$/.test(key) && (valueOf(key) ?? 0) > 0);
}

/**
 * Dark/light as a three-button segmented control, the same `.toggle-row` as the units
 * row below it. AUTO follows the bike's own day/night flag while it is broadcasting and
 * the phone's setting otherwise; the two explicit choices are never overruled by either,
 * which is what makes this the escape hatch if the bike's flag ever reads wrong.
 */
function ThemeToggle() {
  return div(
    { class: "toggle-row" },
    .../** @type {const} */ (["auto", "light", "dark"]).map(preference =>
      button(
        {
          class: () => (theme.themePreference.val === preference ? "on" : ""),
          onclick: () => theme.setThemePreference(preference),
        },
        preference === "auto" ? "Auto · bike" : preference === "light" ? "Light" : "Dark"
      )
    )
  );
}

/**
 * Metric/imperial as a two-button segmented control, reusing the same `.toggle-row`
 * the charge screen's heatmap uses. `.on` tracks unitSystem, so it also reflects what
 * a reload restored from localStorage.
 */
function UnitsToggle() {
  return div(
    { class: "toggle-row" },
    .../** @type {const} */ (["metric", "imperial"]).map(system =>
      button(
        {
          class: () => (units.unitSystem.val === system ? "on" : ""),
          onclick: () => units.setUnitSystem(system),
        },
        system === "metric" ? "Metric · km, °C" : "Imperial · mi, °F"
      )
    )
  );
}

/**
 * Starts watching the two waypoint counters, so a press made on the BARS while the sheet is
 * open lands in the list without reopening it — a save AND a refusal, since `refuse()` in
 * src/gps/waypoint.ts moves only its own counter and "did my press land?" is the question
 * the list is for.
 *
 * ⚠️ Call at module top level, from app.js, never from inside a view or a binding — a
 * derive created inside one is pinned to that render's DOM node and dropped, silently, at
 * the next re-render. lib/announce.js §installAnnouncements has the mechanism.
 *
 * The phone's own button does not need this for a SAVE: WaypointButton() below refreshes
 * /status the moment its reply lands. Its refusals come through here with the bars'.
 */
export function installWaypointRefresh() {
  let memory = blankWaypointMemory();
  van.derive(() => {
    // Both read before anything is decided — VanJS re-collects a binding's dependencies
    // from the reads its LAST run made, so a run that returned above one of these would
    // leave the refresh deaf to it. views/trip-stats.js §Waypoints measured that.
    const counters = { saved: valueOf("waypoint_seq"), refused: valueOf("waypoint_refused_seq") };
    // rawVal: whether the sheet is open is SAMPLED, not reacted to. Subscribing here would
    // re-run this derive on every open and close for a question it only asks in passing —
    // lib/store.js §peek. ⚠️ A sheet left open THROUGH a service restart keeps the previous
    // boot's rows until it is reopened, exactly as the tile above it does and for the same
    // reason — views/trip-stats.js says it there.
    const decision = shouldRefreshOnWaypoint(memory, counters, sheetOpen.rawVal);
    memory = decision.memory;
    if (decision.refresh) {
      void refreshStatus();
    }
  });
}

/** Refreshes /status while the sheet is open, and once at startup for the log size. */
export async function refreshStatus() {
  try {
    const response = await fetch("/status");
    status.val = await response.json();
  } catch (error) {
    console.warn("status: could not refresh", error);
  }
}
