// @ts-check

import van from "../vendor/van-1.6.1.js";
import { BAD, GOOD, MUTED, WARN } from "../lib/colors.js";
import { valueOf } from "../lib/store.js";
import {
  FAN_MODE_CODE,
  FUN_GATE_TEXT,
  TEMPERATURE_FAULT_REASON,
  describeAutoReason,
  dutyStopIndex,
  dutyStops,
  formatDuty,
} from "../lib/fan-display.js";
import { createFanCommandQueue } from "../lib/fan-command-queue.js";

const { button, div, h2, input } = van.tags;

// Duty and mode for the watercooling loop's fan, in the menu sheet.
//
// It renders NOTHING unless this Pi answers /fan, which it only does with FAN_ENABLED=1
// (src/index.ts routes the endpoint behind that flag), so a bike with no fan sees an
// unchanged sheet.
//
// ⚠️ There is deliberately NO two-tap arm here, unlike every control on this sheet that
// touches the motorcycle. This one moves a GPIO on the Pi, the next command takes it
// straight back, and the fan is a thing you watch while you drag — so the slider is live
// on `oninput`. What that costs and why it is worth it: docs/fan-control.md §"The slider".
//
// ⚠️ Nothing here decides policy. The 30 % floor, the cap, the kick-start length and the
// curve's own temperatures are the Pi's (src/fan/control.ts, src/fan/curve.ts) and are
// read off `limits` in its reply, so this page cannot come to disagree with the thing
// holding the PWM. Fun mode goes further: this page cannot ENTER it, only ask, and the
// Pi re-reads the gate off the bus before it agrees. The button below appearing is a
// display of `fan_fun_available`, never the permission itself.

/** @typedef {import("../../src/http/fan.ts").FanReply} FanReply */
/** @typedef {import("../../src/fan/auto.ts").FanMode} FanMode */
/** @typedef {import("../lib/fan-command-queue.js").FanCommand} FanCommand */

/** Whether this Pi serves /fan at all. Null until the first fetch has answered. */
const available = van.state(/** @type {boolean | null} */ (null));

/** The last reply: the driver's phase, its fault if any, and the limits it enforces. */
const status = van.state(/** @type {FanReply | null} */ (null));

/**
 * Where the slider is. In manual this is what the rider chose; in automatic and in fun
 * mode it follows `fan_target_pct` through the derive below, so the thumb tracks the
 * curve — or the rider's own wrist — live.
 */
const pendingDuty = van.state(0);

/** Automatic, manual or fun, optimistically ahead of the Pi so a tap looks instant. */
const mode = van.state(/** @type {FanMode} */ ("automatic"));

/**
 * True while a command is queued or in flight, raised by ../lib/fan-command-queue.js.
 *
 * ⚠️ Load-bearing, not cosmetic: it is what stops the two derives below dragging the
 * slider and the toggle back to the Pi's *previous* answer during the round trip.
 */
const settling = van.state(false);

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
      Reason(),
      div({ class: "fan-row" }, ModeToggle(), FunToggle(), Slider()),
      div({ class: "action-note", style: `color:${MUTED}` }, () => describeCommand(pendingDuty.val)),
      KickNote(),
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
    adoptReply(/** @type {FanReply} */ (await response.json()));
    available.val = true;
  } catch (error) {
    // Loud, but not fatal to the rest of the sheet: a failed fetch simply leaves the
    // section hidden, which is the safe direction.
    console.warn("fan: status fetch failed", error);
    available.val = false;
  }
}

// The mode the Pi reports, mirrored into the toggle — but never while this page has a
// command of its own outstanding, or a reply describing the state BEFORE that command
// would flip the toggle back under the rider's thumb.
van.derive(() => {
  const live = valueOf("fan_auto_mode");
  if (live === null || settling.val) {
    return;
  }
  // ⚠️ Through FAN_MODE_CODE rather than a bare 1 and 2. This is also the line that
  // shows the rider fun mode ENDING on its own: the Pi hands the fan back the instant
  // the bike can move, and this is where the sheet finds out.
  mode.val = live === FAN_MODE_CODE.AUTOMATIC ? "automatic" : live === FAN_MODE_CODE.FUN ? "fun" : "manual";
});

// In automatic the thumb follows what the curve is commanding, and in fun mode what the
// throttle is — watching the slider track your own wrist is most of the fun. Only manual
// pins it, because there the thumb is the source. `fan_target_pct` and not `fan_duty_pct`:
// the two differ only during a kick-start, and a thumb that slammed to 100 % and back for
// 1500 ms would look like the page had lost the plot.
van.derive(() => {
  const target = valueOf("fan_target_pct");
  if (target === null || mode.val === "manual" || settling.val) {
    return;
  }
  pendingDuty.val = target;
});

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
 */
