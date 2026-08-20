// @ts-check

import van from "../vendor/van-1.6.1.js";
import { chartTick, knownKeys, valueOf } from "../lib/store.js";
import { averageMovingSpeedKmh, distanceKm, movingTimeSeconds, topSpeed } from "../lib/trip.js";
import { bytes, compass, duration } from "../lib/format.js";
import { saveWaypoint } from "../lib/waypoint.js";
import { ServiceMode, refreshServiceMode } from "./service-mode.js";

const { button, div, h2 } = van.tags;

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
  void refreshStatus();
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
      h2({ class: "sheet-heading" }, "This session"),
      TripStats(),
      // No subtitle here, deliberately. Three sections carrying a one-line "what can
      // this do to the bike" was one sentence too many for a single bit of
      // information: both controls in this one are in the grey tier, which says the
      // same thing without a sentence. The two that keep a subtitle are the two
      // either side of the read/write boundary, where the bit is not obvious.
      h2({ class: "sheet-heading" }, "Actions"),
      WaypointButton(),
      DownloadButton(),
      // Last of the doing-things sections and first of the reading-things ones,
      // because it is the only control here that causes traffic on the bike's bus
      // — worth a heading of its own rather than a third entry under "Actions".
      h2({ class: "sheet-heading" }, "Service mode"),
      // ⚠️ It used to end "…the section that can change it is further down", which was
      // prose apologising for the layout — if a sentence has to tell you where the
      // other section is, the boundary is not doing its job. The boundary now does it:
      // the write section has a rule in the one colour nothing else on this sheet uses
      // for a rule, and states its own risk under its own heading.
      div({ class: "sheet-heading-note" }, "Reads the bike. Nothing in this part changes it."),
      ServiceMode(),
      h2({ class: "sheet-heading" }, "Stored codes"),
      TroubleCodes(),
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

function TripStats() {
  return div(
    { class: "stats" },
    Stat("Distance", () => {
      chartTick.val;
      const distance = distanceKm();
      return distance == null ? "–" : `${distance.toFixed(1)} km`;
    }),
    Stat("Moving", () => {
      chartTick.val;
      return duration(movingTimeSeconds());
    }),
    Stat("Average", () => {
      chartTick.val;
      const average = averageMovingSpeedKmh();
      return average == null ? "–" : `${average.toFixed(0)} km/h`;
    }),
    Stat("Top", () => {
      chartTick.val;
      return `${topSpeed().toFixed(0)} km/h`;
    }),
    Stat("Altitude", () => {
      const altitude = valueOf("gps_altitude_m");
      return altitude == null ? "–" : `${Math.round(altitude)} m`;
    }),
    Stat("Heading", () => compass(valueOf("gps_course_deg"))),
    Stat("Waypoints", () => {
      const saved = valueOf("waypoint_seq");
      return saved == null ? "0" : String(Math.round(saved));
    }),
    Stat("Satellites", () => {
      const satellites = valueOf("gps_satellites");
      return satellites == null ? "–" : String(Math.round(satellites));
    })
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
            waypointMessage.val = (await saveWaypoint()).message;
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
    // knowing and live in the code that owns them: one `.celog` is a whole day of
    // segments, so the count moves once a day rather than as you ride
    // (src/http/status.ts); and the log is unreadable without the laptop's
    // private key, but /dl authenticates nobody, so the ciphertext is pullable by
    // anyone on that wifi (src/http/download.ts, and README "What this does and
    // doesn't hide").
  );
}

/**
 * Trouble codes the bike has stored, from the Connectivity Hub's diagnostics
 * message. Moved off the riding screens and in here: a stored code is never
 * something to read about at speed, but it is the first thing worth checking when
 * you stop.
 *
 * Each code is its own 1/0 signal keyed `dtc_<component>_<symptom>` — see
 * src/diagnostics/dtc-table.ts. The count is cross-checked against OBD-II PID 01,
 * which reaches the same number down a completely different path.
 */
function TroubleCodes() {
  return div({ class: "action-note" }, () => {
    // `\d+`, not `\d{4}`: dtcSignalKey pads the component to a MINIMUM of four
    // digits, and a code no table row names keeps its raw low 16 bits — up to five
    // digits. Those are exactly the codes worth seeing.
    const active = knownKeys.val
      .filter(key => /^dtc_\d+_\d+$/.test(key) && (valueOf(key) ?? 0) > 0)
      .map(key => key.slice(4).replace("_", "/"))
      .sort();
    const viaObd = valueOf("dtc_count");
    const crossCheck = viaObd == null ? "" : ` · OBD reports ${Math.round(viaObd)}`;
    if (active.length === 0) {
      return `none set${crossCheck}`;
    }
    return `${active.join(" · ")}${crossCheck} — named, with history, on the Faults tab`;
  });
}

/** True while the bike is reporting at least one stored trouble code. */
export function hasTroubleCodes() {
  return knownKeys.val.some(key => /^dtc_\d+_\d+$/.test(key) && (valueOf(key) ?? 0) > 0);
}

/**
 * @param {string} label
 * @param {() => string} value
 */
function Stat(label, value) {
  return div({ class: "stat" }, div({ class: "stat-label" }, label), div({ class: "stat-value" }, value));
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
