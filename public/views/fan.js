// @ts-check

import van from "../vendor/van-1.6.1.js";
import { BAD, GOOD, MUTED, WARN } from "../lib/colors.js";
import { arm, armDwellElapsed, armed, refuseKeyRepeat } from "../lib/arming.js";
import { valueOf } from "../lib/store.js";

const { button, div, h2, input } = van.tags;

// Manual duty for the watercooling loop's fan, in the menu sheet — this is a thing you
// do standing next to the bike in the garage, not at 90 km/h.
//
// It renders NOTHING unless this Pi answers /fan, which it only does with FAN_ENABLED=1
// (src/index.ts routes the endpoint behind that flag), so a bike with no fan sees an
// unchanged sheet. Behind the same two-tap dwell as every other control that actuates
// something — a brush against a slider on a phone lying on a workbench must not be able
// to spin a fan blade to full.
//
// ⚠️ Nothing here decides policy. The 30 % floor, the cap and the kick-start length are
// the Pi's (src/fan/control.ts) and are read off `limits` in its reply, so this page
// cannot come to disagree with the thing holding the PWM.

/** @typedef {import("../../src/http/fan.ts").FanReply} FanReply */

export const ARMED_KEY = "fan-duty";

/** Whether this Pi serves /fan at all. Null until the first fetch has answered. */
const available = van.state(/** @type {boolean | null} */ (null));

/** The last reply: the driver's phase, its fault if any, and the limits it enforces. */
const status = van.state(/** @type {FanReply | null} */ (null));

/** Where the slider is, which is NOT what the fan is doing until the button is tapped. */
const pendingDuty = van.state(0);

const busy = van.state(false);
/** True only while a command's own POST is in flight, so a status refresh cannot say "Sending…". */
const sending = van.state(false);
const message = van.state("");
/** Whether the last command was accepted, so its message is coloured by its own outcome. */
const lastCommandOk = van.state(/** @type {boolean | null} */ (null));

/**
 * The section, or an empty node on a Pi with no fan.
 *
 * Its own heading rather than one in ./sheet.js, so the heading disappears with the
 * controls instead of standing over nothing — the same shape VcuWrite() uses.
 */
export function FanControl() {
  return div(() => {
    if (available.val !== true) {
      return div();
    }
    return div(
      h2({ class: "sheet-heading" }, "Cooling fan"),
      div({ class: "sheet-heading-note" }, "Drives the loop's fan off the Pi's own GPIO. Never touches the bike."),
      FaultNote(),
      Situation(),
      Slider(),
      SetButton(),
      Outcome()
    );
  });
}

/**
 * GETs the driver's state. Read-only; it spins nothing.
 *
 * A 404 is the answer on a Pi where FAN_ENABLED is unset — index.ts does not route /fan
 * at all there, so the static handler replies — and it is not an error: almost no Eva has
 * this fan. Either way the section stays hidden.
 */
export async function refreshFanStatus() {
  try {
    const response = await fetch("/fan", { cache: "no-store" });
    if (!response.ok) {
      available.val = false;
      status.val = null;
      return;
    }
    const payload = /** @type {FanReply} */ (await response.json());
    // Disarmed before the new status lands: a driver that has since faulted must not
    // leave a primed button behind. Only this control's own key, because the refresh is
    // about the fan and says nothing about whatever else the page had armed.
    if (armed.val === ARMED_KEY) {
      armed.val = "";
    }
    status.val = payload;
    // The thumb follows a cap that came down: the slider's `max` alone would clamp what
    // the element SHOWS while this state kept the old number, and that number is what
    // the button POSTs.
    if (pendingDuty.val > maxPercent()) {
      pendingDuty.val = maxPercent();
    }
    available.val = true;
  } catch (error) {
    // Loud, but not fatal to the rest of the sheet: a failed fetch simply leaves the
    // section hidden, which is the safe direction.
    console.warn("fan: status fetch failed", error);
    available.val = false;
  }
}

/** The loudest thing this section has: a driver that is configured and cannot be used. */
function FaultNote() {
  return div(() => {
    const fault = status.val?.fault ?? null;
    if (fault === null) {
      return div();
    }
    return div({ class: "action-note failure" }, `⚠️  The fan driver did not come up: ${fault}`);
  });
}

/**
 * What the fan is doing right now, from the live signals rather than from the last reply
 * — the reply is only as fresh as the fetch, and the signals arrive on the WebSocket.
 * A duty of 100 with a lower target on the button is a kick-start in progress.
 */
function Situation() {
  return div({ class: "action-note" }, () => {
    const duty = valueOf("fan_duty_pct");
    const driverEnabled = valueOf("fan_driver_enabled");
    if (duty == null || driverEnabled == null) {
      return div({ style: `color:${MUTED}` }, "The fan driver has not reported yet.");
    }
    if (driverEnabled !== 1) {
      return div({ style: `color:${MUTED}` }, "Standby — both enables LOW, so the rotor freewheels.");
    }
    // ⚠️ Enabled at 0 % is NOT a stopped fan: with the high side never switching the
    // BTS7960 leaves both low sides on, which shorts the winding and brakes the rotor.
    // src/fan/control.ts refuses to reach this state on purpose, so seeing it means a
    // stop failed halfway. It is the loudest thing this tile can say, not a green one.
    if (duty === 0) {
      return div(
        { style: `color:${BAD}` },
        "⚠️  Enables HIGH at 0 % — the bridge is BRAKING the rotor, not idling it. Cut power to the IBT-2."
      );
    }
    return div({ style: `color:${GOOD}` }, `Running at ${duty} %.`);
  });
}