function Situation() {
  return div({ class: "action-note" }, () => {
    const duty = valueOf("fan_duty_pct");
    const target = valueOf("fan_target_pct");
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
    // ⚠️ Enabled and driving with nothing asked for. src/fan/control.ts sets the target
    // before it touches the bridge, so this is not a transient — it is a STOP that got
    // as far as failing to drop the enables and correctly refused to zero the duty
    // underneath them (which would have braked the rotor). The fan is still spinning.
    if (target === 0) {
      return div(
        { style: `color:${BAD}` },
        `⚠️  Still driving at ${formatDuty(duty)} % after a stop that failed. The PWM was left alone on purpose — ` +
          `dropping it ` +
          "with the enables HIGH would brake the rotor. Cut power to the IBT-2."
      );
    }
    // The kick-start, which is the only other time the applied duty runs ahead of the target.
    if (target != null && duty > target) {
      return div(
        { style: `color:${WARN}` },
        `Kick-starting at ${formatDuty(duty)} % — it settles at ${formatDuty(target)} % in a moment.`
      );
    }
    return div({ style: `color:${GOOD}` }, `Running at ${formatDuty(duty)} %.`);
  });
}

/** Why the curve chose what it chose, live off `fan_auto_reason` / `fan_temp_input`. */
function Reason() {
  return div({ class: "action-note" }, () => {
    // In fun mode the interesting sentence is the GATE's, not the curve's: it says what
    // is letting the throttle drive the fan, which is also what will end the session
    // when it stops being true.
    if (valueOf("fan_auto_mode") === FAN_MODE_CODE.FUN) {
      const gate = valueOf("fan_fun_gate");
      return div({ style: `color:${MUTED}` }, gate === null ? "" : (FUN_GATE_TEXT[gate] ?? ""));
    }
    if (valueOf("fan_auto_mode") !== FAN_MODE_CODE.AUTOMATIC) {
      return div();
    }
    const sentence = describeAutoReason(valueOf("fan_auto_reason"), valueOf("fan_temp_input"));
    if (sentence === "") {
      return div();
    }
    // This one reason is the fail-safe firing: no usable pack temperature for a minute.
    // It is a fault, not a note, and the one state this section must not render quietly.
    const failing = valueOf("fan_auto_reason") === TEMPERATURE_FAULT_REASON;
    return div({ style: `color:${failing ? BAD : MUTED}` }, sentence);
  });
}

/**
 * The mode, as a label that always tells the truth and a tap that only ever goes between
 * the two ordinary modes. Fun mode is entered from its own button below and leaves here,
 * so the tap target does not grow a third state that appears and vanishes under a thumb.
 */
function ModeToggle() {
  return button(
    {
      class: () => `fan-mode${mode.val === "automatic" ? " automatic" : ""}`,
      // Not gated on a command being in flight: they coalesce, and a toggle that
      // flickered disabled through a drag would be the drag's own POSTs doing it.
      disabled: () => !commandable(),
      onclick: () => {
        const next = /** @type {FanMode} */ (mode.val === "manual" ? "automatic" : "manual");
        mode.val = next;
        commandQueue.queue({ mode: next });
      },
    },
    () => (mode.val === "automatic" ? "🌡️  Auto" : mode.val === "fun" ? "🎢  Fun" : "✋  Manual")
  );
}

/**
 * The fun-mode button — and the whole of "only shows up with the bike in park".
 *
 * ⚠️ It is bound to `fan_fun_available`, the LIVE signal, not to the last `/fan` reply:
 * the reply is as old as the fetch, and this control has to disappear the moment the bike
 * can move rather than at the next time somebody happens to reload. Hidden while fun mode
 * is running too — the mode toggle already reads "Fun" and is how you leave.
 */
function FunToggle() {
  return div(() => {
    if (mode.val === "fun" || valueOf("fan_fun_available") !== 1 || !commandable()) {
      return div();
    }
    return button(
      {
        class: "fan-mode",
        onclick: () => {
          mode.val = "fun";
          commandQueue.queue({ mode: "fun" });
        },
      },
      "🎢  Fun"
    );
  });
}

function Slider() {
  // ⚠️ The <input> is created ONCE, not inside a binding. A binding that re-ran on a live
  // signal would replace the element mid-drag and take the gesture with it — so only the
  // ATTRIBUTES are reactive (thunks), which VanJS updates in place.
  //
  // ⚠️ And the slider's value is an INDEX into the stop list, not a percentage. That is
  // what removes the dead zone: every position is a duty the Pi will take. See
  // ../lib/fan-display.js.
  return input({
    class: "fan-slider",
    type: "range",
    min: "0",
    max: () => String(stops().length - 1),
    step: "1",
    disabled: () => !commandable(),
    value: () => String(dutyStopIndex(stops(), pendingDuty.val)),
    oninput: (/** @type {Event} */ event) => {
      const index = Number(/** @type {HTMLInputElement} */ (event.target).value);
      const duty = stops()[index] ?? 0;
      pendingDuty.val = duty;
      // Dragging IS the switch to manual. Without it the next automatic tick — at most
      // AUTO_TICK_MS away — would put the curve's own duty straight back.
      mode.val = "manual";
      commandQueue.queue({ duty });
    },
  });
}

