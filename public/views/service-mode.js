// @ts-check

import van from "../vendor/van-1.6.1.js";
import { monotonicNow, since } from "../lib/clock.js";
import { ageInWords, duration } from "../lib/format.js";
import { MUTED } from "../lib/colors.js";
import { VcuWrite, refreshVcuWrite } from "./vcu-write.js";

const { a, button, div, h3 } = van.tags;

// Service mode: read the VCU's calibration parameters off the bike on demand, and
// hand the result over as the file another owner's energica_tool.py reads.
//
// The page LEADS with what the read gate currently says (src/vcu/service-gate.ts),
// because a button disabled with no reason given is indistinguishable from one that is
// broken. The server is still the authority: this page only reports what the Pi said.
//
// Nothing here blocks. A sweep is ~277 reads over a link that drops as routine, so the
// button starts it and returns; progress comes from polling /vcu-read once a second
// while the sheet is open AND there is something to watch. The sweep runs on the Pi.
//
// ⚠️ The button ARMS first: this is the only control in the dashboard that causes
// traffic on the bike's bus, and ~277 requests compete with the OBD poller for the
// scarce resource. Why two taps and no modal, and why this is not a tab:
// docs/dashboard-decisions.md §"Service mode: reading the VCU".

/** @typedef {import("../../src/http/vcu-read.ts").VcuReadResponse} VcuReadResponse */
/** @typedef {import("../../src/vcu/read-runner.ts").VcuReadState} VcuReadState */
/** @typedef {import("../../src/vcu/read-runner.ts").VcuReadTally} VcuReadTally */
/** @typedef {import("../../src/vcu/service-gate.ts").ServiceGateVerdict} ServiceGateVerdict */

const state = van.state(/** @type {VcuReadResponse | null} */ (null));
const armed = van.state(false);
const message = van.state("");
/** Bumped once a second while a sweep runs, purely so the elapsed line re-renders. */
const tick = van.state(0);

/**
 * Phone-side monotonic mark for when we first SAW a sweep running.
 *
 * Not `run.startedAt`, which is the Pi's wall clock: the Pi has no RTC and steps
 * its own clock from GPS, so subtracting it from `Date.now()` here is arithmetic
 * across two clocks that disagree — the thing ../lib/clock.js exists to forbid.
 * The cost is that the timer reads from when the page noticed rather than from the
 * true start, which is why it is labelled "watching for" and not "running for".
 */
let watchingSince = /** @type {number | null} */ (null);
let polling = false;

export function ServiceMode() {
  return div(
    GateNote(),
    ReadButton(),
    () => (message.val ? div({ class: "action-note" }, message.val) : div()),
    ProgressNote(),
    ExportButton(),
    div(
      { class: "action-note" },
      a({ href: "/params.html", style: `color:${MUTED}` }, "Open the full parameter table →")
    ),
    // ⚠️ Everything above this line reads. Everything below it can CHANGE the
    // motorcycle, and it is behind its own switch (SERVICE_WRITE_ENABLED, off by
    // default) and fetches its own state. It is last on the sheet on purpose: the
    // things you do most often should not be underneath the things you cannot undo.
    //
    // This comment used to be the only place that boundary existed. It is now on
    // screen as well — an amber level-1 heading with a rule above it, and a line
    // under the "Service mode" heading in ./sheet.js saying it is coming.
    VcuWrite()
  );
}

/**
 * What the safety gate currently says, above the button rather than instead of it.
 *
 * Every blocker is listed rather than only the first, because "speed unknown AND
 * the bike is in drive" is a different situation from either alone — and because
 * one of them naming a signal that has never arrived is how you find out that the
 * CAN side is not running at all, rather than that the bike is moving.
 */
function GateNote() {
  return div({ class: "action-note" }, () => {
    const current = state.val;
    if (!current) {
      return div({ style: `color:${MUTED}` }, "…");
    }
    if (current.gate.safe) {
      // A charging bike is allowed in, and it is worth saying so explicitly rather
      // than letting "out of drive" stand next to a bike whose drive is plainly
      // energized. The evidence is named because this is the one place the gate
      // relaxes a check, and a relaxation nobody can see is one nobody can audit.
      return div(
        { style: `color:${MUTED}` },
        current.gate.chargingEvidence === null
          ? "✅  Stationary and out of drive — safe to service."
          : `🔌  Stationary and charging — safe to service. (${current.gate.chargingEvidence}, so the drive being energized is expected.)`
      );
    }
    return div(
      "🚫  Service mode is not available:",
      ...current.gate.blockers.map(blocker => div({ style: `color:${MUTED}` }, `· ${blocker}`))
    );
  });
}

/**
 * Starts a sweep, or stops the one that is running. One button rather than two:
 * while a sweep is running, stopping it is the only thing you can usefully do to
 * it, and a dead "Read" button next to a live "Stop" is a worse thing to hit.
 */