function Slider() {
  // ⚠️ The <input> is created ONCE, not inside a binding. A binding that re-ran on a live
  // signal would replace the element mid-drag and take the gesture with it — so only the
  // `disabled` ATTRIBUTE is reactive (a thunk), which VanJS updates in place.
  return div(
    { class: "probe-field" },
    input({
      class: "fan-slider",
      type: "range",
      min: "0",
      // The Pi's cap, not a literal 100 — so a cap lowered to hold the fan's average
      // voltage (docs/fan-control.md §4) stops this page offering duties the endpoint
      // would answer 400 to. A thunk, like `disabled`, for the reason above.
      max: () => String(maxPercent()),
      // 5 % steps. Finer is not a duty this fan resolves, and it costs precision the
      // thumb does not have on a phone.
      step: "5",
      disabled: () => !commandable(),
      value: pendingDuty,
      oninput: (/** @type {Event} */ event) => {
        pendingDuty.val = Number(/** @type {HTMLInputElement} */ (event.target).value);
        // Dragging disarms: the second tap must command the duty now on screen, not the
        // one the first tap agreed to.
        if (armed.val === ARMED_KEY) {
          armed.val = "";
        }
      },
    }),
    div({ class: "action-note", style: `color:${MUTED}` }, () => describeCommand(pendingDuty.val))
  );
}

function SetButton() {
  return div(
    button(
      {
        // The reversible/amber tier, like the charge-current write: it moves a real motor
        // and the next command takes it straight back. Nothing here is irreversible, so
        // it is on-screen rather than behind the red fold.
        class: "action writes",
        // One held Enter must not arm and then fire. See ../lib/arming.js.
        onkeydown: refuseKeyRepeat,
        disabled: () => busy.val || !commandable(),
        onclick: () => {
          if (armed.val !== ARMED_KEY) {
            void armFan();
            return;
          }
          // The same dwell as every other second tap on this dashboard — the whole of
          // what stops a double-tap spinning the fan up. Ignored inside the dwell, not
          // disarmed. See ../lib/arming.js.
          if (!armDwellElapsed()) {
            return;
          }
          armed.val = "";
          void performFanCommand();
        },
      },
      () => {
        if (sending.val) {
          return "⏳  Sending…";
        }
        if (busy.val) {
          return "⏳  Checking the fan driver…";
        }
        const action = describeCommand(pendingDuty.val);
        return armed.val === ARMED_KEY ? `⚠️  Tap again to ${action}` : `🌀  ${action}`;
      }
    ),
    div({ class: "action-note", style: `color:${MUTED}` }, () =>
      pendingDuty.val >= minRunningPercent() && valueOf("fan_driver_enabled") !== 1
        ? `From rest the fan is held at 100 % for ${kickStartMs()} ms first, so a stiff rotor gets full ` +
          `torque to break away with rather than a duty it can sit and hum at.`
        : ""
    )
  );
}

/** The last command's outcome, in the Pi's own words and coloured by its own verdict. */
function Outcome() {
  return div({ class: "action-note" }, () =>
    message.val ? div({ style: `color:${lastCommandOk.val === false ? WARN : GOOD}` }, message.val) : div()
  );
}

/**
 * What tapping the button now would do — one sentence, shared by the button and the
 * caption under the slider so the two can never describe different commands.
 * @param {number} duty
 */
function describeCommand(duty) {
  if (duty < minRunningPercent()) {
    return duty === 0 ? "stop the fan" : `stop the fan (${duty} % is under the Pi's ${minRunningPercent()} % minimum)`;
  }
  return `run the fan at ${duty} %`;
}

/** Whether a command could be sent at all. The Pi enforces every part of this again. */
function commandable() {
  const current = status.val;
  return current !== null && current.fault === null;
}

/** The Pi's floor, so this page cannot disagree with the thing holding the PWM. */
function minRunningPercent() {
  return status.val?.limits.minRunningPercent ?? 0;
}

/** The Pi's cap. 0 without a reply, which leaves the slider inert rather than guessing 100. */
function maxPercent() {
  return status.val?.limits.maxPercent ?? 0;
}

function kickStartMs() {
  return status.val?.limits.kickStartMs ?? 0;
}

/**
 * Refreshes the status, THEN arms — so whether the driver is still usable is the Pi's
 * answer now rather than its answer when the sheet was opened.
 */
async function armFan() {
  busy.val = true;
  try {
    await refreshFanStatus();
  } finally {
    busy.val = false;
  }
  if (commandable()) {
    arm(ARMED_KEY);
  }
}

async function performFanCommand() {
  const duty = pendingDuty.val;
  message.val = "";
  sending.val = true;
  busy.val = true;
  try {
    const response = await fetch(`/fan?duty=${duty}`, {
      method: "POST",
      cache: "no-store",
      // Not decoration: a custom header is what makes this NOT a simple request, so a
      // cross-origin form cannot reach the endpoint. See src/http/fan.ts.
      headers: { "X-Cool-Eva": "fan" },
    });
    const payload = /** @type {FanReply} */ (await response.json());
    status.val = payload;
    message.val = payload.message ?? "";
    lastCommandOk.val = response.ok;
  } catch (error) {
    // ⚠️ A request that did not come back may still have reached the Pi — the sysfs write
    // happens before the response — so this is NOT "nothing happened". Say so, and let
    // the live signals above be the thing that settles it.
    message.val =
      `Could not reach the Pi — ${error instanceof Error ? error.message : String(error)}. ` +
      "This does NOT guarantee the fan was left alone — watch the line above.";
    lastCommandOk.val = false;
    console.warn("fan: command failed", error);
  } finally {
    sending.val = false;
    busy.val = false;
  }
  armed.val = "";
}
