// @ts-check

import van from "../vendor/van-1.6.1.js";
import { GOOD, MUTED, WARN, WATCH } from "../lib/colors.js";
import { arm, armDwellElapsed, armed, refuseKeyRepeat } from "../lib/arming.js";
import {
  applyWriteStatus,
  chargeType,
  fetchChargeWriteStatus,
  onChargeSessionEnd,
  sessionLive,
  writesEnabled,
} from "../lib/charge-write.js";

const { button, div } = van.tags;

// Stop an active charge from the charge tab — the dashboard equivalent of the rider's two Mode
// presses on the bike. It sends the single 0x120 stop frame we cracked 2026-08-25
// (docs/can-0x121-charge-command.md — the 0x120 request-twin alone commits, the 0x121 half is
// redundant), through the SAME gated /vcu-write path and shared two-tap dwell as the set-current
// control beside it, and renders NOTHING unless writing is on AND a charge is live. Session
// tracking and the status fetch are shared (../lib/charge-write.js).
//
// ⚠️ Two taps, NOT press-and-hold, even though the bike's own gesture involves holding: the real
// command is a discrete frame sent once, so a hold would just re-send it. Stopping is the benign
// direction (worst case a charge halts), and it is source-agnostic — the same frame ends AC and
// DC — so there is nothing to type and nothing to choose; the Pi checks only that a charge is
// live. Like set-current it does NOT use the stationary service gate (a charging bike is
// energized and tethered by definition; write-runner.ts exempts it).

/** @typedef {import("../../src/http/vcu-write.ts").VcuWriteResponse} VcuWriteResponse */

const busy = van.state(false);
/** True only while the command's own POST is in flight, so "Sending…" is not shown for a status refresh. */
const sending = van.state(false);
const message = van.state("");
/** Whether the last stop landed on the bus (an event frame — not a confirmation it completed). */
const lastSent = van.state(/** @type {boolean | null} */ (null));

// Clear the outcome when the charge ends — a fresh session starts with a blank button.
onChargeSessionEnd(forgetStop);

export const ARMED_KEY = "charge-stop";

/**
 * The control, or an empty node when it must not be offered.
 *
 * ⚠️ Hidden — not merely disabled — for a phone that never enabled writes, and only shown while a
 * charge is live (there is nothing to stop otherwise). Visibility is `sessionLive && writesEnabled`,
 * both read off plain states, no serverTime.
 */
export function ChargeStopControl() {
  return div(() => {
    if (!sessionLive.val || !writesEnabled()) {
      return div();
    }
    return div({ class: "tile span2" }, div({ class: "label" }, "Stop charging"), StopButton(), Outcome());
  });
}

function StopButton() {
  return div(
    button(
      {
        // The reversible/amber tier: it changes the bike but is the benign direction and the
        // rider can simply re-start a charge, so it is on-screen and amber, not behind the red fold.
        class: "action writes",
        // One held Enter must not arm and then fire. See ../lib/arming.js.
        onkeydown: refuseKeyRepeat,
        disabled: () => busy.val || !commandable(),
        onclick: () => {
          if (armed.val !== ARMED_KEY) {
            void armChargeStop();
            return;
          }
          // The same dwell as every other second tap on the dashboard — the whole of what stops a
          // double-tap ending a charge nobody meant to. Ignored inside the dwell, not disarmed.
          if (!armDwellElapsed()) {
            return;
          }
          armed.val = "";
          void performChargeStop();
        },
      },
      () => {
        if (sending.val) {
          return "⏳  Sending…";
        }
        if (busy.val) {
          return "⏳  Checking the charge is still live…";
        }
        const type = chargeType.val;
        const label = type === null ? "the charge" : `the ${type.toUpperCase()} charge`;
        return armed.val === ARMED_KEY ? `⚠️  Tap again to stop ${label}` : `🛑  Stop ${label}`;
      }
    ),
    div({ class: "action-note", style: `color:${MUTED}` }, () =>
      commandable()
        ? "Emulates holding Mode on the bike — the charge winds down over a few seconds; unplug the cable when prompted."
        : ""
    )
  );
}

/**
 * The last stop's outcome, and — once one has landed — where to look to confirm it wound down.
 * The hint is shown only afterwards: standing at the bike the moment the frames have gone is when
 * "watch mains voltage fall" becomes useful.
 */
function Outcome() {
  return div({ class: "action-note" }, () => {
    const sent = lastSent.val;
    return div(
      message.val ? div({ style: `color:${sent ? GOOD : WARN}` }, message.val) : div(),
      sent
        ? div(
            { style: `color:${WATCH}` },
            "🔍  Sent — the charge should wind down over the next several seconds (mains voltage and charger_enabled fall)."
          )
        : div()
    );
  });
}

/**
 * Whether a stop could be sent at all — writes on for this Pi and a live charge. The Pi enforces
 * both again; this is the page declining to offer a button whose request it knows would be refused.
 * ⚠️ NOT gate.safe — the stationary service gate does not apply to a charging operation.
 */
function commandable() {
  return writesEnabled() && chargeType.val !== null;
}

/** Clears the outcome. Called when a charge ends. */
function forgetStop() {
  armed.val = "";
  message.val = "";
  lastSent.val = null;
}

/**
 * Refreshes the status, THEN arms — so whether writes are still enabled and the charge still live
 * is the Pi's answer now, not when the tile first rendered. Does not arm if either went away.
 */
async function armChargeStop() {
  busy.val = true;
  try {
    await fetchChargeWriteStatus();
  } finally {
    busy.val = false;
  }
  if (commandable()) {
    arm(ARMED_KEY);
  }
}

async function performChargeStop() {
  const query = new URLSearchParams({ action: "charge-stop", confirm: "charge-stop" });
  message.val = "";
  sending.val = true;
  busy.val = true;
  let payload = /** @type {VcuWriteResponse | null} */ (null);
  try {
    const response = await fetch(`/vcu-write?${query}`, {
      method: "POST",
      cache: "no-store",
      // The write endpoint's header, deliberately NOT the read path's `service-mode`. See
      // src/http/vcu-write.ts.
      headers: { "X-Cool-Eva": "service-write" },
    });
    payload = /** @type {VcuWriteResponse} */ (await response.json());
    applyWriteStatus(payload);
    message.val = payload.result?.message ?? payload.message ?? "";
  } catch (error) {
    // ⚠️ A request that did not come back may still have reached the bike — the frames go out
    // before the response — so this is NOT "nothing happened". Stopping is benign, but the
    // message says the honest thing anyway.
    message.val =
      `Could not reach the Pi — ${error instanceof Error ? error.message : String(error)}. ` +
      "This does NOT guarantee nothing was sent — check the dash.";
    console.warn("charge-stop: request failed", error);
  } finally {
    sending.val = false;
    busy.val = false;
  }
  armed.val = "";
  lastSent.val = payload?.result?.succeeded ?? null;
}
