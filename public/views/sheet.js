// @ts-check

import van from "../vendor/van-1.6.1.js";
import { chartTick, knownKeys, valueOf } from "../lib/store.js";
import { averageMovingSpeedKmh, distanceKm, movingTimeSeconds, topSpeed } from "../lib/trip.js";
import { bytes, compass, duration } from "../lib/format.js";
import { MUTED } from "../lib/colors.js";
import { saveWaypoint } from "../lib/waypoint.js";
import { ServiceMode, refreshServiceMode } from "./service-mode.js";

const { button, div, span } = van.tags;

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
      div({ class: "sheet-title" }, "This session"),
      TripStats(),
      div({ class: "sheet-title" }, "Actions"),
      WaypointButton(),
      DownloadButton(),
      // Last of the doing-things sections and first of the reading-things ones,
      // because it is the only control here that causes traffic on the bike's bus
      // — worth a heading of its own rather than a third entry under "Actions".
      div({ class: "sheet-title" }, "Service mode"),
      ServiceMode(),
      div({ class: "sheet-title" }, "Stored codes"),
      TroubleCodes(),
      div({ class: "sheet-title" }, "Link"),
      SourceHealth(),
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
    ),
    () => {
      const current = status.val;
      if (!current || !current.log.enabled) {
        return div();
      }
      // Both halves of this line are narrower than they look, and both were wider
      // once — it read "N sealed segments · encrypted, safe over any network", which
      // is where "it always says 10" came from.
      //
      // FILES, not segments: one `.celog` is a whole day of them, so this number
      // cannot move before midnight however far the bike rides. src/http/status.ts
      // has the mechanism.
      //
      // And unreadable, not safe. Without the laptop's private key the log is noise,
      // which is a claim about the BYTES; "safe over any network" was a claim about
      // the TRANSFER, and the transfer is the part with no crypto in it. /dl
      // authenticates nobody, so anyone on that wifi can pull the whole log and keep
      // the ciphertext against the day the key leaks, and segments can be dropped or
      // truncated in flight by someone holding no key at all. src/http/download.ts
      // draws the same line, and the README lists the rest.
      const fileCount = current.log.files;
      return div(
        { class: "action-note" },
        `${fileCount} daily log file${fileCount === 1 ? "" : "s"} · unreadable without the laptop's private key`
      );
    }
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

/** Which data sources are actually alive, rather than "some numbers are on screen". */
function SourceHealth() {
  return div({ class: "stats" }, () => {
    const current = status.val;
    if (!current) {
      return div({ class: "action-note", style: `color:${MUTED}` }, "…");
    }
    return div(
      { class: "stats" },
      ...Object.entries(current.groups)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([group, [live, total]]) =>
          div(
            { class: "stat" },
            div({ class: "stat-label" }, group),
            div({ class: "stat-value", style: live === 0 ? `color:${MUTED}` : "" }, `${live}/${total}`)
          )
        )
    );
  });
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
