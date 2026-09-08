// @ts-check

import van from "../vendor/van-1.6.1.js";
import { GOOD, MUTED, WARN, WATCH } from "../lib/colors.js";
import { arm, armDwellElapsed, armed, refuseKeyRepeat } from "../lib/arming.js";
import {
  ceilingIsFallback,
  fetchChargeWriteStatus,
  liveCeiling,
  liveChargeType,
  onChargeSessionEnd,
  sessionLive,
  writeStatus,
  writesEnabled,
} from "../lib/charge-write.js";

const { button, div, input } = van.tags;

// Command the charge current live, from the charge tab. The one control on the dashboard
// that changes the bike outside the service-mode sheet — so it carries most of the sheet's
// safety model with it: it POSTs through the gated /vcu-write endpoint (SERVICE_WRITE_ENABLED,
// the audit journal), it needs two taps separated by the shared dwell, and it renders NOTHING
// unless the Pi says writing is on AND a charge is live. A phone that has not been told writes
// are enabled sees an ordinary read-only charge screen.
//
// ⚠️ It does NOT use the stationary service gate (moving / energized / in-drive). A charging
// bike is energized and tethered by definition, so that gate misfits a charging operation and
// would flap with the trickle; the appropriate precondition is "a charge is live", which is what
// gates this. The Pi exempts charge-current from that gate for the same reason (write-runner.ts).
//
// ⚠️ Nothing here decides the opcode or the ceiling — the Pi reads charge_manager_state live and
// echoes the dash's own ceiling (docs/can-0x121-charge-command.md). The AC/DC label and the
// ceiling shown here are read off the SAME live signals so the button says what the Pi will
// do, but where they and the server disagree the server wins and its reason is shown.

/** @typedef {import("../../src/http/vcu-write.ts").VcuWriteResponse} VcuWriteResponse */

/** What the owner typed, as text so an empty box is distinct from a zero. */
const amps = van.state("");
const busy = van.state(false);
/** True only while the command's own POST is in flight, so "Sending…" cannot be shown for a status refresh. */
const sending = van.state(false);
const message = van.state("");
/** The last command's outcome, shown against the amps it was for. */
const lastResult = van.state(/** @type {{ amps: number, succeeded: boolean } | null} */ (null));

// The form clears when the charge ends — a new session starts blank. Session tracking, the lazy
// status fetch and the live AC/DC/ceiling reads all live in ../lib/charge-write.js, shared with
// the stop control.
onChargeSessionEnd(forgetCommand);

export const ARMED_KEY = "charge-current";

/**
 * The control, or an empty node when it must not be offered.
 *
 * ⚠️ Hidden — not merely disabled — for a phone that never enabled writes: `enabled === true`
 * gates that, and an undefined status is not enabled. Once shown for a live charge it STAYS shown
 * across a current pause, rather than vanishing (which a phone reads as "it broke"). Visibility is
 * `sessionLive && enabled`, both plain states, no serverTime. ⚠️ The stationary service gate is
 * deliberately NOT a condition here — see the file header and write-runner.ts.
 */
export function ChargeCurrentControl() {
  return div(() => {
    if (!sessionLive.val || writeStatus.val?.status?.enabled !== true) {
      return div();
    }
    return div(
      { class: "tile span2" },
      div({ class: "label" }, "Set charge current"),
      Situation(),
      InputRow(),
      SetButton(),
      Outcome()
    );
  });
}

/**
 * What can be commanded right now: the source, the ceiling, or why neither is available.
 *
 * The two "not yet" states are the Pi's own refusals said BEFORE the button is pressed, so
 * the remedy (plug in; nudge the dial) is read where it is actionable rather than after a
 * 409. AC's ceiling is an event the dash only broadcasts when the dial moves, so its absence
 * is normal and gets a remedy, not an error.
 */