function ReadButton() {
  return button(
    {
      class: "action",
      // Disabled only for STARTING — a sweep already running must stay stoppable
      // whether the flag was set or the bike started moving, which is why this
      // reads `isRunning()` first. Both reasons to be disabled are the server's,
      // read off the last response; the page decides nothing here.
      disabled: () => !isRunning() && state.val !== null && (!state.val.enabled || !state.val.gate.safe),
      onclick: () => {
        if (isRunning()) {
          void request("DELETE");
          return;
        }
        if (!armed.val) {
          armed.val = true;
          return;
        }
        armed.val = false;
        void request("POST");
      },
    },
    () => {
      if (isRunning()) {
        return "⏹  Stop the parameter read";
      }
      if (state.val !== null && !state.val.enabled) {
        return "🔒  Reads are off on this Pi (SERVICE_MODE_ENABLED=0)";
      }
      if (state.val !== null && !state.val.gate.safe) {
        // Deliberately not repeating the reasons: they are in full directly above,
        // and a button caption is the wrong place for four of them.
        return "🚫  The bike is not parked and out of drive";
      }
      if (armed.val) {
        return "⚠  Tap again — this puts ~277 requests on the bus";
      }
      // 🔎, not 🔧. The wrench was on this button AND on "say a service was
      // performed NOW", i.e. on the safest control in the sheet and on one of the
      // three that cannot be undone — the one glyph collision that actively
      // mislead. 🔎 now means "this reads the bike" everywhere in the sheet, and
      // 🔧 is left to mean the service point and nothing else.
      return "🔎  Read VCU parameters from the bike";
    }
  );
}

/**
 * What the sweep is doing, or what the last one did.
 *
 * Every branch names WHICH micro answered and HOW MANY parameters came back,
 * because those are the two facts that tell a silent bike apart from a silent
 * micro apart from a sweep that never started. A bare "failed" would leave all
 * three looking the same.
 */
function ProgressNote() {
  return div({ class: "action-note" }, () => {
    tick.val;
    const current = state.val;
    if (!current) {
      return div({ style: `color:${MUTED}` }, "…");
    }
    const run = current.run;
    switch (run.phase) {
      case "idle":
        return div(
          { style: `color:${MUTED}` },
          "No read has been started since the Pi last booted. Takes well under a minute; the bike has to be awake, parked and out of drive, and the read stops by itself if that changes."
        );
      case "running":
        return div(
          `${run.tally.read} of ${run.expected} read` +
            `${watchingSince === null ? "" : ` · watching for ${duration(since(watchingSince) / 1000)}`}`,
          div({ style: `color:${MUTED}` }, describeMicros(run.tally))
        );
      case "finished":
        return div(
          `${run.tally.read} of ${run.tally.total} parameters read` +
            (run.complete ? "" : " · SWEEP INCOMPLETE — start it again to resume"),
          div({ style: `color:${MUTED}` }, describeMicros(run.tally)),
          FailureBreakdown(run.tally)
        );
      case "failed":
        return div(
          `Stopped: ${run.reason}`,
          div({ style: `color:${MUTED}` }, `${run.tally.read} parameter(s) were kept · ${describeMicros(run.tally)}`),
          FailureBreakdown(run.tally)
        );
    }
  });
}

/**
 * The non-`read` outcomes, by name.
 *
 * Shown rather than summed into one "failed" count because the codec draws
 * distinctions a rider needs: `no-session` means the micro never woke up,
 * `no-response` means it was awake and said nothing to that particular parameter,
 * `refused` means it answered by name, and `not-sent` is our own socket rather
 * than the bike. Collapsing them would put our dead CAN interface on screen as the
 * motorcycle refusing to talk.
 *
 * @param {VcuReadTally} tally
 */
function FailureBreakdown(tally) {
  const failures = Object.entries(tally.byStatus).filter(([status, count]) => status !== "read" && count > 0);
  if (failures.length === 0) {
    return div();
  }
  return div({ style: `color:${MUTED}` }, failures.map(([status, count]) => `${count} ${status}`).join(" · "));
}

/** Downloads the snapshot in energica_tool.py's own backup format. */
function ExportButton() {
  return div(
    button(
      {
        class: "action action-quiet",
        disabled: () => (state.val?.export.rows ?? 0) === 0,
        onclick: () => {
          // A plain navigation rather than fetch(): the browser's own download UI
          // is what puts the file somewhere the phone can share it from, which is
          // the entire point of exporting it. Same reasoning as the ride log.
          location.href = "/vcu-backup.csv";
        },
      },
      () => {
        const rows = state.val?.export.rows ?? 0;
        if (rows === 0) {
          return "⬇  Export — nothing read on this Pi yet";
        }
        return `⬇  Export ${rows} parameters as vcu_backup.csv`;
      }
    ),
    () => {
      const summary = state.val?.export;
      if (!summary || summary.rows === 0) {
        return div();
      }
      // The AGE leads, because this button does not export what the progress line
      // above it just said. It exports `latest.json`, and the script deliberately
      // leaves that file alone when a run reads nothing — so a sweep that found the
      // bike asleep leaves "0 of 277 read" directly above "Export 233 parameters",
      // both true, and the natural reading of the second one wrong. An age is what
      // makes it obvious the file is from another day, and this is a file people
      // send to other owners as their bike's calibration.
      return div(
        { class: "action-note" },
        `From a snapshot read ${ageInWords(summary.readAt)}${summary.complete ? "" : " · from an INCOMPLETE sweep"} · byte-compatible with energica_tool.py's “Save backup…”`
      );
    }
  );
}