/** The kick-start caption, shown only when the next command would start the fan from rest. */
function KickNote() {
  return div({ class: "action-note", style: `color:${MUTED}` }, () =>
    pendingDuty.val >= minRunningPercent() && valueOf("fan_driver_enabled") !== 1
      ? `From rest the fan is held at 100 % for ${kickStartMs()} ms first, so a stiff rotor gets full ` +
        `torque to break away with rather than a duty it can sit and hum at.`
      : ""
  );
}

/** The last command's outcome, in the Pi's own words and coloured by its own verdict. */
function Outcome() {
  return div({ class: "action-note" }, () =>
    message.val ? div({ style: `color:${lastCommandOk.val === false ? WARN : GOOD}` }, message.val) : div()
  );
}

/**
 * What the slider is asking for now — one sentence under it, so the number on the thumb
 * is never the only thing saying what will happen.
 * @param {number} duty
 */
function describeCommand(duty) {
  if (duty < minRunningPercent()) {
    return "Stopped — both enables LOW.";
  }
  if (mode.val === "fun") {
    return (
      `The throttle is commanding ${formatDuty(duty)} %. It never goes below ${minRunningPercent()} %, so the fan ` +
      "runs until you leave the mode — and it leaves by itself the moment the bike can move."
    );
  }
  return mode.val === "automatic"
    ? `The curve is commanding ${formatDuty(duty)} %.`
    : `Running at ${formatDuty(duty)} %.`;
}

/** Whether a command could be sent at all. The Pi enforces every part of this again. */
function commandable() {
  const current = status.val;
  return current !== null && current.fault === null;
}

/** The duties this slider may select, from the Pi's own floor and cap. */
function stops() {
  return dutyStops(minRunningPercent(), maxPercent());
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
 * Adopts a reply as the truth, including the mode and — in automatic — the thumb.
 * @param {FanReply} payload
 */
function adoptReply(payload) {
  status.val = payload;
  mode.val = payload.mode;
  // The thumb follows a cap that came down, and follows whatever is driving the fan
  // while it is not the thumb. The slider's `max` alone would clamp what the element
  // SHOWS while this state kept the old number, and that number is what the next command
  // carries.
  if (payload.mode !== "manual" || pendingDuty.val > maxPercent()) {
    pendingDuty.val = Math.min(payload.targetPercent, maxPercent());
  }
}

// --- The wire ----------------------------------------------------------------
//
// The pacing itself is ../lib/fan-command-queue.js — one command in flight, one waiting,
// at most one per 150 ms — so all that is left here is what a command DOES: the POST, and
// what to believe of the reply it comes back with.

/**
 * What each mode is called in `/fan`'s query string. `Record<FanMode, string>` so a mode
 * added to the server without a spelling here does not typecheck.
 * @type {Record<FanMode, string>}
 */
const MODE_QUERY = { automatic: "auto", manual: "manual", fun: "fun" };

/**
 * @param {FanCommand} command
 * @param {() => boolean} isSuperseded whether the thumb has already moved past this one
 * @returns {Promise<void>}
 */
async function postFanCommand(command, isSuperseded) {
  const query = "duty" in command ? `duty=${command.duty}` : `mode=${MODE_QUERY[command.mode]}`;
  try {
    const response = await fetch(`/fan?${query}`, {
      method: "POST",
      cache: "no-store",
      // Not decoration: a custom header is what makes this NOT a simple request, so a
      // cross-origin form cannot reach the endpoint. See src/http/fan.ts.
      headers: { "X-Cool-Eva": "fan" },
    });
    const payload = /** @type {FanReply} */ (await response.json());
    message.val = payload.message ?? "";
    lastCommandOk.val = response.ok;
    // ⚠️ Only when nothing newer is waiting. A reply describes the state as of ITS
    // command, so adopting it over a value the thumb has already moved past would drag
    // the slider backwards mid-drag — the exact jitter this whole section exists to avoid.
    if (isSuperseded()) {
      status.val = payload;
    } else {
      adoptReply(payload);
    }
  } catch (error) {
    // ⚠️ A request that did not come back may still have reached the Pi — the sysfs write
    // happens before the response — so this is NOT "nothing happened". Say so, and let
    // the live signals above be the thing that settles it.
    message.val =
      `Could not reach the Pi — ${error instanceof Error ? error.message : String(error)}. ` +
      "This does NOT guarantee the fan was left alone — watch the line above.";
    lastCommandOk.val = false;
    console.warn("fan: command failed", error);
  }
}

const commandQueue = createFanCommandQueue({
  send: postFanCommand,
  onSettlingChange: pending => {
    settling.val = pending;
  },
});