function Situation() {
  return div({ class: "action-note" }, () => {
    const type = liveChargeType();
    if (type === null) {
      // charge_manager_state briefly out of a settled AC/DC value (a pause or handshake step) —
      // the tile stays; the button waits for it. A real unplug clears sessionLive and hides this.
      return div({ style: `color:${MUTED}` }, "Charge state changing — hold on.");
    }
    const ceiling = liveCeiling(type);
    if (ceiling === null) {
      // Only DC reaches here now — AC falls back to a default ceiling (see liveCeiling).
      return div(
        { style: `color:${WARN}` },
        "⚠️ DC ceiling (fast_dc_limit_max_a) has not arrived — this means CAN is not being received."
      );
    }
    if (ceilingIsFallback(type)) {
      return div(
        { style: `color:${WATCH}` },
        `Live AC charge · using the default ceiling ${ceiling} A (the dial has not been nudged this session, so the dash has broadcast no ceiling). Whole amps, 1…${ceiling}. `,
        "If this charger's rating differs from " +
          `${ceiling} A the bike may ignore the command and settle near 10 A — check charge_limit_a on the dash after sending.`
      );
    }
    return div(
      { style: `color:${MUTED}` },
      `Live ${type.toUpperCase()} charge · ceiling ${ceiling} A. Whole amps, 1…${ceiling}. `,
      "The Pi picks AC/DC and the ceiling from the live bus — this echoes them."
    );
  });
}

function InputRow() {
  // ⚠️ The <input> is created ONCE, not inside a binding. A binding that re-ran on a live
  // signal would replace the element mid-keystroke and take the cursor with it — so only the
  // placeholder and disabled ATTRIBUTES are reactive (thunks), which VanJS updates in place.
  return div(
    { class: "probe-field" },
    input({
      class: "probe-input",
      type: "text",
      inputmode: "numeric",
      placeholder: () => {
        const type = liveChargeType();
        const ceiling = type === null ? null : liveCeiling(type);
        return ceiling === null ? "amps" : `1…${ceiling}`;
      },
      disabled: () => !commandable(),
      value: amps,
      oninput: (/** @type {Event} */ event) => {
        amps.val = /** @type {HTMLInputElement} */ (event.target).value;
        // Retyping disarms: the second tap must send the number now on screen, not the one
        // the first tap agreed to.
        armed.val = "";
      },
    })
  );
}

function SetButton() {
  return div(
    button(
      {
        // The reversible/amber tier, the same one the parameter write sits in: it changes
        // the bike and can be taken straight back (transient, the rider overrides on the
        // bike's screen), so it is on-screen and amber, not behind the red fold.
        class: "action writes",
        // One held Enter must not arm and then fire. See ../lib/arming.js.
        onkeydown: refuseKeyRepeat,
        disabled: () => busy.val || !commandable() || parsedAmps() === null,
        onclick: () => {
          if (armed.val !== ARMED_KEY) {
            void armChargeCurrent();
            return;
          }
          // The same dwell as every other second tap on the dashboard — the whole of what
          // stops a double-tap commanding a current nobody meant. Ignored inside the dwell,
          // not disarmed. See ../lib/arming.js.
          if (!armDwellElapsed()) {
            return;
          }
          armed.val = "";
          void performChargeCurrent();
        },
      },
      () => {
        if (sending.val) {
          return "⏳  Sending…";
        }
        if (busy.val) {
          return "⏳  Checking the bike is still safe to command…";
        }
        const value = parsedAmps();
        if (value === null) {
          const type = liveChargeType();
          const ceiling = type === null ? null : liveCeiling(type);
          return ceiling === null ? "✏️  Waiting for a live charge" : `✏️  Type the current to set (1…${ceiling})`;
        }
        const type = liveChargeType();
        const label = type === null ? "" : ` ${type.toUpperCase()} ${value} A`;
        return armed.val === ARMED_KEY ? `⚠️  Tap again to command${label}` : `✏️  Set${label}`;
      }
    ),
    div({ class: "action-note", style: `color:${MUTED}` }, () =>
      commandable()
        ? "Event frame with no reply — watch the dash's set value and the AC setpoint below to see it take. A full battery caps what actually flows."
        : ""
    )
  );
}

