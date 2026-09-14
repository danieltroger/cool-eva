// @ts-check

import van from "../vendor/van-1.6.1.js";
import { arm, armDwellElapsed, armed, refuseKeyRepeat } from "../lib/arming.js";
import { MUTED } from "../lib/colors.js";
import { serviceRefusal, serviceRefused } from "../lib/service-gate-caption.js";

// The service sheet's third read: every stored freeze frame — the `0x18` list of components
// that have a record, then `0x17` for each one.
//
// ⚠️ It lives in the SHEET and its results live on the Faults tab, which is the split
// ./lifetime-read.js already makes for the same reason: every control that puts a frame on
// the bike's bus is behind one gate, one arming convention and one refusal caption, and a
// second place to start a bus read would be a second place to forget one of the three.
//
// ⚠️ It arms like an irreversible action even though it only READS, and with more reason
// than the lifetime read has: this parks the 2 Hz OBD poller for up to twelve seconds — the
// speed, the rpm and the temperatures leave the dashboard AND the ride log for that long —
// and it is the one read whose length the bike decides. src/vcu/freeze-frame-read.ts.

/** @typedef {import("../../src/http/freeze-frame-read.ts").FreezeFrameReadResponse} FreezeFrameReadResponse */

const { button, div } = van.tags;

/** This control's arming key. Exported so scripts/check-arming.ts can resolve the site. */
export const ARMED_KEY = "freeze-frame-read";
const busy = van.state(false);
const message = van.state("");

/**
 * The button, and whatever the last read said.
 *
 * @param {() => { enabled: boolean; gate: { safe: boolean } } | null} readState the sheet's
 *   own /vcu-read state, which already carries the gate and the switch this shares.
 */
export function FreezeFrameReadButton(readState) {
  return div(
    button(
      {
        class: "action",
        // One held Enter must not arm and then fire. See ../lib/arming.js.
        onkeydown: refuseKeyRepeat,
        disabled: () => busy.val || serviceRefused(readState()),
        onclick: () => {
          if (armed.val !== ARMED_KEY) {
            arm(ARMED_KEY);
            return;
          }
          // Ignored inside the dwell, not disarmed — the rule every other second tap on
          // this dashboard follows.
          if (!armDwellElapsed()) {
            return;
          }
          armed.val = "";
          void performFreezeFrameRead();
        },
      },
      () => {
        if (busy.val) {
          return "⏳  Reading every stored freeze frame…";
        }
        const refusal = serviceRefusal(readState());
        if (refusal !== null) {
          return refusal;
        }
        if (armed.val === ARMED_KEY) {
          return "⚠  Tap again — this parks the OBD poller for up to 12 s";
        }
        return "🔎  Read the stored freeze frames";
      }
    ),
    () => (message.val ? div({ class: "action-note" }, message.val) : div()),
    div(
      { class: "action-note", style: `color:${MUTED}` },
      "What the VCU recorded when each stored code set. Shown under the codes on the Faults tab."
    )
  );
}

/** Clears the last result. Called when the sheet opens, alongside everything else it disarms. */
export function refreshFreezeFrameRead() {
  message.val = "";
}

async function performFreezeFrameRead() {
  busy.val = true;
  message.val = "";
  try {
    const response = await fetch("/freeze-frame-read", {
      method: "POST",
      cache: "no-store",
      headers: { "X-Cool-Eva": "service-mode" },
    });
    const payload = /** @type {FreezeFrameReadResponse} */ (await response.json());
    // ⚠️ The summary AND the message, never one instead of the other: a read that was
    // correctly refused storage still happened, and what it found is the thing worth
    // seeing. src/vcu/freeze-frame-store.ts decides; this only reports what it decided.
    message.val = [payload.summary, payload.message].filter(Boolean).join(" · ");
  } catch (error) {
    // ⚠️ A request that did not come back may still have reached the bike — the frames go
    // out before the response — and the reading may well be stored. Says so rather than
    // implying nothing happened.
    console.warn("freeze-frame-read: request failed", error);
    message.val =
      `Could not reach the Pi — ${error instanceof Error ? error.message : String(error)}. ` +
      "The read may have completed anyway; the Faults tab shows the age of what is stored.";
  } finally {
    busy.val = false;
  }
}
