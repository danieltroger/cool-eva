// @ts-check
import van from "../vendor/van-1.6.1.js";
import { readingStatus, statusWord, freshValue } from "../lib/reading-status.js";
import { MUTED, WARN } from "../lib/colors.js";
import { arm, armDwellElapsed, armed, refuseKeyRepeat } from "../lib/arming.js";
import { chargeRequestReply } from "../lib/charge-request-display.js";
import { chargeAttemptText, chargeConfirmationText } from "../lib/charge-command-display.js";
import { chargeEdit } from "../lib/charge-edit.js";
import { valueOf } from "../lib/store.js";
import {
  applyWriteStatus,
  chargeType,
  fetchChargeWriteStatus,
  liveCeiling,
  onChargeSessionEnd,
  sessionLive,
  writesEnabled,
} from "../lib/charge-write.js";
import { request } from "../lib/transport.js";

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
  return div(
    { class: "tile layout-card charge-current-control", hidden: () => !sessionLive.val || !writesEnabled() },
    div({ class: "charge-label" }, () => `${chargeType.val === "ac" ? "AC" : "DC"} current request`),
    div({ class: "charge-control-row" }, InputRow(), SetButton()),
    Outcome()
  );
}

const { button, div, input, span } = van.tags;

// Constraints and retained findings: docs/charge-controls.md.

/** @typedef {import("../../src/http/vcu-write.ts").VcuWriteResponse} VcuWriteResponse */

/** What the owner typed, as text so an empty box is distinct from a zero. */
const amps = van.state(/** @type {string|null} */ (null));
const busy = van.state(false);
/** True only while the command's own POST is in flight, so "Sending…" cannot be shown for a status refresh. */
const sending = van.state(false);
const message = van.state("");
const attemptedAmps = van.state(/** @type {number|null} */ (null));
const attempt = van.state(/** @type {""|"sent"|"not-sent"|"uncertain"} */ (""));

// The form clears when the charge ends — a new session starts blank. Session tracking, the lazy
// status fetch and the live AC/DC/ceiling reads all live in ../lib/charge-write.js, shared with
// the stop control.
onChargeSessionEnd(forgetCommand);

export const ARMED_KEY = "charge-current";

// The Pi records its verdict as `charge_cmd_ack`, which reaches the page over the WebSocket the
// instant it settles. So the verdict arrives for free and this fetches once per settle, for the
// phrasing — `chargeAck`'s sentence is built on the Pi and is not in any signal.
// ⚠️ It used to poll /vcu-write every 2 s for 14 s, and then — unguarded — every heartbeat for the
// whole charge (#207). That payload re-read the parameter sweep and the entire append-only audit
// journal per request, on the event loop serving the 10 Hz WebSocket and the CAN RX handler.
//
// ⚠️ Guarded on the VALUE (docs/dashboard-decisions.md §"A guarded derive…"), and on
// `charge_cmd_ack_seq` rather than on the verdict. The verdict cannot carry this: two commands
// settling to the same code move it not at all, and the automatic controller does exactly that
// three times in a row while nobody is touching the phone. src/charge/ack-watch.ts says why.

let lastSettle = /** @type {number | null} */ (null);
van.derive(() => {
  const settle = valueOf("charge_cmd_ack_seq");
  if (!sessionLive.val || settle === null) {
    // Forgotten rather than consumed — trap #2. A session that ends, or a phone that has not seen
    // a settle yet, holds no answer, so the next one is news whatever its number.
    lastSettle = null;
    return;
  }
  if (settle === lastSettle) {
    return;
  }
  lastSettle = settle;
  void fetchChargeWriteStatus().then(landed => {
    // ⚠️ Trap #2 on the failing path, the same one charge-write.js has: the guard was taken on the
    // assumption this would land, so a request that did not must give it back or the verdict this
    // settle exists to phrase is lost until the next command. Only if nothing newer has claimed it.
    if (!landed && lastSettle === settle) {
      lastSettle = null;
    }
  });
});

function InputRow() {
  return div(
    { class: "layout-row charge-entry" },
    input({
      class: "probe-input charge-input",
      type: "number",
      inputmode: "numeric",
      min: minimumCurrent,
      max: () => (chargeType.val === null ? null : liveCeiling(chargeType.val)),
      step: 1,
      name: "charge-current-amps",
      autocomplete: "off",
      "aria-label": () => `${chargeType.val === "ac" ? "AC" : "DC"} current request in amperes`,
      placeholder: "—",
      "aria-invalid": () => String(amps.val !== null && commandable() && edit().value === null),
      disabled: () => busy.val || !commandable(),
      value: () => amps.val ?? (reportedCurrent() === null ? "" : String(reportedCurrent())),
      oninput: (/** @type {Event} */ event) => {
        amps.val = /** @type {HTMLInputElement} */ (event.target).value;
        armed.val = "";
        attempt.val = "";
        message.val = "";
      },
    }),
    span({ class: "unit" }, "A")
  );
}
function minimumCurrent() {
  return chargeType.val === "ac" ? 6 : 1;
}
function reportedCurrent() {
  return freshValue(chargeType.val === "ac" ? "charge_limit_a" : "fast_dc_target_a");
}
function edit() {
  const type = chargeType.val;
  return chargeEdit(amps.val, reportedCurrent(), minimumCurrent(), type === null ? null : liveCeiling(type));
}