/**
 * The last command's outcome, and — once one has landed — where to look to confirm it.
 *
 * The hint is deliberately shown only afterwards: standing at the bike the moment the frame
 * has gone out is the moment "watch charge_limit_a" becomes useful, and before then it is
 * one more line competing with the input.
 */
function Outcome() {
  return div({ class: "action-note" }, () => {
    const result = lastResult.val;
    return div(
      message.val ? div({ style: `color:${result?.succeeded ? GOOD : WARN}` }, message.val) : div(),
      result?.succeeded
        ? div(
            { style: `color:${WATCH}` },
            `🔍  Commanded ${result.amps} A — the AC setpoint (charge_limit_a) should follow if the current allows.`
          )
        : div()
    );
  });
}

/**
 * Whether a command could be sent at all — a live charge with a known ceiling. The Pi
 * enforces every part of this again; this is the page declining to offer a button whose
 * request it knows would be refused.
 */
function commandable() {
  // Writes on for this Pi, plus a live session with a known ceiling. ⚠️ NOT gate.safe — the
  // stationary service gate does not apply to a charging operation (see the file header).
  if (!writesEnabled()) {
    return false;
  }
  const type = liveChargeType();
  return type !== null && liveCeiling(type) !== null;
}

/** The typed amps as a whole number in range, or null. The Pi validates again against the live ceiling. */
function parsedAmps() {
  const text = amps.val.trim();
  if (!/^\d+$/.test(text)) {
    return null;
  }
  const value = Number(text);
  const type = liveChargeType();
  const ceiling = type === null ? null : liveCeiling(type);
  if (ceiling === null || value < 1 || value > ceiling) {
    return null;
  }
  return value;
}

/** Clears what the form holds. Called when a charge ends — a new session starts blank. */
function forgetCommand() {
  amps.val = "";
  armed.val = "";
  message.val = "";
  lastResult.val = null;
}

/**
 * Refreshes the status, THEN arms — so whether writes are still enabled and the session still
 * live is the Pi's answer now, not its answer when the charge started. Does not arm if writes
 * went off, or the charge or its ceiling went away across the refresh.
 */
async function armChargeCurrent() {
  busy.val = true;
  try {
    await fetchChargeWriteStatus();
  } finally {
    busy.val = false;
  }
  if (commandable() && parsedAmps() !== null) {
    arm(ARMED_KEY);
  }
}

async function performChargeCurrent() {
  const value = parsedAmps();
  if (value === null) {
    return;
  }
  const query = new URLSearchParams({
    action: "charge-current",
    amps: String(value),
    // The confirm carries the amps, so a page showing one value cannot POST another. Built
    // from the same number the button is committing to.
    confirm: `charge-current-${value}`,
  });
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
    writeStatus.val = payload;
    message.val = payload.result?.message ?? payload.message ?? "";
  } catch (error) {
    // ⚠️ A request that did not come back may still have reached the bike — the frame goes
    // out before the response — so this is NOT "nothing happened". Lowering the current is
    // benign and overridable on the bike, but the message says the honest thing anyway.
    message.val =
      `Could not reach the Pi — ${error instanceof Error ? error.message : String(error)}. ` +
      "This does NOT guarantee nothing was sent — check the dash.";
    console.warn("charge-current: request failed", error);
  } finally {
    sending.val = false;
    busy.val = false;
  }
  armed.val = "";
  if (!payload || !payload.result) {
    // Transport failure, or a 400/409 refused before the bus (busy bus, no live session, bad
    // amps). `message` carries the reason; the typed value is kept so a retry needs no
    // re-typing.
    lastResult.val = null;
    return;
  }
  lastResult.val = { amps: value, succeeded: payload.result.succeeded };
}
