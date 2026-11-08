// @ts-check
// Queue, slider and reply-ordering constraints: docs/fan-dashboard.md.
import van from "../vendor/van-1.6.1.js";
import { valueOf } from "./store.js";
import { readingStatus, freshValue } from "./reading-status.js";
import { FAN_MODE_CODE, TEMPERATURE_FAULT_REASON, dutyStops, fanDriveState } from "./fan-display.js";
import { createFanCommandQueue } from "./fan-command-queue.js";
import { request } from "./transport.js";

/** @typedef {import("../../src/http/fan.ts").FanReply} FanReply */
/** @typedef {import("../../src/fan/auto.ts").FanMode} FanMode */
/** @typedef {import("./fan-command-queue.js").FanCommand} FanCommand */
const reply = van.state(/** @type {FanReply|null} */ (null));
const mode = van.state(/** @type {FanMode} */ ("automatic"));
const pendingDuty = van.state(0);
const settling = van.state(false);
const commandFailed = van.state(false);

export async function refreshFanStatus() {
  try {
    const response = await request("/fan", { cache: "no-store" });
    if (!response.ok) {
      reply.val = null;
      console.log(`fan: status unavailable (${response.status})`);
      return;
    }
    const payload = /** @type {FanReply} */ (await response.json());
    reply.val = payload;
    if (!settling.rawVal) {
      commandFailed.val = false;
      adoptReply(payload);
    }
  } catch (error) {
    console.warn("fan: status fetch failed", error);
    reply.val = null;
  }
}

export function currentFanMode() {
  return mode.val;
}
export function selectedFanDuty() {
  return pendingDuty.val;
}
export function fanDutyStops() {
  return dutyStops(reply.val?.limits.minRunningPercent ?? 0, reply.val?.limits.maxPercent ?? 0);
}
export function fanCommandable() {
  return reply.val !== null && reply.val.fault === null;
}

/** @param {"automatic"|"manual"} next */
export function selectFanMode(next) {
  if (!fanCommandable() || next === mode.rawVal) return;
  mode.val = next;
  commandQueue.queue({ mode: next });
}
/** @param {number} index */
export function selectFanDuty(index) {
  if (!fanCommandable()) return;
  const duty = fanDutyStops()[index];
  if (duty === undefined) return;
  pendingDuty.val = duty;
  mode.val = "manual";
  commandQueue.queue({ duty });
}

export function fanStatusText() {
  const signals = ["fan_auto_mode", "fan_driver_enabled", "fan_duty_pct", "fan_target_pct"];
  if (reply.val?.fault || signals.some(key => readingStatus(key) === "fault")) return "Fan status fault";
  if (signals.some(key => readingStatus(key) !== "fresh") || commandFailed.val) return "Fan status unavailable";
  const state = fanDriveState(valueOf("fan_duty_pct"), valueOf("fan_target_pct"), valueOf("fan_driver_enabled"));
  if (state === "braking") return "Braking fault · cut fan power";
  if (state === "stop-failed") return "Stop failed · still driving";
  if (state === "unreported") return "Fan status unavailable";
  if (mode.val === "automatic" && valueOf("fan_auto_reason") === TEMPERATURE_FAULT_REASON) return "Fan status fault";
  const name = mode.val === "automatic" ? "Automatic" : mode.val === "fun" ? "Fun" : "Manual";
  if (state === "standby") return `${name} · Standby`;
  if (state === "kick-start") return `${name} · kick-starting`;
  return mode.val === "automatic" ? "Automatic control" : mode.val === "manual" ? "Manual control" : "Fun · driving";
}

/** @param {FanReply} payload */
function adoptReply(payload) {
  reply.val = payload;
  mode.val = payload.mode;
  pendingDuty.val = Math.min(payload.targetPercent, payload.limits.maxPercent);
}

/** @type {Record<FanMode,string>} */
const MODE_QUERY = { automatic: "auto", manual: "manual", fun: "fun" };
/** @param {FanCommand} command @param {()=>boolean} isSuperseded */
async function postFanCommand(command, isSuperseded) {
  const query = "duty" in command ? `duty=${command.duty}` : `mode=${MODE_QUERY[command.mode]}`;
  try {
    const response = await request(`/fan?${query}`, {
      method: "POST",
      cache: "no-store",
      headers: { "X-Cool-Eva": "fan" },
    });
    const payload = /** @type {FanReply} */ (await response.json());
    commandFailed.val = !response.ok;
    if (!response.ok) {
      console.warn(`fan: ${query} refused`, payload.message);
    }
    if (isSuperseded()) {
      reply.val = payload;
    } else {
      adoptReply(payload);
    }
  } catch (error) {
    commandFailed.val = true;
    console.warn(`fan: ${query} failed; delivery is unknown`, error);
  }
}

const commandQueue = createFanCommandQueue({
  send: postFanCommand,
  onSettlingChange: pending => {
    settling.val = pending;
  },
});

van.derive(() => {
  const live = freshValue("fan_auto_mode");
  if (live === null || settling.val) return;
  mode.val = live === FAN_MODE_CODE.AUTOMATIC ? "automatic" : live === FAN_MODE_CODE.FUN ? "fun" : "manual";
});
van.derive(() => {
  const target = freshValue("fan_target_pct");
  if (target === null || mode.val === "manual" || settling.val) return;
  pendingDuty.val = target;
});
