// @ts-check
// Frame, stop causes and expected Pi power loss: docs/psu-hold.md.
import van from "../vendor/van-1.6.1.js";
import { OwnerActionRow } from "./owner-action.js";
import { arm, armed, armDwellElapsed, refuseKeyRepeat } from "../lib/arming.js";
import { connection } from "../lib/store.js";
import { freshValue, readingStatus, statusWord } from "../lib/reading-status.js";
import { psuHoldState, psuHoldBusy, psuHoldMessage, psuRemainingMs, performPsuHold } from "../lib/psu-hold.js";

const { button, div, span } = van.tags;
export const PSU_ACTIONS = [
  { action: /** @type {const} */ ("start"), key: "psu-hold:start", label: "On" },
  { action: /** @type {const} */ ("stop"), key: "psu-hold:stop", label: "Off" },
  { action: /** @type {const} */ ("extend"), key: "psu-hold:extend", label: "Extend" },
];

export function PsuHoldCard() {
  return div(
    { class: "settings-card", id: "psu-hold" },
    () =>
      psuHoldState.val?.on
        ? OwnerActionRow("Keep PSU on", ActionButton(PSU_ACTIONS[1]), () =>
            armed.val === PSU_ACTIONS[1].key ? "Confirm off" : "Off"
          )
        : OwnerActionRow("Keep PSU on", ActionButton(PSU_ACTIONS[0]), () =>
            armed.val === PSU_ACTIONS[0].key ? "Confirm on" : "On"
          ),
    div({ class: "settings-note", "data-psu-status": "" }, holdDescription),
    div(
      { class: "settings-row psu-rails" },
      Rail("Main rail · 12 V", "psu_12v_mv"),
      Rail("Standby · 9 V", "psu_12v_lowpower_mv")
    ),
    div({ class: "action-note" }, "Sends 0x500 every 150 ms; off after 60 min. The Pi loses power when 12 V drops."),
    () =>
      psuHoldState.val?.on
        ? OwnerActionRow("Another 60 minutes", ActionButton(PSU_ACTIONS[2]), () =>
            armed.val === PSU_ACTIONS[2].key ? "Confirm extend" : "Extend"
          )
        : div(),
    div({ class: "action-note", "data-psu-result": "", role: "status" }, () => psuHoldMessage.val)
  );
}

/** @param {typeof PSU_ACTIONS[number]} entry */
function ActionButton(entry) {
  const { action, key } = entry;
  return button(
    {
      "data-psu-action": action,
      disabled: () => {
        const state = psuHoldState.val;
        return psuHoldBusy.val || connection.val !== "live" || !state || (action !== "stop" && !!state.refusal);
      },
      onkeydown: refuseKeyRepeat,
      onclick: () => {
        if (armed.val !== key) {
          arm(key);
          return;
        }
        if (!armDwellElapsed()) {
          return;
        }
        armed.val = "";
        void performPsuHold(action);
      },
    },
    () =>
      armed.val === key
        ? action === "stop"
          ? "Tap again — stop requests; 12 V and the Pi may turn off"
          : action === "extend"
            ? "Tap again — restart the 60 minute limit"
            : "Tap again — repeat PSU requests for up to 60 minutes"
        : action === "stop"
          ? "Stop sending PSU requests"
          : action === "extend"
            ? "Explicitly renew the time limit"
            : "Start repeating PSU requests"
  );
}

function holdDescription() {
  const state = psuHoldState.val;
  const remaining = psuRemainingMs();
  if (!state) return "Hold status unavailable";
  if (connection.val !== "live") return state.on ? "Last reported on · status unavailable" : "Hold status unavailable";
  if (state.on) {
    const seconds = Math.ceil((remaining ?? 0) / 1000);
    return seconds === 0
      ? "Auto-off due · waiting for the Pi"
      : `Requests active · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} left`;
  }
  return state.lastStopReason
    ? `Off · ${stopWords(state.lastStopReason)}`
    : (state.refusal ?? "Off · not retained after a restart");
}

/** @param {string} title @param {string} key */
function Rail(title, key) {
  return div(
    div(title),
    div({ class: "psu-rail-value", "data-psu-rail": key }, () => {
      const value = freshValue(key);
      return value === null ? statusWord(readingStatus(key), "unavailable") : `${(value / 1000).toFixed(2)} V`;
    })
  );
}

/** @param {import("../../src/psu/hold.ts").PsuStopReason} reason */
function stopWords(reason) {
  return {
    owner: "stopped by owner",
    timeout: "60 minute limit reached",
    "service-shutdown": "service stopping",
    "can-down": "CAN unavailable",
    "bus-off": "CAN bus-off",
    "tx-errors": "repeated TX failures",
    "bus-lease": "another bus operation started",
    permission: "write permission unavailable",
    "setup-failed": "CAN setup failed",
  }[reason];
}
