// @ts-check

import van from "../vendor/van-1.6.1.js";
import { arm, armDwellElapsed, armed, refuseKeyRepeat } from "../lib/arming.js";
import { MUTED } from "../lib/colors.js";

// The service sheet's second read: the bike's lifetime battery statistics, off
// components 51 and 52, in-process.
//
// Its own module rather than more of ./service-mode.js, which was already at 387 lines
// before this feature and past the guideline after it. The sheet composes it; the gate
// state it reads belongs to the sheet and is passed in.
//
// ⚠️ It arms like an irreversible action even though it only READS. The sweep's excuse
// — that the worst an unmeant double-tap buys is 277 read requests — does not carry
// here: this also parks the 2 Hz OBD poller for the duration, which takes speed, rpm
// and the temperatures off the dashboard while it runs. src/vcu/lifetime-read.ts.

/** @typedef {import("../../src/http/lifetime-read.ts").LifetimeReadResponse} LifetimeReadResponse */

const { button, div } = van.tags;

/**
 * This control's arming key.
 *
 * Exported the way ./charge-current.js and ./charge-stop.js export theirs, because
 * scripts/check-arming.ts resolves a site's `armed.val !== ARMED_KEY` through the
 * export — a locally-scoped one leaves the check unable to say which key it is.
 */
export const ARMED_KEY = "lifetime-read";
const busy = van.state(false);
const message = van.state("");

/**
 * The button, and whatever the last read said.
 *
 * @param {() => { enabled: boolean; gate: { safe: boolean } } | null} readState the sheet's
 *   own /vcu-read state, which already carries the gate and the switch this shares.
 */
export function LifetimeReadButton(readState) {
  return div(
    button(
      {
        class: "action",
        // One held Enter must not arm and then fire. See ../lib/arming.js.
        onkeydown: refuseKeyRepeat,
        disabled: () => {
          const state = readState();
          return busy.val || (state !== null && (!state.enabled || !state.gate.safe));
        },
        onclick: () => {
          if (armed.val !== ARMED_KEY) {
            arm(ARMED_KEY);
            return;
          }
          // Ignored inside the dwell, not disarmed — the rule every other second tap
          // on this dashboard follows.
          if (!armDwellElapsed()) {
            return;
          }
          armed.val = "";
          void performLifetimeRead();
        },
      },
      () => {
        const state = readState();
        if (busy.val) {
          return "⏳  Reading components 51 and 52…";
        }
        if (state !== null && !state.enabled) {
          return "🔒  Reads are off on this Pi (SERVICE_MODE_ENABLED=0)";
        }
        if (state !== null && !state.gate.safe) {
          return "🚫  The bike is not parked and out of drive";
        }
        if (armed.val === ARMED_KEY) {
          return "⚠  Tap again — this parks the OBD poller while it reads";
        }
        return "🔎  Read the lifetime battery statistics";
      }
    ),
    () => (message.val ? div({ class: "action-note" }, message.val) : div()),
    div(
      { class: "action-note", style: `color:${MUTED}` },
      "Components 51 and 52 — charges, charge moved, pack health. Shown on the All tab with the age of the reading."
    )
  );
}

/** Clears the last result. Called when the sheet opens, alongside everything else it disarms. */
export function refreshLifetimeRead() {
  message.val = "";
}

async function performLifetimeRead() {
  busy.val = true;
  message.val = "";
  try {
    const response = await fetch("/lifetime-read", {
      method: "POST",
      cache: "no-store",
      headers: { "X-Cool-Eva": "service-mode" },
    });
    const payload = /** @type {LifetimeReadResponse} */ (await response.json());
    // ⚠️ Both the measurement and the message, never one instead of the other: a run
    // refused storage still took a measurement, and that measurement is the point of
    // the in-service path. docs/lifetime-battery-statistics.md.
    message.val = [
      payload.answered === null ? null : `Read ${payload.answered}/2 components`,
      payload.measurement,
      payload.message,
    ]
      .filter(Boolean)
      .join(" · ");
  } catch (error) {
    // ⚠️ A request that did not come back may still have reached the bike — the frames
    // go out before the response — and the reading may well be stored. Says so rather
    // than implying nothing happened.
    message.val =
      `Could not reach the Pi — ${error instanceof Error ? error.message : String(error)}. ` +
      "The read may have completed anyway; the All tab shows the age of what is stored.";
  } finally {
    busy.val = false;
  }
}