function SetButton() {
  return div(
    button(
      {
        // The reversible/amber tier, the same one the parameter write sits in: it changes
        // the bike and can be taken straight back (transient, the rider overrides on the
        // bike's screen), so it is on-screen and amber, not behind the red fold.
        class: "control-button writes",
        "data-charge-action": "current",
        // One held Enter must not arm and then fire. See ../lib/arming.js.
        onkeydown: refuseKeyRepeat,
        disabled: () => busy.val || !commandable() || parsedAmps() === null || !edit().changed,
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
      () => (sending.val || busy.val ? "Waiting…" : armed.val === ARMED_KEY ? `Confirm ${parsedAmps()} A` : "Set")
    )
  );
}

function Outcome() {
  return div(
    {
      class: "charge-sub charge-control-status",
      "data-current-status": "",
      role: "status",
      title: () => message.val || chargeRequestReply().acknowledgement?.message || "",
      style: () => `color:${attempt.val === "not-sent" || attempt.val === "uncertain" ? WARN : MUTED}`,
    },
    () => {
      if (sending.val || busy.val) return "Waiting for bike…";
      if (attempt.val === "not-sent") return `${attemptedAmps.val} A · Not sent`;
      if (attempt.val === "uncertain") return `${attemptedAmps.val} A · Delivery uncertain`;
      const reply = chargeRequestReply();
      const acknowledgement = reply.acknowledgement;
      if (attempt.val === "sent")
        return chargeConfirmationText(attemptedAmps.val, freshValue("charge_cmd_a"), acknowledgement);
      if (amps.val !== null) {
        if (edit().value === null)
          return `Use ${minimumCurrent()}–${chargeType.val === null ? "—" : (liveCeiling(chargeType.val) ?? "—")} A`;
        if (edit().changed) return "Not sent";
      }
      const reported = reportedCurrent();
      return reported === null
        ? statusWord(readingStatus(chargeType.val === "ac" ? "charge_limit_a" : "fast_dc_target_a"), "Unavailable")
        : `Bike requests ${reported} A`;
    }
  );
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
  const type = chargeType.val;
  return type !== null && liveCeiling(type) !== null;
}

/** The typed amps as a whole number in range, or null. The Pi validates again against the live ceiling. */
function parsedAmps() {
  return edit().value;
}

/** Clears what the form holds. Called when a charge ends — a new session starts blank. */
function forgetCommand() {
  amps.val = null;
  attemptedAmps.val = null;
  attempt.val = "";
  armed.val = "";
  message.val = "";
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
    // No parameter picker on this tab, so the 269-name listing is 14 393 bytes of nothing it can
    // use — on the reply to a command, over garage wifi. See lib/charge-write.js.
    list: "0",
    action: "charge-current",
    amps: String(value),
    // The confirm carries the amps, so a page showing one value cannot POST another. Built
    // from the same number the button is committing to.
    confirm: `charge-current-${value}`,
  });
  attemptedAmps.val = value;
  attempt.val = "";
  message.val = "";
  sending.val = true;
  busy.val = true;
  let payload = /** @type {VcuWriteResponse | null} */ (null);
  try {
    const response = await request(`/vcu-write?${query}`, {
      method: "POST",
      cache: "no-store",
      // The write endpoint's header, deliberately NOT the read path's `service-mode`. See
      // src/http/vcu-write.ts.
      headers: { "X-Cool-Eva": "service-write" },
    });
    payload = /** @type {VcuWriteResponse} */ (await response.json());
    applyWriteStatus(payload);
    message.val = chargeAttemptText(value, payload);
  } catch (error) {
    // ⚠️ A request that did not come back may still have reached the bike — the frame goes
    // out before the response — so this is NOT "nothing happened". Lowering the current is
    // benign and overridable on the bike, but the message says the honest thing anyway.
    message.val =
      `${value} A request: could not reach the Pi — ${error instanceof Error ? error.message : String(error)}. ` +
      "This does NOT guarantee nothing was sent — check the dash.";
    console.warn("charge-current: request failed", error);
  } finally {
    sending.val = false;
    busy.val = false;
  }
  armed.val = "";
  attempt.val = payload?.result?.succeeded
    ? "sent"
    : payload?.chargeCurrentAttempt === "not-sent"
      ? "not-sent"
      : "uncertain";
}

van.derive(() => {
  if (
    attempt.val === "sent" &&
    amps.val !== null &&
    freshValue(chargeType.val === "ac" ? "charge_limit_a" : "fast_dc_target_a") === attemptedAmps.val &&
    edit().value === attemptedAmps.val
  ) {
    amps.val = null;
  }
});