/**
 * Fetches the current state, and starts or stops a sweep.
 *
 * Every outcome lands in the UI, including the refusals: a POST while one is
 * already running comes back 409 with the reason, which is a thing the page should
 * say rather than a thing to retry.
 *
 * @param {"GET" | "POST" | "DELETE"} method
 */
async function request(method) {
  try {
    const response = await fetch("/vcu-read", {
      method,
      cache: "no-store",
      // Not a secret and not authentication. A header a CORS-simple request cannot
      // set is what stops some other page in this browser starting a sweep on the
      // bike's bus without the owner — see the header of src/http/vcu-read.ts. Our
      // own page is same-origin, so it costs no preflight.
      headers: { "X-Cool-Eva": "service-mode" },
    });
    // The body carries the state on every status this endpoint returns, including
    // 409 and 202, so it is read before the status is judged.
    const payload = /** @type {VcuReadResponse} */ (await response.json());
    state.val = payload;
    message.val = payload.message ?? "";
    if (isRunning()) {
      if (watchingSince === null) {
        watchingSince = monotonicNow();
      }
    } else {
      watchingSince = null;
    }
    startPolling();
  } catch (error) {
    // Loud. The usual cause is the phone having dropped off the bike's hotspot,
    // and a button that silently does nothing is the worst version of that.
    message.val = `could not reach the Pi — ${error instanceof Error ? error.message : String(error)}`;
    console.warn("service-mode: /vcu-read request failed", error);
  }
}

/**
 * Polls while the sheet is open and there is something to watch.
 *
 * Self-scheduling rather than a standing `setInterval`, so the loop ends by simply
 * not scheduling itself again — there is no timer left behind to leak, and no
 * traffic at all once there is nothing to see. `sheetOpen` is passed in rather than
 * imported to keep this module free of a circular import with ./sheet.js.
 */
function startPolling() {
  // Checked before the first timer is armed, not only inside the loop: called after
  // every response, this would otherwise cost one wasted request each time the sheet
  // is opened on an idle, parked bike — the common case.
  if (polling || !shouldKeepPolling()) {
    return;
  }
  polling = true;
  const step = async () => {
    if (!shouldKeepPolling()) {
      polling = false;
      return;
    }
    await request("GET");
    tick.val = tick.val + 1;
    if (!shouldKeepPolling()) {
      polling = false;
      return;
    }
    setTimeout(() => void step(), POLL_INTERVAL_MS);
  };
  setTimeout(() => void step(), POLL_INTERVAL_MS);
}

/** One second: fast enough that a ~277-read sweep visibly moves, slow enough to be nothing on a Pi Zero. */
const POLL_INTERVAL_MS = 1000;

/** @type {() => boolean} */
let sheetIsOpen = () => false;

/**
 * Called once by ./sheet.js when the sheet opens: refresh, and let this module
 * know how to tell whether it is still open.
 *
 * @param {() => boolean} isOpen
 */
export function refreshServiceMode(isOpen) {
  sheetIsOpen = isOpen;
  armed.val = false;
  void request("GET");
  // The write section keeps its own state and its own endpoint, so it is refreshed
  // alongside rather than folded in — and its refresh DISARMS every button it has,
  // which is the property that matters here: re-opening the sheet must never find a
  // half-confirmed irreversible action waiting for its second tap.
  void refreshVcuWrite();
}

/**
 * Two things are worth following, and neither of them is "the sheet is open".
 *
 * A running sweep, obviously. And a gate that is currently refusing — because the
 * bike being wheeled into the garage is exactly the moment someone is standing here
 * waiting for the button to come alive, and making them close and re-open the sheet
 * to find out would be silly. An idle, safe service mode polls nothing: that is the
 * state a phone forgotten on the workbench is in.
 */
function shouldKeepPolling() {
  if (!sheetIsOpen()) {
    return false;
  }
  return isRunning() || state.val?.gate.safe === false;
}

function isRunning() {
  return state.val?.run.phase === "running";
}

/** @param {VcuReadTally} tally */
function describeMicros(tally) {
  if (tally.micros.length === 0) {
    return "no micro has answered yet";
  }
  return tally.micros.map(micro => `${micro.micro}: ${micro.read} read, ${micro.failed} not`).join(" · ");
}
